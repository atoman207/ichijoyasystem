/**
 * 予定表 (スプレッドシート) → 新システムの予定表への移行 (src/lib/schedule-sheet/・お客様のご要望 2026-11-23) のテスト
 *   node scripts/tests/schedule/sheet-import.test.mjs   (npm run test:schedule)
 * 1. 日別のシートの読み取り (店舗の欄のハギ・シキ・製造の表・右上の人の予定・事務の欄・毎日の決まった書き込み・時刻)
 * 2. 照合 (既存の顧客・地区・候補が複数・新しい顧客・進行中の案件・登録済みの予定・以前の移行の予定の使い回しと削除)
 * 3. 画面の操作 (読み込み → 担当者の名前の対応 (光子 → 社員) → 取込)・取り込み直し (変更なし・新システムで変えた予定は残す)
 * 4. 受注にしたときに、取り込んだ同じ案件の引き取り・納品の予定を使い回す (二重にしない)
 * データは一時フォルダーの JSON (サンプルデータ)。.xlsx は SheetJS で作る (お客様の資料は使わない)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-sheet-import-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "sheet-import-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-sheet-import",
  CRON_SECRET: "test-cron-secret-0123456789",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_)/.test(k)) delete process.env[k];
process.chdir(work);
const stubs = path.join(root, "scripts/tests/ops-reports/stubs");
const jiti = createJiti(import.meta.url, {
  alias: {
    "next/navigation": path.join(stubs, "next-navigation.cjs"),
    "next/cache": path.join(stubs, "next-cache.cjs"),
    "@/lib/auth/session": path.join(stubs, "session.cjs"),
    "@": path.join(root, "src"),
    "server-only": path.join(root, "scripts/tests/maps/empty.cjs"),
  },
  moduleCache: true,
});
const imp = (p) => jiti.import(path.join(root, "src", p));

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    fails.push(msg);
    console.log("  ✗", msg);
  }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b) ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (t) => console.log(`\n■ ${t}`);

const P = await imp("lib/schedule-sheet/parse.ts");
const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const admin = db().users.find((u) => u.active && u.role === "admin");
const hqStaff = db().users.find((u) => u.active && u.role === "hq_staff");
const koshiStaff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");
const surname = (u) => u.name.split(/\s+/)[0];
const stores = db().stores.map((s) => ({ id: s.id, name: s.name, shortName: s.shortName }));
const koshiName = db().stores.find((s) => s.id === "koshi").name;
const chuoName = db().stores.find((s) => s.id === "chuo").name;

/* ---------------- 日別のシート (スプレッド原紙と同じ並び) ---------------- */
const COL = (letters) => letters.split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function sheet(day, opts = {}) {
  const rows = [];
  const set = (r, col, v) => {
    rows[r] ??= [];
    rows[r][COL(col)] = String(v);
  };
  set(0, "X", "光子");
  set(1, "B", "店舗来店で受注があった場合(イベント含）の決まり");
  set(1, "X", "AM");
  set(1, "AA", "PM");
  if (day === 1) {
    set(2, "X", "ズーム　8：00～");
    set(3, "X", "13時(高平)大西 建具採寸");
    set(4, "X", "（八景水谷）藤田邸　大工工事　現場確認");
    set(2, "AA", "（須屋）大岩様　近所　挨拶");
  }
  set(6, "A", "総数");
  set(6, "X", "本日製造枚数");
  set(6, "AA", "目標人時");
  // 合志店
  set(9, "A", "2");
  set(9, "B", koshiName);
  set(9, "X", koshiName);
  set(10, "A", "人");
  set(10, "B", "ハギ");
  set(10, "M", "シキ");
  set(11, "B", "現場名");
  set(11, "C", "畳");
  set(11, "X", "現場名");
  set(12, "C", "表");
  set(12, "D", "新");
  set(13, "A", "AM");
  if (day === 1) {
    set(13, "B", "社長　3450　オイル交換");
    set(13, "X", "(須屋)大岩");
    set(13, "Y", "裏");
    set(13, "Z", "6.0");
    set(13, "AB", "麻の葉橙");
    set(13, "AC", "61.0");
    set(14, "B", "(須屋)大岩");
    set(14, "C", "6.0");
    set(14, "E", "2.0");
    set(14, "K", "8:30〜9:30");
    set(14, "L", surname(koshiStaff));
    set(15, "B", "（植木町）早川　現見");
    set(15, "G", "8.0");
    set(15, "K", "AM");
    set(16, "B", "(幾久富)新規田");
    set(16, "D", "4.0");
    set(16, "K", "10時");
    set(17, "X", "(幾久富)新規田");
    set(17, "Y", "新");
    set(17, "Z", "4.0");
    set(17, "AB", "無し");
  }
  set(16, "B", day === 1 ? "(幾久富)新規田" : "");
  set(20, "B", "繰り越し");
  set(20, "E", "4");
  set(21, "A", "PM");
  if (day === 1) {
    set(21, "M", "(須屋)大岩");
    set(21, "N", "6");
    set(21, "V", "PM　現金");
    set(22, "M", "(高平)大西");
    set(22, "V", "3~5");
  }
  set(23, "B", "毎日の日報確認");
  set(30, "A", "上限");
  set(30, "B", "22");
  // 中央店
  set(35, "A", "2");
  set(35, "B", chuoName);
  set(36, "A", "AM");
  if (day === 1) {
    set(36, "B", "(渡鹿)山口　現見");
    set(36, "G", "8");
    set(36, "K", "1~1:30");
  }
  if (day === 2) set(36, "B", "(渡鹿)山口");
  if (day === 2) set(36, "C", "3");
  set(40, "A", "上限");
  // 事務
  set(45, "B", "事務");
  set(46, "B", surname(hqStaff));
  set(46, "M", "丸木");
  set(47, "A", "AM");
  if (day === 1) {
    set(47, "B", "インセンティブ準備");
    set(47, "K", "現金支給分");
  }
  set(48, "B", "集金準備（本日分）");
  if (opts.extra) opts.extra(set);
  return { name: String(day), rows: Array.from({ length: rows.length }, (_, i) => Array.from({ length: (rows[i] ?? []).length }, (_, j) => rows[i]?.[j] ?? "")) };
}

/* ================================================================== */
section("1. 日別のシートの読み取り");
const Y = new Date().getFullYear() + 1;
const D = (d) => `${Y}-01-${String(d).padStart(2, "0")}`;
const sheets = Array.from({ length: 10 }, (_, i) => sheet(i + 1));
const month = P.parseMonth(sheets, { label: `${Y}.1`, year: Y, month: 1, stores });
eq([month.days.length, month.persons.sort().join("・")], [10, ["光子", surname(hqStaff), "丸木"].sort().join("・")], "10 日分・右上の人 (光子) と事務の欄の人");
const day1 = month.events.filter((e) => e.date === D(1));
const find = (raw, side) => day1.find((e) => e.raw === P.nk(raw) && (!side || e.side === side));
const oiwa = find("(須屋)大岩", "hagi");
eq([oiwa?.kind, oiwa?.area, oiwa?.name, oiwa?.countText, oiwa?.startTime, oiwa?.endTime, oiwa?.storeId], ["pickup", "須屋", "大岩", "畳 表替え6 / 襖 張替2", "08:30", "09:30", "koshi"], "ハギ: 引き取り・地区・名前・枚数・時刻・店舗");
eq(oiwa?.production, ["製造: 裏 6枚 / 縁 麻の葉橙 / サイズ 61"], "工場の製造の表を同じ現場名の引き取りに付ける (61.0 → 61・項目の名前つき)");
eq([find("(須屋)大岩", "shiki")?.kind, find("(須屋)大岩", "shiki")?.slot], ["delivery", "pm"], "シキ: 午後の納品");
eq([find("（植木町）早川　現見")?.kind, find("（植木町）早川　現見")?.name, find("（植木町）早川　現見")?.countText], ["survey", "早川", "障子 張替8"], "「現見」は枚数があっても現地調査 (見積の数量は仕事内容に)");
const newbie = find("(幾久富)新規田", "hagi");
eq([newbie?.countText, newbie?.herinashi, newbie?.startTime], ["畳 新調4", 4, "10:00"], "製造の表のヘリ「無し」= へり無し畳の枚数・「10時」");
eq([find("(高平)大西", "shiki")?.kind, find("(高平)大西", "shiki")?.startTime], ["delivery", "15:00"], "枚数のないシキは納品・午後の「3~5」は 15:00");
const memo = find("社長　3450　オイル交換");
eq([memo?.side, memo?.kind, memo?.customerLike], ["memo", "other", false], "お客様以外の書き込みは社内の予定 (その他)");
const zoom = day1.find((e) => e.side === "person" && /ズーム/.test(e.raw));
eq([zoom?.kind, zoom?.startTime, zoom?.person], ["meeting", "08:00", "光子"], "右上の人の予定: ズーム 8:00 (会議)");
const saiSun = day1.find((e) => e.side === "person" && /採寸/.test(e.raw));
eq([saiSun?.kind, saiSun?.area, saiSun?.name, saiSun?.startTime, saiSun?.slot], ["measure", "高平", "大西", "13:00", "pm"], "「13時(高平)大西 建具採寸」: 時刻のあとの地区と名前・採寸");
const genba = day1.find((e) => e.side === "person" && /大工工事/.test(e.raw));
eq([genba?.kind, genba?.area, genba?.name], ["site", "八景水谷", "藤田"], "「（八景水谷）藤田邸 大工工事 現場確認」は現場管理 (お客様の現場の工事の確認)");
const aisatsu = day1.find((e) => e.side === "person" && /挨拶/.test(e.raw));
eq([aisatsu?.kind, aisatsu?.name, aisatsu?.slot], ["visit", "大岩", "pm"], "「（須屋）大岩様 近所 挨拶」(午後の欄) は顧客訪問");
eq(day1.filter((e) => e.side === "office").map((e) => [e.raw, e.person, e.remark]), [["インセンティブ準備", surname(hqStaff), "現金支給分"]], "事務の欄: その人の予定 (集金準備は省く)");
ok(!month.events.some((e) => /日報確認/.test(e.raw)) && month.templates.includes("毎日の日報確認"), "毎日ある同じ書き込み (毎日の日報確認) は決まった書き込みとして省く");
ok(!month.events.some((e) => /繰り越し|上限|現場名|総数/.test(e.raw)), "繰り越し・上限・見出しは予定にしない");
eq(P.monthOfLabel("2026.12"), { year: 2026, month: 12 }, "ファイル名「2026.12」→ 年・月");
eq(P.monthOfLabel("2027年1月の予定"), { year: 2027, month: 1 }, "「2027年1月」");
eq(P.parseTime("8：30～9", "am"), { startTime: "08:30", endTime: "09:00" }, "時刻「8：30～9」");
eq(P.parseTime("4時以降", "pm"), { startTime: "16:00", endTime: "17:00" }, "午後の「4時以降」は 16:00");

/* ================================================================== */
section("2. 照合 (顧客・案件・登録済みの予定・以前の移行)");
const now = new Date().toISOString();
await store.mutate((d) => {
  d.customers.push(
    { id: "cust_oiwa", code: "C-90001", name: "大岩", kana: "", type: "individual", phone: "", postalCode: "", address: "須屋", area: "須屋", storeId: "koshi", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now },
    { id: "cust_yama", code: "C-90002", name: "山口 太郎", kana: "", type: "individual", phone: "096-000-0000", postalCode: "", address: "熊本市中央区渡鹿4丁目8", storeId: "chuo", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now },
    { id: "cust_haya1", code: "C-90003", name: "早川 一郎", kana: "", type: "individual", phone: "", postalCode: "", address: "熊本市北区植木町岩野1", storeId: "koshi", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now },
    { id: "cust_haya2", code: "C-90004", name: "早川 二郎", kana: "", type: "individual", phone: "", postalCode: "", address: "熊本市北区植木町鐙田2", storeId: "koshi", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now },
  );
  d.orders.push({ id: "o_yama", number: "O-SH-1", customerId: "cust_yama", storeId: "chuo", title: "襖張替え", category: "fusuma", contractDate: D(1), total: 33000, status: "scheduled", workerIds: [], siteAddress: "", progressNotes: [], createdBy: admin.id, createdAt: now, updatedAt: now });
  d.schedule.push(
    // 以前の移行 (11/11 のファイル) の予定: 同じ予定 → 使い回し / なくなった予定 → 消す / 新システムで変えた予定 → 残す / 取り込む日より前 → 触らない
    { id: "ev_legacy_oiwa", title: "(須屋) 大岩 引き取り", kind: "pickup", date: D(1), startTime: "09:00", endTime: "10:00", storeId: "koshi", assigneeIds: [], source: "import", sourceRef: `06_予定表（6月分）/${Y}.1.xlsx#1!15`, memo: "畳 表替え6", createdAt: now },
    { id: "ev_legacy_gone", title: "(須屋) 取消 引き取り", kind: "pickup", date: D(2), slot: "am", storeId: "koshi", assigneeIds: [], source: "import", sourceRef: `06_予定表（6月分）/${Y}.1.xlsx#2!15`, createdAt: now },
    { id: "ev_legacy_edit", title: "(須屋) 変更済 納品", kind: "delivery", date: D(3), slot: "pm", storeId: "koshi", assigneeIds: [koshiStaff.id], source: "import", sourceRef: `06_予定表（6月分）/${Y}.1.xlsx#3!25`, createdAt: now, updatedBy: koshiStaff.id, updatedAt: now },
    { id: "ev_old_before", title: "(須屋) 昨日 引き取り", kind: "pickup", date: `${Y - 1}-12-31`, storeId: "koshi", assigneeIds: [], source: "import", sourceRef: `06_予定表（6月分）/${Y - 1}.12.xlsx#31!15`, createdAt: now },
    // 新システムに登録済みの同じ予定 (中央店の山口様の現地調査)
    { id: "ev_sys_yama", title: "山口 太郎 様 現地調査", kind: "survey", date: D(1), startTime: "13:00", endTime: "13:30", storeId: "chuo", assigneeIds: [], customerId: "cust_yama", source: "manual", createdBy: admin.id, createdAt: now },
  );
});
const PL = await imp("lib/schedule-sheet/plan.ts");
let plan = PL.planSheetImport(db(), [month], { from: D(1) });
const item = (raw, side) => plan.items.find((i) => i.ev.date === D(1) && i.ev.raw === P.nk(raw) && (!side || i.ev.side === side));
const grp = (k) => plan.groups.find((g) => g.gkey === k);
eq([item("(須屋)大岩", "hagi").status, item("(須屋)大岩", "hagi").eventId], ["update", "ev_legacy_oiwa"], "以前の移行の同じ予定は ID を使い回して書き換える");
eq(item("(須屋)大岩", "hagi").assigneeIds, [koshiStaff.id], "「時間・担当」の欄の姓 → 社員");
eq([grp("須屋|大岩").auto, grp("須屋|大岩").ambiguous, grp("須屋|大岩").eventKeys.length], ["cust_oiwa", false, 3], "既存の顧客 (姓 + 地区) にひも付け (引き取り・納品・右上の挨拶の 3 件を 1 人に)");
eq([grp("渡鹿|山口").auto, grp("渡鹿|山口").caseRef?.kind, grp("渡鹿|山口").caseRef?.id], ["cust_yama", "order", "o_yama"], "住所に地区のある既存の顧客 (山口 太郎) と進行中の受注にひも付け");
eq([item("(渡鹿)山口　現見").status, item("(渡鹿)山口　現見").dupOf?.id], ["duplicate", "ev_sys_yama"], "新システムに登録済みの同じ予定 (同じ日・現地調査・山口) は取り込まない");
ok(grp("植木|早川").ambiguous && grp("植木|早川").candidates.length === 2, "同じ地区に同じ姓が 2 人 → 要確認 (候補を選べる)");
eq([grp("幾久富|新規田").auto, grp("幾久富|新規田").storeId], ["new", "koshi"], "見つからないお客様は新しい顧客");
eq(grp("高平|大西").eventKeys.length, 2, "右上の予定の「(高平)大西 建具採寸」とシキの「(高平)大西」は同じお客様");
eq(plan.remove.map((r) => r.id), ["ev_legacy_gone"], "スプレッドシートにない以前の移行の予定を消す");
eq(plan.keep.map((r) => r.id), ["ev_legacy_edit"], "新システムで変えた予定はスプレッドシートになくても残す");
ok(!plan.remove.some((r) => r.id === "ev_old_before"), "取り込む日より前の予定は触らない");
eq(plan.persons.find((p) => p.name === "光子")?.userId, undefined, "光子はまだ社員に決まっていない (対応表で決める)");
ok(plan.items.filter((i) => i.ev.person === "光子").every((i) => i.assigneeIds.length === 0 && i.storeId === "hq"), "対応がないあいだは担当なし");

/* ================================================================== */
section("3. 画面の操作: 読み込み → 担当者の名前の対応 → 取込");
async function act(user, fn) {
  globalThis.__testUser = user;
  try {
    const v = await fn();
    return { value: v, msg: null, err: null };
  } catch (e) {
    if (e && typeof e.digest === "string" && e.digest.startsWith("NEXT_REDIRECT")) {
      const u = new URL(e.url, "http://test.local");
      return { path: u.pathname, search: u.search, msg: u.searchParams.get("msg"), err: u.searchParams.get("err") };
    }
    throw e;
  } finally {
    globalThis.__testUser = undefined;
  }
}
const form = (obj) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, String(x));
    else if (v !== undefined && v !== null) fd.set(k, String(v));
  }
  return fd;
};
// .xlsx を作る (日別のシート 1〜10)
const wb = XLSX.utils.book_new();
for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name);
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["メモ"]]), "メモ");
const xlsx = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
const route = await imp("app/api/schedule/sheet-import/route.ts");
const upload = async (user, name, bytes, batch) => {
  globalThis.__testUser = user;
  try {
    const fd = new FormData();
    fd.set("file", new File([bytes], name));
    if (batch) fd.set("batch", batch);
    const res = await route.POST(new Request("http://test.local/api/schedule/sheet-import", { method: "POST", body: fd }));
    return { status: res.status, json: await res.json() };
  } finally {
    globalThis.__testUser = undefined;
  }
};
let up = await upload(koshiStaff, `${Y}.1.xlsx`, xlsx);
eq(up.status, 403, "店舗スタッフは読み込めない (本部スタッフ・管理者)");
up = await upload(admin, "予定.xlsx", xlsx);
ok(up.status === 422 && /年・月/.test(up.json.error), "ファイル名に年・月がなければ断る");
up = await upload(admin, `${Y}.1.xlsx`, xlsx);
ok(up.status === 200 && /^[0-9a-f]{16}$/.test(up.json.batch) && up.json.days === 10, `読み込み: ${up.json.label} ${up.json.days} 日・${up.json.events} 件`);
const batch = up.json.batch;
const B = await imp("lib/schedule-sheet/batch.ts");
eq((await B.readBatchMonths(batch)).months.map((m) => m.label), [`${Y}.1`], "読み込んだ月をディスクに保存 (まだ取り込まない)");
// 同じ取込に 2 つ目の月を足す・同じ月をもう一度 (置き換え)
const wb2 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(sheet(3).rows), "3");
up = await upload(admin, `${Y}.2.xlsx`, XLSX.write(wb2, { type: "buffer", bookType: "xlsx" }), batch);
eq([up.status, up.json.batch], [200, batch], "2 つ目の月のファイルを同じ取込に足す");
up = await upload(admin, `${Y}.1.xlsx`, xlsx, batch);
eq([up.status, (await B.readBatchMonths(batch)).months.map((m) => m.label)], [200, [`${Y}.1`, `${Y}.2`]], "同じ月をもう一度読み込むと置き換え (2 か月分)");
await act(admin, async () => (await imp("lib/actions/schedule-sheet.ts")).removeScheduleSheetMonth(form({ batch, month: `${Y}-02` })));
eq((await B.readBatchMonths(batch)).months.map((m) => m.label), [`${Y}.1`], "月を外す");

const SA = await imp("lib/actions/schedule-sheet.ts");
let r = await act(admin, () => SA.saveScheduleSheetAliases(form({ batch, from: D(1), "alias:光子": admin.id, "alias:丸木": "-" })));
ok(r.msg?.includes("保存しました") && PL.sheetSettings(db()).aliases["光子"] === admin.id, "担当者の名前の対応: 光子 → 社員 (管理者) を保存");
plan = PL.planSheetImport(db(), [month], { from: D(1) });
ok(plan.items.filter((i) => i.ev.person === "光子").every((i) => i.assigneeIds[0] === admin.id && i.storeId === admin.storeId), "光子の予定は対応した社員の予定 (その社員の店舗)");

r = await act(admin, () => SA.applyScheduleSheet(form({ batch, from: D(1) })));
ok(r.err?.includes("確かめました"), "「内容を確かめました」のチェックがなければ取り込まない");
r = await act(admin, () => SA.applyScheduleSheet(form({ batch, from: `${Y - 2}-01-01`, confirm: "1" })));
ok(r.err?.includes("過ぎた日"), "過ぎた日からは取り込まない");
const before = { customers: db().customers.length, inquiries: db().inquiries.length };
r = await act(admin, () => SA.applyScheduleSheet(form({ batch, from: D(1), confirm: "1", "pick:植木|早川": "cust_haya2" })));
ok(!r.err && r.msg?.includes("取り込みました"), `取込: ${r.msg ?? r.err}`);
const evs = () => db().schedule.filter((e) => e.date >= D(1) && e.date <= D(10));
const ev = (fn) => evs().find(fn);
const oiwaEv = db().schedule.find((e) => e.id === "ev_legacy_oiwa");
eq([oiwaEv.customerId, oiwaEv.sourceRef.startsWith("sheet:"), oiwaEv.startTime, oiwaEv.memo.split("\n")[0], oiwaEv.assigneeIds], ["cust_oiwa", true, "08:30", "畳 表替え6 / 襖 張替2", [koshiStaff.id]], "大岩様の引き取り: 同じ ID のまま時刻・枚数・担当・顧客を書き換え");
const oiwaInq = db().inquiries.find((q) => q.id === oiwaEv.inquiryId);
eq([oiwaInq?.customerId, oiwaInq?.status, oiwaInq?.source, oiwaInq?.category], ["cust_oiwa", "in_progress", "import", "tatami"], "案件のなかった既存の顧客には新しい案件 (問い合わせ・予定表から移行) を登録してつなぐ");
const delivery = ev((e) => e.kind === "delivery" && e.title === "(須屋) 大岩 納品");
eq([delivery?.inquiryId, delivery?.customerId, delivery?.slot], [oiwaEv.inquiryId, "cust_oiwa", "pm"], "同じお客様の納品も同じ案件に");
const aisatsuEv = ev((e) => /挨拶/.test(e.title));
eq([aisatsuEv?.assigneeIds, aisatsuEv?.customerId, aisatsuEv?.kind], [[admin.id], "cust_oiwa", "visit"], "光子の「大岩様 近所 挨拶」→ 社員 (管理者) の顧客訪問・大岩様にひも付け");
const newCust = db().customers.find((c) => c.name === "新規田");
eq([newCust?.area, newCust?.storeId, newCust?.tags, newCust?.phone], ["幾久富", "koshi", ["予定表から登録"], ""], "新しい顧客: 地区・店舗・印 (電話番号は未登録)");
const newEv = ev((e) => e.customerId === newCust?.id && e.kind === "pickup");
ok(newEv && newEv.memo.includes("縁無4") && newEv.memo.startsWith("畳 新調4") && newEv.startTime === "10:00", "新しい顧客の引き取り: 枚数・へり無し (縁無4)・時刻");
eq(ev((e) => /早川/.test(e.title))?.customerId, "cust_haya2", "要確認の早川様: 画面で選んだ顧客 (二郎) にひも付け");
eq([ev((e) => e.id === "ev_sys_yama")?.title, evs().filter((e) => /山口/.test(e.title) && e.date === D(1)).length], ["山口 太郎 様 現地調査", 1], "登録済みの山口様の現地調査は二重にしない");
const yamaDay2 = ev((e) => /山口/.test(e.title) && e.date === D(2));
eq([yamaDay2?.orderId, yamaDay2?.customerId], ["o_yama", "cust_yama"], "山口様の 2 日目の引き取りは進行中の受注にひも付け");
ok(!db().schedule.some((e) => e.id === "ev_legacy_gone") && db().auditLogs.some((a) => a.action === "delete" && a.entityId === "ev_legacy_gone"), "なくなった予定を消し、変更履歴に残す (試験期間の引き継ぎも同じ扱い)");
ok(db().schedule.some((e) => e.id === "ev_legacy_edit") && db().schedule.some((e) => e.id === "ev_old_before"), "新システムで変えた予定・取り込む日より前の予定は残す");
eq([db().customers.length - before.customers, db().inquiries.length - before.inquiries], [3, 5], "新しい顧客 3 人 (新規田・大西・藤田)・新しい案件 5 件 (大岩・早川・新規田・大西・藤田)");
eq(ev((e) => /大工工事/.test(e.title))?.kind, "site", "現場管理の予定として取り込む");
const memoEv = ev((e) => e.title === "社長 3450 オイル交換");
eq([memoEv?.kind, memoEv?.storeId, memoEv?.customerId], ["other", "koshi", undefined], "お客様以外の書き込みは店舗の「その他」の予定 (顧客なし)");
const office = ev((e) => e.title === "インセンティブ準備");
eq([office?.assigneeIds, office?.storeId], [[hqStaff.id], hqStaff.storeId], "事務の欄: その人の予定");
ok(!evs().some((e) => /丸木/.test(e.memo ?? "") && e.assigneeIds.length), "「担当にしない」にした名前は担当にしない");
const settings = PL.sheetSettings(db());
ok(settings.lastImport?.summary.includes("追加") && Object.keys(settings.written).length > 5, "取込の記録と、書いた予定の印を残す");
ok(db().auditLogs.some((a) => a.action === "import" && a.entity === "schedule"), "変更履歴に取込の記録");
ok(!(await B.readBatchIndex(batch)), "取り込んだら読み込んだ内容を消す");

section("3b. 取り込み直し");
plan = PL.planSheetImport(db(), [month], { from: D(1) });
eq([plan.counts.add, plan.counts.update, plan.counts.remove, plan.counts.newCustomers, plan.counts.newCases], [0, 0, 0, 0, 0], "同じファイルをもう一度: 追加・書き換え・削除・新しい顧客・新しい案件なし");
ok(plan.counts.same > 10, `変更なし ${plan.counts.same} 件`);
// 新システムで予定を変える → 取り込み直しても上書きしない
await store.mutate((d) => Object.assign(d.schedule.find((e) => e.id === newEv.id), { startTime: "11:00", endTime: "12:00", updatedBy: koshiStaff.id, updatedAt: new Date(Date.now() + 1000).toISOString() }));
const month2 = P.parseMonth(
  sheets.map((s) => (s.name === "1" ? { ...s, rows: s.rows.map((row, i) => (i === 14 ? row.map((v, j) => (j === 10 ? "9:00〜10:00" : v)) : row)) } : s)),
  { label: `${Y}.1`, year: Y, month: 1, stores },
);
plan = PL.planSheetImport(db(), [month2], { from: D(1) });
eq(plan.items.find((i) => i.eventId === newEv.id)?.status, "kept", "新システムで時刻を変えた予定は取り込み直しても上書きしない");
eq(plan.items.find((i) => i.eventId === "ev_legacy_oiwa")?.status, "update", "スプレッドシートで時刻を変えた予定は書き換える");

/* ================================================================== */
section("4. 受注にしたとき: 取り込んだ同じ案件の引き取り・納品を使い回す");
const qa = await imp("lib/actions/quotes.ts");
const inqId = newEv.inquiryId;
await store.mutate((d) => {
  d.quotes.push({ id: "q_sheet", number: "Q-SH-1", version: 1, customerId: newCust.id, storeId: "koshi", inquiryId: inqId, title: "畳新調", category: "tatami", items: [{ id: "qi1", name: "畳 新調", qty: 4, unit: "畳", unitPrice: 20000, amount: 80000 }], subtotal: 80000, discount: 0, tax: 7272, total: 80000, status: "approved", validUntil: `${Y}-03-31`, createdBy: admin.id, createdAt: now, updatedAt: now });
});
const beforeCount = evs().filter((e) => e.customerId === newCust.id).length;
r = await act(admin, () => qa.convertQuoteToOrder("q_sheet", form({ scheduledStart: D(1), workerIds: [koshiStaff.id] })));
const o = db().orders.find((x) => x.quoteId === "q_sheet");
ok(o && !r.err, `見積から受注 (${r.err ?? "OK"})`);
const pick = db().schedule.find((e) => e.id === newEv.id);
eq([pick?.source, pick?.orderId, pick?.kind, pick?.date], ["order", o?.id, "pickup", D(1)], "取り込んだ引き取りの予定 (同じ ID) が受注の引き取りの予定になる");
eq(evs().filter((e) => e.customerId === newCust.id && e.kind === "pickup").length, 1, "引き取りの予定は 1 件のまま (二重にしない)");
ok(evs().filter((e) => e.customerId === newCust.id).length <= beforeCount + 1, "増えたのは納品の予定 (後日) だけ");

console.log(`\n${pass} passed, ${fails.length} failed`);
fs.rmSync(work, { recursive: true, force: true });
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(1);
}
