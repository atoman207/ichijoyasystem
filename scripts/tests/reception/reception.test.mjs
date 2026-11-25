/**
 * 受付 (すべての問い合わせの共通の入口) のテスト
 *   node scripts/tests/reception/reception.test.mjs   (npm run test:reception)
 * 1. 項目の整え・AI なしの読み取り (電話番号・内容の種類・種別)
 * 2. 照合 (電話番号のお客様・案件番号・進行中の案件・仕入先・ほかの店舗のお客様) と登録先の提案
 * 3. 画面の操作 (Server Action の本物): 文章の取込 → 問い合わせとして登録 / 案件に追加 / 記録だけ / 閉じる / 修正の保存
 * 4. AI (モックの OpenAI): 手書きメモの写真の読み取り・写真を問い合わせに付け替え・要確認の項目
 * 5. 通話の録音 (/api/reception/audio) と電話のシステム (/api/integrations/phone-call)
 * データは一時フォルダーの JSON (サンプルデータ)。外部への送信の設定は消す (送らない)。本物の AI には接続しない
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-reception-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "reception-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-reception",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_|AI_INTAKE_|PHONE_INTAKE_|AI_VOICE)/.test(k)) delete process.env[k];
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

/** 社員 user として Server Action を呼ぶ (redirect の行き先・msg・err を返す) */
async function act(user, fn) {
  globalThis.__testUser = user;
  try {
    await fn();
    return { path: null, msg: null, err: null };
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
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) fd.set(k, v instanceof Blob ? v : String(v));
  return fd;
};

/* ---------------- モックの OpenAI (chat completions・音声の文字起こし) ---------------- */
let chatHandler = () => ({});
let sttText = "";
const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: req.url, raw });
    if (req.url.endsWith("/audio/transcriptions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: sttText, usage: { input_tokens: 100, output_tokens: 50 } }));
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* */
    }
    const data = chatHandler(body);
    const content = JSON.stringify({ confidence: 0.9, warnings: [], ...blank(), ...data });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c", model: "gpt-4.1", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 100 } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const aiOn = () => Object.assign(process.env, { OPENAI_API_KEY: "sk-test-mock", OPENAI_BASE_URL: `${base}/v1`, OPENAI_MODEL: "gpt-4.1" });
const aiOff = () => {
  for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) delete process.env[k];
};

const store = await imp("lib/db/store.ts");
const R = await imp("lib/reception.ts");
const actions = await imp("lib/actions/reception.ts");
const capture = await imp("lib/actions/capture.ts");
await store.syncDb();
const db = () => store.getDb();
const blank = () => Object.fromEntries(R.RECEPTION_FIELD_KEYS.map((k) => [k, k === "uncertainFields" ? [] : ""]));

const nowIso = new Date().toISOString();
const admin = db().users.find((u) => u.role === "admin" && u.active);
const koshi = db().stores.find((s) => s.id === "koshi");
const koshiManager = db().users.find((u) => u.id === koshi.managerUserId && u.active);
const koshiStaff = db().users.find((u) => u.active && u.storeId === "koshi" && u.role === "store_staff" && u.id !== koshiManager?.id);
ok(admin && koshiManager && koshiStaff, "サンプルデータ: 管理者・合志店の店長と社員がいる");

// 照合用のお客様・案件・仕入先 (サンプルデータと重ならない番号)
await store.mutate((d) => {
  const base = { kana: "", type: "individual", postalCode: "", address: "", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: nowIso, updatedAt: nowIso };
  d.customers.push({ ...base, id: "cust_rc1", code: "C-RC1", name: "受付 一郎", phone: "090-8101-0001", storeId: "koshi", address: "熊本県合志市須屋 1-1" });
  d.customers.push({ ...base, id: "cust_rc2", code: "C-RC2", name: "受付 次子", phone: "090-8102-0002", storeId: "nishi" });
  d.customers.push({ ...base, id: "cust_rc3", code: "C-RC3", name: "停止 三郎", phone: "090-8103-0003", storeId: "koshi", tradeStopped: true });
  const order = { quoteId: undefined, category: "tatami", contractDate: "2026-11-01", total: 66000, workerIds: [], siteAddress: "熊本県合志市須屋 1-1", progressNotes: [], createdBy: koshiManager.id, createdAt: nowIso, updatedAt: nowIso };
  d.orders.push({ ...order, id: "ord_rc1", number: "O-2099-8101", customerId: "cust_rc1", storeId: "koshi", title: "和室6畳 表替え", status: "scheduled", scheduledStart: "2099-12-01T09:00:00+09:00" });
  d.orders.push({ ...order, id: "ord_rc2", number: "O-2099-8102", customerId: "cust_rc1", storeId: "koshi", title: "襖 4枚", status: "paid", completedAt: "2020-01-01", updatedAt: "2020-01-01T00:00:00Z" });
  d.suppliers.push({ id: "sup_rc1", name: "九州テスト畳材", category: "材料", phone: "096-810-9999" });
});

/* ================================================================== */
section("1. 項目の整え・AI なしの読み取り");
{
  const f = R.normalizeReception({ callType: "x", customerName: "山田 花子 様", category: "tatami", urgency: "HIGH", receivedAt: "2026-11-20 10:15", uncertainFields: ["phone", "bogus"] });
  eq(f.callType, "", "知らない種類は空");
  eq(f.customerName, "山田 花子", "「様」を外す");
  eq(f.category, "畳", "種別のコードはラベルにする");
  eq(f.urgency, "", "決められた値だけ (HIGH は空)");
  eq(f.receivedAt, "2026-11-20T10:15", "受付日時は YYYY-MM-DDTHH:mm");
  eq(f.uncertainFields, ["phone"], "要確認の項目は項目名だけ");
  eq(R.categoryKey("網戸"), "amido", "種別のラベル → コード");
  eq(R.findPhones("携帯 ０９０−１２３４−５６７８ 自宅 096-123-4567"), ["090-1234-5678", "096-123-4567"], "文章から電話番号を探す (全角も)");
  const a = R.ruleReception("山田様から電話 090-1111-2222 和室の畳を表替えしたい。至急見に来てほしい");
  eq([a.callType, a.phone, a.category, a.urgency, a.customerName], ["new_inquiry", "090-1111-2222", "畳", "high", "山田"], "AI なし: 新規・電話番号・種別・緊急度・お名前");
  eq(R.ruleReception("来週の引取の日程を変更したいとのこと").callType, "existing_case", "AI なし: 日程の変更 → 案件の連絡");
  eq(R.ruleReception("光回線のご案内の営業の電話").callType, "sales", "AI なし: 営業の電話");
  eq(R.ruleReception("問屋から入荷の連絡").callType, "supplier", "AI なし: 仕入先・業者");
}

/* ================================================================== */
section("2. 照合と登録先の提案");
{
  const f = (o) => R.normalizeReception({ callType: "new_inquiry", ...o });
  const m1 = R.matchReception(db(), koshiStaff, f({ phone: "09081010001", customerName: "受付 一郎" }));
  eq(m1.customers.map((c) => [c.customer.id, c.level]), [["cust_rc1", "phone"], ["cust_rc2", "name"]], "電話番号 (ハイフンなし) でお客様を見つける (電話の一致が先、名字の一致はそのあと)");
  eq(m1.suggestion.action, "inquiry", "新しい問い合わせ → 問い合わせとして登録");
  eq(m1.suggestion.customerId, "cust_rc1", "登録済みのお客様を選ぶ");
  ok(m1.cases.some((c) => c.id === "ord_rc1" && c.open) && !m1.cases.some((c) => c.id === "ord_rc2"), "進行中の受注は候補、半年より前に終わった受注は出さない");

  const m2 = R.matchReception(db(), koshiStaff, f({ callType: "existing_case", phone: "090-8101-0001", summary: "引取の日を変えたい" }));
  eq([m2.suggestion.action, m2.suggestion.caseKey], ["case", "order:ord_rc1"], "案件の連絡 → 進行中の受注に追加");

  const m3 = R.matchReception(db(), koshiStaff, f({ callType: "existing_case", caseHint: "o-2099-8101 の件", phone: "" }));
  eq(m3.suggestion.caseKey, "order:ord_rc1", "案件番号 (小文字) で案件を見つける");

  const m4 = R.matchReception(db(), koshiStaff, f({ callType: "existing_case", phone: "090-0000-0000" }));
  ok(m4.suggestion.action === "inquiry" && m4.warnings.some((w) => w.includes("該当する案件が見つかりません")), "案件が見つからないときは問い合わせを提案して知らせる");

  const m5 = R.matchReception(db(), koshiStaff, f({ callType: "supplier", phone: "096-810-9999" }));
  eq([m5.suggestion.action, m5.suggestion.supplierId], ["record", "sup_rc1"], "仕入先の電話番号 → 仕入先のやりとりとして記録");
  const m5b = R.matchReception(db(), koshiStaff, f({ callType: "supplier", companyName: "株式会社 九州テスト畳材" }));
  eq(m5b.suppliers[0]?.id, "sup_rc1", "会社名でも仕入先を見つける (株式会社を除く)");

  eq(R.matchReception(db(), koshiStaff, f({ callType: "sales" })).suggestion.action, "dismiss", "営業電話 → 記録しない");

  const m6 = R.matchReception(db(), koshiStaff, f({ phone: "090-8102-0002" }));
  eq(m6.customers[0]?.customer.id, "cust_rc2", "ほかの店舗のお客様も候補に出す (顧客の一覧で見られるお客様。閲覧の範囲の初期設定 = 全社員)");
  // 閲覧の範囲を「進行中の案件だけ」にしたときは、ほかの店舗のお客様は候補に出さず、店舗名だけ知らせる
  await store.mutate((d) => d.settings.push({ id: "access_policy", value: { figures: "all", customers: "open", grantDays: 7 }, updatedAt: "2026-01-01T00:00:00Z" }));
  const m6c = R.matchReception(db(), koshiStaff, f({ phone: "090-8102-0002" }));
  ok(m6c.customers.length === 0 && m6c.otherStores[0]?.storeId === "nishi" && m6c.warnings.some((w) => w.includes("西")), "閲覧の範囲の外のお客様は候補に出さず、店舗名だけ知らせる");
  await store.mutate((d) => (d.settings = d.settings.filter((x) => x.id !== "access_policy")));
  const m6b = R.matchReception(db(), admin, f({ phone: "090-8102-0002" }));
  eq(m6b.customers[0]?.customer.id, "cust_rc2", "全店舗を見られる人には候補に出す");

  ok(R.matchReception(db(), koshiStaff, f({ phone: "090-8103-0003" })).warnings.some((w) => w.includes("取引停止")), "取引停止のお客様は知らせる");
  const m7 = R.matchReception(db(), koshiStaff, f({ customerName: "受付 一郎", phone: "" }));
  eq(m7.customers.map((c) => [c.customer.id, c.level]), [["cust_rc1", "name"], ["cust_rc2", "name"]], "電話番号がなければお名前・名字で候補を出す (お名前のままの一致が先。自動では選ばない)");
  eq(m7.suggestion.customerId, undefined, "お名前だけの一致はお客様を選ばない");

  const m8 = R.matchReception(db(), koshiStaff, f({ customerName: "受付 一郎", phone: "", address: "合志市須屋 1-1" }));
  eq(m8.customers[0]?.level, "address", "住所+氏名でお客様を見つける");
  eq(m8.suggestion.customerId, "cust_rc1", "住所が一致すれば自動で選ぶ");

  const m9 = R.matchReception(db(), koshiStaff, f({ phone: "090-8101-0001", customerName: "受付 一郎", address: "熊本県合志市須屋 1-1" }));
  eq(m9.customers[0]?.level, "address", "住所一致を電話より優先して表示する");
  eq(m9.suggestion.customerId, "cust_rc1", "住所+電話でもお客様を選ぶ");

  await store.mutate((d) => {
    d.customers.push({
      id: "cust_rc1b", code: "C-RC1B", name: "受付 別邸", kana: "", type: "individual", phone: "090-8101-0001",
      postalCode: "", address: "熊本県合志市幾久富 9-9", storeId: "koshi", preferredChannel: "phone", firstContactChannel: "phone",
      tags: [], notes: "", createdAt: nowIso, updatedAt: nowIso,
    });
  });
  const m10 = R.matchReception(db(), koshiStaff, f({ phone: "090-8101-0001", customerName: "受付", address: "合志市幾久富 9-9" }));
  eq(m10.suggestion.customerId, "cust_rc1b", "同じ電話でも住所が一致する方を選ぶ");
  ok(m10.warnings.some((w) => w.includes("電話番号が一致するお客様が")), "同じ電話の複数候補を知らせる");
  await store.mutate((d) => {
    d.customers = d.customers.filter((c) => c.id !== "cust_rc1b");
  });
}

/* ================================================================== */
section("3. 画面の操作 (AI なし)");
aiOff();
let docId = "";
{
  const r = await act(koshiStaff, () => actions.createReception(form({ source: "voice", channel: "mobile", storeId: "koshi", text: "受付一郎様から携帯に電話。090-8101-0001。新しく洋室に琉球畳を入れたい。見積に来てほしい。" })));
  ok(r.path?.startsWith("/inquiries/reception/") && r.msg?.includes("読み取りました"), "文章を取り込むと受付の確認の画面へ");
  docId = r.path.split("/").pop();
  const doc = db().documents.find((d) => d.id === docId);
  ok(doc && doc.kind === "reception" && doc.status === "extracted" && doc.storeId === "koshi", "受付 (kind = reception) が確認待ちで入る");
  const meta = R.receptionMetaOf(doc);
  eq([meta.source, meta.channel], ["voice", "mobile"], "入り方 = 話して入力・入口 = 担当者の携帯");
  eq(R.receptionFieldsOf(doc).phone, "090-8101-0001", "AI なしでも電話番号を読む");
  ok(R.pendingReceptionCount(db(), koshiStaff) >= 1, "確認待ちの件数 (ヘッダーのバッジ) に入る");
  eq(R.pendingReceptionCount(db(), db().users.find((u) => u.active && u.storeId === "nishi" && u.role === "store_staff")), 0, "ほかの店舗の社員の件数には入らない");

  const short = await act(koshiStaff, () => actions.createReception(form({ source: "text", text: "あ" })));
  ok(short.err?.includes("受付の内容"), "内容が短すぎるときは断る");
  const other = await act(koshiStaff, () => actions.createReception(form({ source: "text", storeId: "nishi", text: "西店の受付を入れようとした" })));
  const otherDoc = db().documents.find((d) => d.id === other.path?.split("/").pop());
  ok(other.err || otherDoc?.storeId === "koshi", "店舗のロールはほかの店舗の受付を入れられない");
}
{
  // 要確認の項目があると、確認のチェックまで登録しない
  const r = await act(koshiStaff, () => actions.registerReception(form({ id: docId, intent: "inquiry", customerName: "受付 一郎", summary: "洋室に琉球畳", category: "畳", media: "flyer", customerId: "cust_rc1" })));
  ok(r.err?.includes("自信がない項目") && db().documents.find((d) => d.id === docId).status === "extracted", "要確認の項目 (AI なしの読み取り) が残っていると登録しない");
  const noMedia = await act(koshiStaff, () => actions.registerReception(form({ id: docId, intent: "inquiry", customerName: "受付 一郎", summary: "洋室に琉球畳", confirmedUncertain: "on", customerId: "cust_rc1" })));
  ok(noMedia.err?.includes("媒体"), "媒体がないと問い合わせにしない");
  // お客様を決めずに問い合わせは登録しない → 最初に紐付ける (お客様のご要望 2026-11-25「問い合わせ登録時の顧客登録・紐付け」)
  const noCust = await act(koshiStaff, () => actions.registerReception(form({ id: docId, intent: "inquiry", customerName: "受付 一郎", summary: "洋室に琉球畳", media: "flyer", confirmedUncertain: "on" })));
  ok(/先に上の「お客様・案件の確認」/.test(noCust.err ?? ""), "お客様が決まっていないと問い合わせにしない");
  const link = await act(koshiStaff, () => actions.registerReception(form({ id: docId, quick: "link:cust_rc1", customerName: "受付 一郎", phone: "090-8101-0001", summary: "洋室に琉球畳" })));
  ok(/紐付けました/.test(link.msg ?? "") && R.receptionMetaOf(db().documents.find((d) => d.id === docId)).customerId === "cust_rc1", "「このお客様に紐付ける」でお客様が決まる");
  const before = db().inquiries.length;
  const ok1 = await act(koshiStaff, () => actions.registerReception(form({ id: docId, intent: "inquiry", channel: "mobile", customerName: "受付 一郎", phone: "090-8101-0001", summary: "洋室に琉球畳", detail: "洋室6畳に琉球畳。見積に来てほしい", desiredDate: "来週土曜の午前", category: "畳", media: "flyer", confirmedUncertain: "on", customerId: "cust_rc1", assignedUserId: koshiManager.id, handoff: "on" })));
  ok(ok1.path?.startsWith("/inquiries/inq") && ok1.msg?.includes("登録しました"), "問い合わせとして登録 → 問い合わせの画面へ");
  ok(db().inquiries.length === before + 1, "問い合わせが 1 件増える");
  const inq = db().inquiries.find((i) => i.id === ok1.path.split("/").pop());
  eq([inq.channel, inq.customerId, inq.storeId, inq.category, inq.media, inq.assignedUserId, inq.status], ["mobile", "cust_rc1", "koshi", "tatami", "flyer", koshiManager.id, "new"], "入口・お客様・店舗・種別・媒体・担当・状態");
  eq(inq.sourceRef, `reception:${docId}`, "元の受付の印");
  ok(inq.detail.includes("希望の日時: 来週土曜の午前") && inq.detail.includes("[受付 (話して入力) から登録]"), "内容に希望の日時と受付の入り方を書く");
  eq(inq.intake?.desiredDate, "来週土曜の午前", "受け取った項目 (希望の日時) を持つ");
  ok(inq.nextAction?.includes("折返し") && inq.nextActionDue, "次のアクション = 折返しの電話 (今日まで)");
  const log = db().commLogs.find((c) => c.relatedType === "inquiry" && c.relatedId === inq.id);
  ok(log && log.customerId === "cust_rc1" && log.subject.startsWith("受付:") && log.body.includes("入力した内容"), "やりとりの記録 (お客様の履歴にも出る) に元の文章を残す");
  const task = db().threads.find((t) => t.kind === "request" && t.relatedType === "inquiry" && t.relatedId === inq.id);
  ok(task && task.assigneeIds?.[0] === koshiManager.id && task.createdBy === koshiStaff.id, "担当者 (店長) に業務依頼で引き継ぐ");
  const doc = db().documents.find((d) => d.id === docId);
  eq([doc.status, doc.linkedType, doc.linkedId, R.receptionMetaOf(doc).decision?.action], ["confirmed", "inquiry", inq.id, "inquiry"], "受付は登録済み (登録先を持つ)");
  const again = await act(koshiStaff, () => actions.registerReception(form({ id: docId, intent: "inquiry", summary: "x", media: "flyer" })));
  ok(again.err?.includes("登録済み"), "登録済みの受付は二重に登録しない");
  ok(db().auditLogs.some((l) => l.entity === "inquiry" && l.entityId === inq.id && l.summary.includes("受付から問い合わせを登録")), "変更履歴に残す");
}
{
  // 案件の連絡 → 受注のやりとりに追加・担当者に知らせる
  const c = await act(koshiStaff, () => actions.createReception(form({ source: "text", channel: "phone", text: "受付一郎様 090-8101-0001 から、12月1日の引取を3日に変えてほしいと電話" })));
  const id = c.path.split("/").pop();
  const notes = db().orders.find((o) => o.id === "ord_rc1").progressNotes.length;
  const r = await act(koshiStaff, () => actions.registerReception(form({ id, intent: "case", caseKey: "order:ord_rc1", summary: "引取を12/3に変更したい", confirmedUncertain: "on", notifyOwner: "on" })));
  eq(r.path, "/orders/ord_rc1", "案件に追加 → 受注の画面へ");
  const o = db().orders.find((x) => x.id === "ord_rc1");
  ok(o.progressNotes.length === notes + 1 && o.progressNotes.at(-1).body.includes("引取を12/3に変更したい"), "受注の経過メモに残す");
  ok(db().commLogs.some((l) => l.relatedType === "order" && l.relatedId === "ord_rc1" && l.customerId === "cust_rc1" && l.channel === "phone"), "お客様・受注のやりとりに残す");
  const t = db().threads.find((x) => x.relatedType === "order" && x.relatedId === "ord_rc1" && x.kind === "request");
  ok(t && t.assigneeIds?.[0] === koshiManager.id, "案件の担当者 (受注の作成者) に業務依頼で知らせる");
  const d = db().documents.find((x) => x.id === id);
  eq([d.linkedType, d.linkedId], ["order", "ord_rc1"], "受付の登録先 = 受注");

  // 案件番号の入力・見つからない番号
  const c2 = await act(koshiStaff, () => actions.createReception(form({ source: "text", text: "O-2099-8101 の件で確認の電話。到着時間を知りたい" })));
  const bad = await act(koshiStaff, () => actions.registerReception(form({ id: c2.path.split("/").pop(), intent: "case", caseRef: "O-2099-0000", summary: "確認", confirmedUncertain: "on" })));
  ok(bad.err?.includes("見つかりません"), "見つからない案件番号は断る");
  const good = await act(koshiStaff, () => actions.registerReception(form({ id: c2.path.split("/").pop(), intent: "case", caseRef: "o-2099-8101", summary: "到着時間の確認", confirmedUncertain: "on" })));
  eq(good.path, "/orders/ord_rc1", "案件番号の入力で追加できる");
}
{
  // 仕入先のやりとり・記録しない・修正の保存
  const c = await act(koshiStaff, () => actions.createReception(form({ source: "text", text: "九州テスト畳材から入荷の連絡。096-810-9999" })));
  const id = c.path.split("/").pop();
  const none = await act(koshiStaff, () => actions.registerReception(form({ id, intent: "record", confirmedUncertain: "on" })));
  ok(none.err?.includes("相手"), "記録だけのときは相手が必要");
  const r = await act(koshiStaff, () => actions.registerReception(form({ id, intent: "record", supplierId: "sup_rc1", summary: "畳表の入荷", confirmedUncertain: "on" })));
  eq(r.path, "/suppliers/sup_rc1", "仕入先のやりとりとして記録 → 仕入先の画面へ");
  ok(db().commLogs.some((l) => l.supplierId === "sup_rc1" && l.subject.includes("畳表の入荷")), "仕入先のやりとりに残す");

  const c2 = await act(koshiStaff, () => actions.createReception(form({ source: "text", text: "光回線の営業の電話でした" })));
  const id2 = c2.path.split("/").pop();
  const saved = await act(koshiStaff, () => actions.registerReception(form({ id: id2, intent: "save", summary: "回線の営業", companyName: "テスト回線" })));
  ok(saved.msg?.includes("保存しました") && R.receptionFieldsOf(db().documents.find((d) => d.id === id2)).companyName === "テスト回線", "修正を保存 (登録はしない)");
  const logs = db().commLogs.length;
  const dis = await act(koshiStaff, () => actions.registerReception(form({ id: id2, intent: "dismiss", dismissNote: "回線の営業電話" })));
  const d2 = db().documents.find((d) => d.id === id2);
  ok(dis.path === "/inquiries/reception" && d2.status === "discarded" && R.receptionMetaOf(d2).decision?.note === "回線の営業電話" && db().commLogs.length === logs, "記録しないで閉じる (やりとりは増えない・理由を残す)");

  const nishiStaff = db().users.find((u) => u.active && u.storeId === "nishi" && u.role === "store_staff");
  const peek = await act(nishiStaff, () => actions.registerReception(form({ id: id2, intent: "save" })));
  ok(peek.err, "ほかの店舗の受付は操作できない");
}
{
  // 書類取込の画面からは受付メモを取り込まない
  const r = await act(koshiStaff, () => capture.uploadDocument(form({ kind: "reception", storeId: "koshi", sampleName: "x.jpg" })));
  ok(r.err?.includes("問合せ登録"), "書類取込で「受付メモ」を選ぶと問合せ登録の画面へ案内する");
}

/* ================================================================== */
section("4. AI (モックの OpenAI): 手書きメモの写真");
aiOn();
{
  requests.length = 0;
  chatHandler = () => ({ callType: "new_inquiry", callTypeReason: "見積の依頼", customerName: "写真 花子", phone: "090-8199-0001", address: "熊本県合志市幾久富 1-2", category: "網戸", summary: "網戸4枚の張替え", detail: "網戸4枚。来週見積", mediaText: "チラシ", memoText: "写真花子様\n090-8199-0001\n網戸4枚", uncertainFields: ["phone"], warnings: ["電話番号の 1 桁が読みにくい"] });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const r = await act(koshiStaff, () => actions.createReception(form({ source: "photo", channel: "event", storeId: "koshi", file: new File([png], "memo.png", { type: "image/png" }) })));
  ok(r.msg?.includes("OpenAI"), "写真を AI で読み取る");
  const sent = requests.find((q) => q.path.endsWith("/chat/completions"));
  ok(sent && sent.raw.includes("image_url") && sent.raw.includes("ichijoya_reception"), "写真と受付の項目の形を AI に渡す");
  const id = r.path.split("/").pop();
  const doc = db().documents.find((d) => d.id === id);
  const f = R.receptionFieldsOf(doc);
  eq([f.customerName, f.category, f.summary, f.uncertainFields], ["写真 花子", "網戸", "網戸4枚の張替え", ["phone"]], "AI の読み取った項目");
  ok(doc.extracted._ai?.customerName === "写真 花子", "AI の読んだままの値を残す (読み取りの正確さの確認用)");
  const att = db().attachments.find((a) => a.parentType === "document" && a.parentId === id);
  ok(att, "元の写真を受付の添付ファイルに保存");
  const m = R.matchReception(db(), koshiStaff, f);
  eq([m.suggestion.action, m.suggestion.customerId], ["inquiry", undefined], "新しいお客様の問い合わせを提案");
  // 新しいお客様: 「新規顧客として登録」でその場で顧客を保存してから、問い合わせを登録する (お客様のご要望 2026-11-25)
  const nc = await act(koshiStaff, () => actions.registerReception(form({ id, quick: "new", channel: "event", customerName: "写真 花子", phone: "090-8199-0001", address: "熊本県合志市幾久富 1-2", summary: "網戸4枚の張替え", category: "網戸", confirmedUncertain: "on" })));
  const ncId = R.receptionMetaOf(db().documents.find((d) => d.id === id)).customerId;
  ok(!nc.err && ncId && db().customers.find((c) => c.id === ncId)?.address === "熊本県合志市幾久富 1-2", `新規顧客として登録 (住所・電話を顧客に) (${nc.msg ?? nc.err})`);
  const reg = await act(koshiStaff, () => actions.registerReception(form({ id, intent: "inquiry", channel: "event", customerName: "写真 花子", phone: "090-8199-0001", address: "熊本県合志市幾久富 1-2", summary: "網戸4枚の張替え", category: "網戸", media: "event", confirmedUncertain: "on" })));
  const inq = db().inquiries.find((i) => i.id === reg.path?.split("/").pop());
  ok(inq && inq.customerId === ncId && inq.contactName === "写真 花子" && inq.channel === "event", "新しいお客様の問い合わせとして登録 (お客様の履歴に残る)");
  const moved = db().attachments.find((a) => a.id === att.id);
  ok(moved.parentType === "inquiry" && moved.parentId === inq.id, "元の写真は問い合わせの資料・写真に付け替える");
  ok(db().commLogs.some((c) => c.relatedId === inq.id && c.body.includes("メモの文字") && c.body.includes("網戸4枚")), "やりとりの記録にメモの文字を残す");
}
{
  // 文章も AI で読み取る (AI が失敗したら言葉の規則で下書き)
  chatHandler = () => ({ callType: "existing_case", customerName: "受付 一郎", phone: "090-8101-0001", summary: "納品時間の確認", caseHint: "来月の引取" });
  const r = await act(koshiStaff, () => actions.createReception(form({ source: "text", text: "受付さんから納品時間の確認の電話" })));
  const f = R.receptionFieldsOf(db().documents.find((d) => d.id === r.path.split("/").pop()));
  eq([f.callType, f.summary], ["existing_case", "納品時間の確認"], "文章を AI で読み取る");
}

/* ================================================================== */
section("5. 通話の録音と電話のシステム");
{
  const audio = await imp("app/api/reception/audio/route.ts");
  const post = (user, fd) => {
    globalThis.__testUser = user;
    return audio.POST(new Request("http://127.0.0.1:3000/api/reception/audio", { method: "POST", body: fd })).finally(() => (globalThis.__testUser = undefined));
  };
  const wav = new File([Buffer.alloc(2000, 1)], "call.wav", { type: "audio/wav" });
  eq((await post(null, form({ file: wav }))).status, 401, "ログインしていないと 401");
  sttText = "お電話ありがとうございます一畳屋です。あ、受付一郎です。090-8101-0001。12月1日の引取なんですけど3日にしてもらえますか";
  chatHandler = () => ({ callType: "existing_case", customerName: "受付 一郎", phone: "090-8101-0001", summary: "引取を12/3に変更" });
  const res = await post(koshiStaff, form({ file: wav, channel: "phone", storeId: "koshi" }));
  const body = await res.json();
  ok(res.status === 200 && body.href?.startsWith("/inquiries/reception/"), "録音を文字にして受付に入れる");
  const doc = db().documents.find((d) => d.id === body.href.split("/").pop());
  ok(doc && R.receptionMetaOf(doc).source === "audio" && R.receptionMetaOf(doc).text?.includes("3日にしてもらえますか"), "文字起こしを受付に残す (録音の本体は保存しない)");
  ok(!db().attachments.some((a) => a.parentId === doc.id), "録音のファイルは添付ファイルにしない");
  const big = new File([Buffer.alloc(10 * 1024 * 1024)], "long.wav", { type: "audio/wav" });
  eq((await post(koshiStaff, form({ file: big }))).status, 413, "9.5 MB を超える録音は断る");
  eq((await post(koshiStaff, form({ file: new File([Buffer.alloc(10)], "x.txt", { type: "text/plain" }) }))).status, 415, "音声でないファイルは断る");
}
{
  const phone = await imp("app/api/integrations/phone-call/route.ts");
  const call = (body, token = "phone-secret-1") => phone.POST(new Request("http://127.0.0.1:3000/api/integrations/phone-call", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
  eq((await call({})).status, 503, "鍵の設定がなければ受け付けない");
  process.env.PHONE_INTAKE_SECRET = "phone-secret-1";
  eq((await call({}, "wrong")).status, 401, "鍵が違えば 401");
  const skipped = await (await call({ callId: "c-0", from: "+819081010001", transcript: "もしもし" })).json();
  eq(skipped.skipped, "no transcript", "短い通話 (無言・すぐ切れた) は登録しない");
  chatHandler = () => ({ callType: "new_inquiry", customerName: "電話 太郎", summary: "障子の張替え", category: "障子" });
  const before = db().documents.length;
  const r = await (await call({ callId: "c-1", from: "+819081770001", to: koshi.phone || "096-000-0000", direction: "inbound", startedAt: "2026-11-21T10:00:00+09:00", duration: 95, transcript: [{ speaker: "customer", text: "障子の張替えをお願いしたいんですが、6枚あります" }, { speaker: "agent", text: "かしこまりました" }] })).json();
  ok(r.ok && r.receptionId === "doc_call_c-1" && db().documents.length === before + 1, "通話の内容を確認待ちの受付にする");
  const doc = db().documents.find((d) => d.id === "doc_call_c-1");
  const f = R.receptionFieldsOf(doc);
  const meta = R.receptionMetaOf(doc);
  eq([f.phone, meta.source, meta.call?.durationSec, doc.uploadedBy], ["090-8177-0001", "phone_api", 95, "system"], "発信元の番号 (+81) を電話番号に・通話の長さ・取り込みはシステム");
  ok(meta.text?.includes("お客様: 障子の張替え"), "会話の配列を文字起こしにする");
  if (koshi.phone) eq(doc.storeId, "koshi", "かかってきた番号 (店舗の電話) で店舗を決める");
  eq(db().inquiries.filter((i) => i.sourceRef === "reception:doc_call_c-1").length, 0, "AI の判定だけでは問い合わせにしない (人が確かめてから)");
  const dup = await (await call({ callId: "c-1", from: "+819081770001", transcript: "障子の張替えをお願いしたいんですが、6枚あります" })).json();
  ok(dup.duplicate && db().documents.length === before + 1, "同じ通話 ID は 1 件だけ");
}
aiOff();

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
server.close();
fs.rmSync(work, { recursive: true, force: true });
