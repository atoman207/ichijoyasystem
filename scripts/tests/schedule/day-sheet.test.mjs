/**
 * お客様のご要望 2026-11-25「日ごとの予定表の表示形式と作業量の集計について」のテスト
 *   node scripts/tests/schedule/day-sheet.test.mjs   (npm run test:schedule)
 * 1. 表 (表替え・張替え) と 新 (新調) の数え分け (src/lib/work-summary.ts): 移行した予定表の「畳 表替え6・新調2」・明細・手書きの「タ新6」
 * 2. 日ごとの予定表 (src/lib/day-sheet.ts): 左 = 引取・見積・現調など / 右 = 納品、午前 / 午後 / 時間指定なし、欄の合計、
 *    換算作業量 = 畳 + 襖 + 障子 × 0.5 + 網戸 × 0.5、対応可能枚数 = 対象人数 × 11 (対象外・休暇・人数の手入力)、超過
 * 3. 設定の保存 (updateDayLoad。管理者だけ・変更履歴) と運用の手直し (data-fix の day-load)
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)。名前は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-day-sheet-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "day-sheet-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-day-sheet",
  CRON_SECRET: "test-cron-secret-day-sheet",
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
async function act(user, fn) {
  globalThis.__testUser = user;
  try {
    await fn();
    return { msg: null, err: null };
  } catch (e) {
    if (e && typeof e.digest === "string" && e.digest.startsWith("NEXT_REDIRECT")) {
      const u = new URL(e.url, "http://test.local");
      return { path: u.pathname, msg: u.searchParams.get("msg"), err: u.searchParams.get("err") };
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

const WK = await imp("lib/work-summary.ts");
const DS = await imp("lib/day-sheet.ts");

/* ================================================================== */
section("1. 表 (表替え・張替え) と 新 (新調) の数え分け");
{
  const a = WK.countsFromText("畳 表替え6・新調2 / 襖 張替4 / 障子 張替4・新2 / 網戸 新3");
  eq([a.tatami, a.fresh.tatami ?? 0], [8, 2], "移行した予定表「畳 表替え6・新調2」= 畳 8 (うち新調 2)。以前は「・新調2」を数えていなかった");
  eq([a.fusuma, a.fresh.fusuma ?? 0], [4, 0], "「襖 張替4」= 襖 表 4");
  eq([a.shoji, a.fresh.shoji ?? 0], [6, 2], "「障子 張替4・新2」= 障子 6 (うち新 2)");
  eq([a.amido, a.fresh.amido ?? 0], [3, 3], "「網戸 新3」= 網戸 新 3");
  const b = WK.countsFromText("タ新6フ2シ4", { shorthand: true });
  eq([b.tatami, b.fresh.tatami, b.fusuma, b.fresh.fusuma ?? 0, b.shoji], [6, 6, 2, 0, 4], "手書きの「タ新6フ2シ4」= 畳 新 6・襖 2・障子 4");
  const c = WK.countsFromText("タ6フ1", { shorthand: true });
  eq([c.tatami, c.fresh.tatami ?? 0, c.fusuma], [6, 0, 1], "これまでの「タ6フ1」はそのまま (表)");
  const l = WK.countsFromLines([
    { name: "畳表替え", spec: "きずな", qty: 6, unit: "枚" },
    { name: "畳新調", spec: "建材床", qty: 2, unit: "枚" },
    { name: "襖", spec: "新調 鳥の子", qty: 2, unit: "枚" },
    { name: "襖張替", spec: "", qty: 3, unit: "枚" },
    { name: "障子張替", qty: 4, unit: "枚" },
    { name: "縁", spec: "マス菊", qty: 8, unit: "畳" },
  ]);
  eq([l.tatami, l.fresh.tatami, l.fusuma, l.fresh.fusuma, l.shoji], [8, 2, 5, 2, 4], "見積の明細: 畳 8 (新調 2)・襖 5 (新調 2)・障子 4。縁は数えない");
  const m = WK.mergeCounts(a, l);
  eq([m.tatami, m.fresh.tatami], [16, 4], "足し合わせても新調の枚数を保つ");
  eq(WK.workText(a), "タ8 フ4 シ6 ア3", "予定表のチップの省略表記はこれまでどおり (表・新の合計)");
  const cols = DS.colsOf(a);
  eq(cols, { tatami: { omote: 6, fresh: 2 }, fusuma: { omote: 4, fresh: 0 }, shoji: { omote: 4, fresh: 2 }, amido: { omote: 0, fresh: 3 } }, "欄の数 (表・新)");
  const h = WK.countsFromText("縁無半12", { shorthand: true });
  eq(DS.colsOf(h).tatami, { omote: 12, fresh: 0 }, "へり無し畳の枚数だけの書き込み「縁無半12」は畳 12");
}

/* ================================================================== */
section("2. 換算作業量・欄・時間帯");
{
  const w = DS.DAY_LOAD_DEFAULTS.weights;
  const c = DS.emptyCols();
  c.tatami = { omote: 6, fresh: 2 };
  c.fusuma = { omote: 4, fresh: 0 };
  c.shoji = { omote: 1, fresh: 2 };
  c.amido = { omote: 2, fresh: 0 };
  eq(DS.workload(c, w), 14.5, "畳 8 + 襖 4 + 障子 3 × 0.5 + 網戸 2 × 0.5 = 14.5");
  eq(DS.workloadFormula(c, w), "畳 8 + 襖 4 + 障子 3×0.5 + 網戸 2×0.5", "式の表示");
  eq([DS.sideOf("pickup"), DS.sideOf("survey"), DS.sideOf("site_survey"), DS.sideOf("meeting"), DS.sideOf("delivery")], ["left", "left", "left", "left", "right"], "左 = 引取・見積・現調・会議 / 右 = 納品");
  eq([DS.bandOf({ slot: "am" }), DS.bandOf({ slot: "pm" }), DS.bandOf({ startTime: "11:30" }), DS.bandOf({ startTime: "12:00" }), DS.bandOf({})], ["am", "pm", "am", "pm", "none"], "午前 / 午後 (12 時から) / 時間指定なし");
  eq(DS.sheetTime({ date: "2026-12-01", endDate: "2026-12-03", startTime: "09:00" }, "2026-12-02"), "09:00 2/3日目", "複数日の予定の時間の欄");
}

/* ================================================================== */
section("3. 対象人数と対応可能枚数");
const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const admin = db().users.find((u) => u.active && u.role === "admin");
const S = db().stores.find((s) => s.kind === "store").id;
const hqId = db().stores.find((s) => s.kind === "hq")?.id;
const now = new Date().toISOString();
// 架空の社員 4 人 (店舗の社員を入れ替えて人数を決める)
await store.mutate((x) => {
  for (const u of x.users) if (u.storeId === S) u.active = false;
  const mk = (id, name, role, title) => x.users.push({ id, name, email: `${id}@example.test`, role, title, storeId: S, active: true, createdAt: now, updatedAt: now });
  mk("u_ds_boss", "架空 社長", "admin", "社長");
  mk("u_ds_a", "試験 一郎", "store_staff", "施工");
  mk("u_ds_b", "試験 二郎", "store_staff", "営業・施工");
  mk("u_ds_part", "試験 花子", "store_staff", "パート");
});
const day = "2026-12-02";
let set = DS.readDayLoadSettings(db());
eq([set.perPerson, set.weights, set.countDelivery, set.countEstimates, set.subtractLeave], [11, { tatami: 1, fusuma: 1, shoji: 0.5, amido: 0.5 }, false, false, true], "既定: 11 枚・畳 1・襖 1・障子 0.5・網戸 0.5・納品と見積の見込みは数えない・休暇を引く");
{
  const c0 = DS.storeCapacity(db(), set, S, day, []);
  eq([c0.base, c0.people, c0.capacity], [4, 4, 44], "設定なし: 店舗の社員 4 人 × 11 = 44 枚");
  const s2 = { ...set, stores: { [S]: { excludeUserIds: ["u_ds_boss", "u_ds_part"] } } };
  const c1 = DS.storeCapacity(db(), s2, S, day, []);
  eq([c1.base, c1.people, c1.capacity], [2, 2, 22], "2 人を対象外: 2 人 × 11 = 22 枚 (スプレッドシートの「人 × 11」と同じ)");
  eq(c1.members.filter((m) => !m.counted).map((m) => m.id).sort(), ["u_ds_boss", "u_ds_part"], "対象外の社員");
  const leaves = [
    { kind: "leave", assigneeIds: ["u_ds_a"], date: day },
    { kind: "leave", assigneeIds: ["u_ds_b"], date: day, slot: "pm" },
    { kind: "leave", assigneeIds: ["u_ds_part"], date: day },
  ];
  const c2 = DS.storeCapacity(db(), s2, S, day, leaves);
  eq([c2.leave, c2.people, c2.capacity], [1.5, 0.5, 5.5], "休暇: 終日 1 人・午後 0.5 人を引く (対象外の人の休暇は引かない) → 0.5 人 × 11 = 5.5 枚");
  const c3 = DS.storeCapacity(db(), { ...s2, subtractLeave: false }, S, day, leaves);
  eq(c3.capacity, 22, "休暇を引かない設定");
  const c4 = DS.storeCapacity(db(), { ...set, stores: { [S]: { excludeUserIds: [], people: 3 } } }, S, day, [leaves[0]]);
  eq([c4.manual, c4.base, c4.people, c4.capacity], [true, 3, 2, 22], "人数を手で決めた店舗 (3 人) から休暇 1 人を引く");
  const c5 = DS.storeCapacity(db(), s2, S, day, [], true);
  eq([c5.closed, c5.capacity], [true, 0], "休業日は 0 枚");
  ok(!hqId || DS.storeCapacity(db(), set, hqId, day, []) === undefined, "本部は対応可能枚数を出さない");
  const leaveOther = [{ kind: "leave", assigneeIds: ["u_ds_a"], date: "2026-12-03" }];
  eq(DS.storeCapacity(db(), s2, S, day, leaveOther).people, 2, "ほかの日の休暇は引かない");
}

/* ================================================================== */
section("4. 日ごとの予定表 (店舗の欄)");
{
  const s2 = { ...set, stores: { [S]: { excludeUserIds: ["u_ds_boss", "u_ds_part"] } } };
  const ev = (id, kind, extra = {}) => ({ id, title: `（テスト町）架空${id}`, kind, date: day, storeId: S, assigneeIds: ["u_ds_a"], source: "manual", ...extra });
  const events = [
    ev("p1", "pickup", { startTime: "09:00", memo: "2 階の和室" }),
    ev("p2", "pickup", { slot: "pm" }),
    ev("q1", "onsite_quote", { startTime: "13:30" }),
    ev("s1", "survey", { startTime: "10:00" }),
    ev("m1", "meeting", { startTime: "17:00", assigneeIds: ["u_ds_a", "u_ds_b"] }),
    ev("d1", "delivery", { startTime: "15:00" }),
    ev("d2", "delivery", { slot: "am" }),
    ev("i1", "install", { date: "2026-12-01", endDate: "2026-12-03", title: "（テスト町）架空i1 クロス張替" }),
    ev("hold:h1", "pickup", { startTime: "11:00" }),
    ev("l1", "leave", { assigneeIds: ["u_ds_b"], slot: "am", title: "休暇" }),
    ev("x1", "pickup", { date: "2026-12-05" }),
  ];
  const work = new Map([
    ["p1", WK.countsFromText("畳 表替え6・新調2 / 襖 張替4")],
    ["p2", WK.countsFromText("畳 表替え4 / 網戸 張替2")],
    ["q1", WK.countsFromText("障子 張替3")],
    ["s1", WK.countsFromText("畳 表替え8")],
    ["d1", WK.countsFromText("畳 表替え6・新調2 / 襖 張替4")],
    ["d2", WK.countsFromText("畳 新調4")],
    ["hold:h1", WK.countsFromText("畳 表替え10")],
  ]);
  const sheet = DS.buildStoreSheet({ day, storeId: S, events, work, label: (e) => ({ area: "テスト町", name: `架空${e.id}` }), set: s2, db: db() });
  const ids = (side, band) => sheet.rows.filter((r) => r.side === side && r.band === band).map((r) => r.event.id);
  eq(ids("left", "am"), ["p1", "s1", "hold:h1"], "左・午前: 引取 9:00・見積 10:00・仮押さえ 11:00 (時刻の順)");
  eq(ids("left", "pm"), ["p2", "q1", "m1"], "左・午後: 引取 (午後)・現見 13:30・会議 17:00");
  eq(ids("left", "none"), ["i1"], "左・時間指定なし: 施工 (複数日)");
  eq([ids("right", "am"), ids("right", "pm")], [["d2"], ["d1"]], "右: 納品 (午前 / 午後)");
  ok(!sheet.rows.some((r) => r.event.id === "l1" || r.event.id === "x1"), "休暇は行にしない・ほかの日の予定は出さない");
  eq(sheet.leaves.map((e) => e.id), ["l1"], "休暇はその日の休暇の一覧へ");
  const row = (id) => sheet.rows.find((r) => r.event.id === id);
  eq([row("p1").counted, row("q1").counted, row("i1").counted, row("s1").counted, row("m1").counted, row("hold:h1").counted, row("d1").counted], [true, true, true, false, false, false, false], "作業量に数える = 引取・現見・施工 (見積・会議・仮押さえ・納品は数えない)");
  eq(row("p1").cols.tatami, { omote: 6, fresh: 2 }, "行の欄: 畳 表 6・新 2");
  eq([row("p1").time, row("p2").time, row("i1").time], ["09:00", "PM", "2/3日目"], "時間の欄 (時刻 / PM / 複数日)");
  ok(row("p1").remark.includes("2 階の和室"), "備考 = メモ");
  ok(row("i1").remark.startsWith("施工:") && row("i1").remark.includes("クロス張替"), "リフォームなどの施工は備考に内容を出す");
  ok(row("hold:h1").remark.includes("仮押さえ"), "仮押さえは備考に「仮押さえ」");
  eq([row("p1").town, row("p1").site], ["テスト町", "架空p1"], "地名・現場");
  eq(sheet.totals.left, { tatami: { omote: 10, fresh: 2 }, fusuma: { omote: 4, fresh: 0 }, shoji: { omote: 3, fresh: 0 }, amido: { omote: 2, fresh: 0 } }, "左の合計 = 数える行だけ (見積の 8 枚・仮押さえの 10 枚は入れない)");
  eq(sheet.totals.right, { tatami: { omote: 6, fresh: 6 }, fusuma: { omote: 4, fresh: 0 }, shoji: { omote: 0, fresh: 0 }, amido: { omote: 0, fresh: 0 } }, "右の合計 = 納品すべて");
  eq(sheet.workload, 18.5, "換算作業量 = 畳 12 + 襖 4 + 障子 3 × 0.5 + 網戸 2 × 0.5 = 18.5");
  eq([sheet.capacity.people, sheet.capacity.capacity, sheet.over], [1.5, 16.5, 2], "対象 2 人 − 午前休 0.5 人 = 1.5 人 × 11 = 16.5 枚 → 2 枚オーバー");
  const both = DS.buildStoreSheet({ day, storeId: S, events, work, label: () => ({ name: "" }), set: { ...s2, countDelivery: true }, db: db() });
  eq([both.workload, both.over], [34.5, 18], "納品も数える設定: 18.5 + 畳 12 + 襖 4 = 34.5");
  const est = DS.buildStoreSheet({ day, storeId: S, events, work, label: () => ({ name: "" }), set: { ...s2, countEstimates: true }, db: db() });
  eq([est.workload, est.rows.find((r) => r.event.id === "s1").counted, est.rows.find((r) => r.event.id === "m1").counted], [26.5, true, false], "見積・現調・採寸の枚数も数える設定: 18.5 + 見積の畳 8 = 26.5 (会議は数えない)");
  const l = DS.dayLoad({ day, storeId: S, events, work, set: s2, db: db() });
  eq(l, { workload: 18.5, capacity: 16.5, over: 2 }, "週・月の見出しの作業量 (dayLoad)");
  const leaveElsewhere = DS.buildStoreSheet({ day, storeId: S, events: events.filter((e) => e.kind !== "leave"), capacityEvents: [events.find((e) => e.id === "l1")], work, label: () => ({ name: "" }), set: s2, db: db() });
  eq(leaveElsewhere.capacity.people, 1.5, "休暇の予定は店舗の予定と別に渡せる (capacityEvents)");
}

/* ================================================================== */
section("5. 設定の保存 (管理者) と運用の手直し");
{
  const A = await imp("lib/actions/day-load.ts");
  const staff = db().users.find((u) => u.id === "u_ds_a");
  const denied = await act(staff, () => A.updateDayLoad(form({ perPerson: 12 })));
  ok(denied.err?.includes("管理者"), "管理者でない社員は変えられない");
  const r = await act(admin, () =>
    A.updateDayLoad(
      form({ perPerson: 11, "w.tatami": 1, "w.fusuma": 1, "w.shoji": 0.5, "w.amido": 0.5, subtractLeave: "1", [`${S}.include`]: ["u_ds_a", "u_ds_b"], [`${S}.people`]: "" }),
    ),
  );
  ok(r.msg?.includes("保存しました"), `管理者が保存できる (${r.msg ?? r.err})`);
  set = DS.readDayLoadSettings(db());
  eq(set.stores[S]?.excludeUserIds.sort(), ["u_ds_boss", "u_ds_part"], "チェックを外した 2 人が対象外");
  eq([set.countDelivery, set.subtractLeave], [false, true], "納品は数えない・休暇を引く");
  const audit = db().auditLogs.findLast((a) => a.entityId === DS.DAY_LOAD_ID);
  ok(audit && audit.changes?.some((c) => c.field.endsWith("対象外") && String(c.after).includes("架空 社長")), "変更履歴に対象外の社員の名前");
  const bad = await act(admin, () => A.updateDayLoad(form({ perPerson: 0, "w.tatami": 1, "w.fusuma": 1, "w.shoji": 0.5, "w.amido": 0.5 })));
  ok(bad.err?.includes("1 人の 1 日"), "1 人の枚数が 0 は断る");

  const route = await imp("app/api/cron/data-fix/route.ts");
  const call = async (body, apply) => {
    const res = await route.POST(new Request(`http://test.local/api/cron/data-fix?task=day-load${apply ? "&apply=1" : ""}`, { method: "POST", headers: { authorization: "Bearer test-cron-secret-day-sheet", "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  };
  const dry = await call({ stores: { [S]: { excludeUserIds: ["u_ds_boss"] } } }, false);
  ok(dry.status === 200 && dry.json.applied === false && dry.json.changes.length === 1, "data-fix の day-load: 既定は確認だけ (変更 1 項目)");
  eq(DS.readDayLoadSettings(db()).stores[S]?.excludeUserIds.sort(), ["u_ds_boss", "u_ds_part"], "確認だけでは書かない");
  const wrong = await call({ stores: { [S]: { excludeUserIds: [admin.id === "u_ds_boss" ? "nope" : admin.id] } } }, true);
  ok(wrong.status === 400, "ほかの店舗の社員の ID は断る");
  const done = await call({ stores: { [S]: { excludeUserIds: ["u_ds_boss"] } } }, true);
  ok(done.json.applied === true, "apply=1 で書く");
  eq(DS.readDayLoadSettings(db()).stores[S]?.excludeUserIds, ["u_ds_boss"], "書いた店舗の対象外だけ置き換わる");
  const unauth = await route.POST(new Request("http://test.local/api/cron/data-fix?task=day-load", { method: "POST", body: "{}" }));
  ok(unauth.status === 401, "CRON_SECRET がなければ断る");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
