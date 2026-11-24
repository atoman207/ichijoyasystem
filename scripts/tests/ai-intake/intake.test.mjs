/**
 * 既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) との統合のテスト
 *   node scripts/tests/ai-intake/intake.test.mjs   (npm run test:intake)
 * 1. 項目の読み取り (システムごとの名前の違い・+81 の電話番号・会話の配列・きっかけ)
 * 2. 受付の登録 (顧客の照合・会話の記録・受け取った項目・再送・引き継ぎの方法と引き継ぎ先)
 * 3. 対応履歴と顧客情報の関連付け (あとから顧客にひも付け・顧客として登録 = Server Action の本物)
 * 4. 引き継ぎの業務依頼 (確認・報告で問い合わせが対応中・システムの依頼は依頼先が完了にできる)
 * 5. 受信の入口 POST /api/integrations/ai-intake (鍵・本文・再送)
 * データは一時フォルダーの JSON (サンプルデータ)。外部への送信の設定は消す (送らない)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-intake-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "intake-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-intake",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_|AI_INTAKE_)/.test(k)) delete process.env[k];
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

/** 社員 user として Server Action を呼ぶ (redirect の msg / err を返す) */
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
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) fd.set(k, String(v));
  return fd;
};

const store = await imp("lib/db/store.ts");
const I = await imp("lib/ai-intake.ts");
const P = await imp("lib/auth/permissions.ts");
const Q = await imp("lib/db/queries.ts");
const inquiryActions = await imp("lib/actions/inquiries.ts");
const messageActions = await imp("lib/actions/messages.ts");
const media = await imp("lib/media.ts");
await store.syncDb();
const db = () => store.getDb();

const nowIso = new Date().toISOString();
const admin = db().users.find((u) => u.role === "admin" && u.active);
const koshi = db().stores.find((s) => s.id === "koshi");
const koshiManager = db().users.find((u) => u.id === koshi.managerUserId && u.active);
const koshiStaff = db().users.find((u) => u.active && u.storeId === "koshi" && u.role === "store_staff");
ok(admin && koshiManager && koshiStaff, "サンプルデータ: 管理者・合志店の店長と社員がいる");

// 照合用のお客様 (サンプルデータと重ならない番号)
await store.mutate((d) => {
  const base = { kana: "", type: "individual", postalCode: "", address: "", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: nowIso, updatedAt: nowIso };
  d.customers.push({ ...base, id: "cust_ik1", code: "C-IK1", name: "統合 一郎", phone: "090-7001-0001", email: "ichiro@example.jp", storeId: "koshi", updatedAt: "2031-01-02T00:00:00Z" });
  d.customers.push({ ...base, id: "cust_ik2", code: "C-IK2", name: "統合 花子", phone: "096-700-0002", contacts: [{ relation: "夫", name: "統合 次郎", phone: "080-7002-0002" }], storeId: "chuo" });
  d.customers.push({ ...base, id: "cust_ik3", code: "C-IK3", name: "停止 三郎", phone: "090-7003-0003", storeId: "nishi", tradeStopped: true });
  d.customers.push({ ...base, id: "cust_ik4a", code: "C-IK4A", name: "同番 古", phone: "090-7004-0004", storeId: "koshi", updatedAt: "2030-01-01T00:00:00Z" });
  d.customers.push({ ...base, id: "cust_ik4b", code: "C-IK4B", name: "同番 新", phone: "090-7004-0004", storeId: "koshi", updatedAt: "2031-06-01T00:00:00Z" });
});

/* ================================================================== */
section("1. 項目の読み取り (normalizeIntake・domesticPhone)");
eq(I.domesticPhone("+81 90-1234-5678"), "090-1234-5678", "+81 90-… → 090-…");
eq(I.domesticPhone("+819012345678"), "090-1234-5678", "+81 の続け書き (E.164)");
eq(I.domesticPhone("0081312345678"), "0312345678", "0081 の固定電話");
eq(I.domesticPhone("819012345678"), "090-1234-5678", "+ のない 81…");
eq(I.domesticPhone("+81 (0)96-123-4567"), "0961234567", "+81 (0)96 の書き方");
eq(I.domesticPhone("tel:+81-96-123-4567"), "0961234567", "tel: の形");
eq(I.domesticPhone("096-123-4567"), "096-123-4567", "国内の番号はそのまま");
eq(I.domesticPhone("０９０－１２３４－５６７８"), "090－1234－5678".normalize("NFKC"), "全角の番号は半角に");
eq(I.domesticPhone("U4af4980629a1b2c3d4e5f6"), undefined, "チャットの利用者 ID は電話番号にしない");
eq(I.domesticPhone("123"), undefined, "桁の足りない値は電話番号にしない");

{
  // Twilio などの電話の Webhook (項目名が大文字・+81)
  const { input } = I.normalizeIntake({ CallSid: "CA123abc", From: "+819070010001", SpeechResult: "x", summary: "6畳の表替えの見積がほしい", urgency: "high" }, "phone");
  eq(input.source, "ai_phone", "?source=phone → AI 電話受付");
  eq(input.externalId, "CA123abc", "CallSid を受付 ID に");
  eq(input.phone, "090-7001-0001", "From (+81) を国内の番号に");
  eq(input.urgency, "high", "緊急度 high");
}
{
  // 入れ子・日本語の項目名・会話の配列・きっかけ
  const { input } = I.normalizeIntake({
    type: "chat",
    session_id: "s-55",
    customer: { お名前: "統合 太郎", ふりがな: "とうごう たろう", メール: "taro@example.jp", 住所: "熊本県合志市須屋 1-2", 郵便番号: "861-1102" },
    messages: [{ role: "user", content: "網戸の張替えをお願いしたい" }, { role: "assistant", content: "承知しました。ご希望の日は？" }, { role: "user", content: "来週の土曜" }],
    希望日: "来週の土曜",
    きっかけ: "チラシ",
  });
  eq(input.source, "ai_chat", "本文の type=chat → AI テキスト相談");
  eq(input.name, "統合 太郎", "customer.お名前 (入れ子・日本語)");
  eq(input.kana, "とうごう たろう", "ふりがな");
  eq(input.email, "taro@example.jp", "メール");
  eq(input.postalCode, "861-1102", "郵便番号");
  ok(input.transcript?.startsWith("お客様: 網戸の張替え") && input.transcript.includes("AI: 承知しました"), "会話の配列をお客様 / AI の行にする");
  eq(input.mediaText, "チラシ", "当社を知ったきっかけ");
}
{
  const { input } = I.normalizeIntake({ source: "line", from: "U4af4980629a1b2c3d4e5f6", message: "畳の相談" });
  eq(input.phone, undefined, "LINE の利用者 ID (from) は電話番号にしない");
  eq(input.senderId, "U4af4980629a1b2c3d4e5f6", "送信元 ID として残す");
}
ok(I.normalizeIntake({ summary: "x" }).error?.includes("source"), "入口の分からない受付は断る");
ok(I.normalizeIntake({ name: "a" }, "voice").error?.includes("summary"), "内容のない受付は断る");
eq(I.normalizeIntake({ summary: "x" }, "音声").input?.source, "ai_voice", "?source=音声 → AI 音声相談");
eq(I.normalizeIntake({ summary: "x", recordingUrl: "http://x" }, "voice").input?.recordingUrl, undefined, "録音は https だけ");

/* ================================================================== */
section("2. 受付の登録 (recordAiIntake)");
const record = (payload, hint) => store.mutate((d) => I.recordAiIntake(d, I.normalizeIntake(payload, hint).input));
const before = db().inquiries.length;

const r1 = await record({ CallSid: "CA-001", From: "+819070010001", name: "統合 一郎", purpose: "6畳の畳の表替え", transcript: "お客様: 6畳の表替えをお願いしたい\nAI: 承知しました", desiredDate: "11/25 午前", media: "チラシ" }, "phone");
const inq1 = db().inquiries.find((i) => i.id === r1.inquiry.id);
ok(r1.created && db().inquiries.length === before + 1, "問い合わせを 1 件登録");
eq(inq1.channel, "ai_phone", "入口 = AI 電話受付");
eq(inq1.customerId, "cust_ik1", "+81 の番号で既存のお客様にひも付く");
eq(inq1.storeId, "koshi", "店舗はお客様の店舗");
eq(inq1.category, "tatami", "種別は用件から (畳)");
eq(inq1.media, "flyer", "きっかけ「チラシ」→ 媒体 = チラシ");
eq(inq1.intake?.desiredDate, "11/25 午前", "受け取った項目 (希望日) を問い合わせに持つ");
eq(inq1.intake?.externalId, "CA-001", "受付 ID");
ok(inq1.detail.includes("希望日: 11/25 午前") && inq1.detail.includes("受付 ID: CA-001"), "内容にも用件・希望日・受付 ID を書く");
const log1 = db().commLogs.find((c) => c.relatedType === "inquiry" && c.relatedId === inq1.id);
ok(log1 && log1.customerId === "cust_ik1" && log1.channel === "ai_phone" && log1.body.includes("6畳の表替えをお願いしたい"), "会話の記録をお客様のやりとり履歴に残す");
ok(Q.customerTimeline(db(), "cust_ik1").comms.some((c) => c.id === log1.id), "顧客の画面のやりとり履歴に出る");
eq(inq1.nextAction, "折返しの電話", "次のアクション = 折返しの電話");

// 再送 (同じ受付 ID)
const r1b = await record({ CallSid: "CA-001", From: "+819070010001", purpose: "6畳の畳の表替え" }, "phone");
ok(r1b.duplicate && !r1b.created && r1b.inquiry.id === inq1.id && db().inquiries.length === before + 1, "同じ受付 ID の再送は登録しない (最初の受付を返す)");
eq(db().threads.filter((t) => t.relatedId === inq1.id).length, 1, "再送で引き継ぎを重ねない");

// 受付 ID のないシステムの再送 (同じ内容)
const noId = { phone: "090-7999-0001", summary: "ふすま 4 枚の張替え", detail: "来週中に見積に来てほしい" };
const r2 = await record(noId, "chat");
const r2b = await record(noId, "chat");
ok(r2.created && r2b.duplicate && r2b.inquiry.id === r2.inquiry.id, "受付 ID がなくても同じ内容の再送は 1 件");
const r2c = await record({ ...noId, detail: "再来週でもよい" }, "chat");
ok(r2c.created && r2c.inquiry.id !== r2.inquiry.id, "内容が違えば別の受付");
eq(db().inquiries.find((i) => i.id === r2.inquiry.id).nextAction, "お客様へ返信・連絡", "AI テキスト相談の次のアクション = 返信・連絡");

// ご家族の連絡先・名乗ったお名前の違い
const r3 = await record({ id: "v-3", phone: "080-7002-0002", name: "統合 次郎", summary: "障子の張替え" }, "voice");
const inq3 = db().inquiries.find((i) => i.id === r3.inquiry.id);
eq(inq3.customerId, "cust_ik2", "ご家族 (夫) の連絡先の番号でもお客様にひも付く");
eq(inq3.storeId, "chuo", "店舗はお客様の店舗 (中央店)");
ok(inq3.detail.includes("夫") && inq3.detail.includes("名乗ったお名前: 統合 次郎"), "家族の連絡先との一致と名乗ったお名前を内容に書く");
eq(inq3.intake?.name, "統合 次郎", "名乗ったお名前は受け取った項目に残す");
eq(inq3.contactName, "統合 花子", "問い合わせのお客様名は登録のお客様");

// 取引停止・複数の一致
const r4 = await record({ id: "p-4", phone: "09070030003", summary: "畳の新調" }, "phone");
ok(db().inquiries.find((i) => i.id === r4.inquiry.id).detail.includes("取引停止"), "取引停止のお客様は内容に注意を書く");
const r5 = await record({ id: "p-5", phone: "090-7004-0004", summary: "畳の表替え" }, "phone");
const inq5 = db().inquiries.find((i) => i.id === r5.inquiry.id);
ok(inq5.customerId === "cust_ik4b" && r5.candidates === 2 && inq5.detail.includes("2 件") && inq5.intake?.matchedCount === 2, "同じ番号のお客様が 2 件 → 最近更新したお客様 + 件数を書く");

// メールでの照合・店舗の指定
const r6 = await record({ id: "c-6", email: "ICHIRO@example.jp", summary: "網戸", store: "玉名店" }, "chat");
const inq6 = db().inquiries.find((i) => i.id === r6.inquiry.id);
ok(inq6.customerId === "cust_ik1" && inq6.storeId === "tamana", "メール (大文字小文字を区別しない) で照合・店舗名の指定 (玉名店) を優先");

// 未登録のお客様
const r7 = await record({ id: "p-7", From: "+81 90 7777 0007", name: "新規 七子", kana: "しんき ななこ", email: "nana@example.jp", postalCode: "861-1102", address: "熊本県合志市須屋 7-7", purpose: "和室 6 畳の畳の表替え", transcript: "お客様: 6畳の表替え\nAI: 承知しました" }, "phone");
const inq7 = db().inquiries.find((i) => i.id === r7.inquiry.id);
ok(!inq7.customerId && inq7.contactName === "新規 七子" && inq7.contactPhone === "090-7777-0007", "未登録のお客様: 名乗ったお名前・国内の形の電話で登録");
eq(inq7.storeId, I.aiIntakeSettings(db()).defaultStore, "店舗の分からない受付は既定の店舗");
const log7 = db().commLogs.find((c) => c.relatedType === "inquiry" && c.relatedId === inq7.id);
ok(log7 && !log7.customerId, "未登録のお客様の会話の記録は問い合わせにだけひも付く");

/* ---- 引き継ぎ ---- */
const t1 = db().threads.find((t) => t.relatedType === "inquiry" && t.relatedId === inq1.id);
ok(t1 && t1.kind === "request" && t1.taskStatus === "requested", "既定 (すべて引き継ぐ): 業務依頼を作る");
eq(t1.assigneeIds, [koshiManager.id], "引き継ぎ先 = 店舗の店長 (設定なし)");
eq(inq1.assignedUserId, koshiManager.id, "問い合わせの担当も引き継ぎ先");
eq(t1.createdBy, "system", "店長が引き継ぎ先のときの依頼者はシステム");
const m1 = db().messages.find((m) => m.threadId === t1.id);
ok(m1.userId === "system" && m1.body.includes("自動の依頼") && m1.body.includes(`/inquiries/${inq1.id}`), "依頼の文はシステムの名前で書き、問い合わせへのリンクを付ける");
ok(db().auditLogs.some((l) => l.entity === "thread" && l.entityId === t1.id && l.userId === "system"), "引き継ぎの変更履歴はシステム");

// 店舗ごとの引き継ぎ先の設定
await store.mutate((d) => {
  d.settings = d.settings.filter((s) => s.id !== I.AI_INTAKE_SETTINGS_ID);
  d.settings.push({ id: I.AI_INTAKE_SETTINGS_ID, value: { defaultStore: "hq", handoff: "always", assignees: { koshi: koshiStaff.id } }, updatedAt: nowIso, updatedBy: admin.id });
});
const r8 = await record({ id: "p-8", phone: "090-7001-0001", purpose: "畳の表替え", urgency: "緊急" }, "phone");
const t8 = db().threads.find((t) => t.relatedId === r8.inquiry.id);
ok(t8.assigneeIds[0] === koshiStaff.id && t8.createdBy === koshiManager.id, "設定した引き継ぎ先 (社員) に依頼・依頼者は店長 (報告を確認する人)");
eq(db().messages.find((m) => m.threadId === t8.id).userId, "system", "店長が依頼者でも、依頼の文はシステムの名前");
ok(t8.title.startsWith("【至急】") && db().inquiries.find((i) => i.id === r8.inquiry.id).nextAction.startsWith("至急"), "緊急の受付は依頼の件名・次のアクションに「至急」");

// AI が指定した担当者
const r9 = await record({ id: "p-9", phone: "090-7001-0001", purpose: "畳", assignee: admin.email }, "phone");
eq(db().threads.find((t) => t.relatedId === r9.inquiry.id).assigneeIds, [admin.id], "AI システムが指定した担当者 (メール) に引き継ぐ");

// 「引き継ぎが必要」なときだけ
await store.mutate((d) => {
  d.settings.find((s) => s.id === I.AI_INTAKE_SETTINGS_ID).value = { defaultStore: "hq", handoff: "requested", assignees: {} };
});
const r10 = await record({ id: "p-10", phone: "090-7001-0001", purpose: "畳" }, "phone");
ok(!db().threads.some((t) => t.relatedId === r10.inquiry.id), "requested: 引き継ぎの指定のない受付は依頼を作らない");
const r11 = await record({ id: "p-11", phone: "090-7001-0001", purpose: "畳", needs_handoff: "要" }, "phone");
ok(db().threads.some((t) => t.relatedId === r11.inquiry.id), "requested: AI が引き継ぎ必要とした受付は依頼を作る");
eq(db().inquiries.find((i) => i.id === r11.inquiry.id).intake?.handoffRequested, true, "AI の引き継ぎの判断を受け取った項目に残す");
const r12 = await record({ id: "p-12", phone: "090-7001-0001", purpose: "畳", priority: "high" }, "phone");
ok(db().threads.some((t) => t.relatedId === r12.inquiry.id), "requested: 緊急度が高い受付は依頼を作る");
await store.mutate((d) => {
  d.settings.find((s) => s.id === I.AI_INTAKE_SETTINGS_ID).value = { defaultStore: "hq", handoff: "never", assignees: {} };
});
const r13 = await record({ id: "p-13", phone: "090-7001-0001", purpose: "畳", handoff: true }, "phone");
ok(!db().threads.some((t) => t.relatedId === r13.inquiry.id), "never: 引き継がない (問い合わせの登録だけ)");

// 引き継ぎ先がどこにもないとき → 管理者
{
  const copy = structuredClone(db());
  copy.settings = copy.settings.filter((s) => s.id !== I.AI_INTAKE_SETTINGS_ID);
  for (const s of copy.stores) s.managerUserId = undefined;
  const target = I.handoffTarget(copy, "koshi", I.aiIntakeSettings(copy));
  ok(target && target.role === "admin", "店長・設定がどこにもないときは管理者に引き継ぐ (受付が埋もれない)");
}
await store.mutate((d) => {
  d.settings = d.settings.filter((s) => s.id !== I.AI_INTAKE_SETTINGS_ID);
});

/* ================================================================== */
section("3. 対応履歴と顧客情報の関連付け (あとからひも付け・顧客として登録)");
// 既存の顧客にひも付け: 会話の記録 (お客様なし) がお客様の履歴に移り、要約の記録を重ねない
const logsBefore = db().commLogs.filter((c) => c.relatedId === inq7.id).length;
const custExisting = "cust_ik1";
// 合志店のお客様にひも付けるため、問い合わせを合志店へ (店舗のロールで操作)
await store.mutate((d) => {
  d.inquiries.find((i) => i.id === inq7.id).storeId = "koshi";
});
const link = await act(koshiStaff, () => inquiryActions.linkInquiryToCustomer(inq7.id, custExisting));
ok(link.msg?.includes("紐づけました"), `既存の顧客に紐づける (${link.msg ?? link.err})`);
const after7 = db().commLogs.filter((c) => c.relatedId === inq7.id);
eq(after7.length, logsBefore, "会話の記録があるときは要約の記録を重ねない");
ok(after7.every((c) => c.customerId === custExisting), "AI の会話の記録がお客様にひも付く");
ok(Q.customerTimeline(db(), custExisting).comms.some((c) => c.id === log7.id), "顧客の画面のやりとり履歴に AI の会話が出る");

// 顧客として登録: 受け取った項目 (ふりがな・メール・住所) を顧客の情報に入れる
const r14 = await record({ id: "p-14", From: "+81 90 7777 0014", name: "登録 十四", kana: "とうろく じゅうし", email: "j14@example.jp", postalCode: "861-1102", address: "熊本県合志市須屋 14", purpose: "畳の表替え", transcript: "お客様: 表替え", store: "合志店" }, "phone");
const reg = await act(admin, () => inquiryActions.registerCustomerFromInquiry(r14.inquiry.id, form({})));
ok(reg.path?.startsWith("/customers/") && reg.path.endsWith("/edit"), `顧客として登録 → 顧客の編集へ (${reg.msg ?? reg.err})`);
const newCustId = reg.path.split("/")[2];
const nc = db().customers.find((c) => c.id === newCustId);
ok(nc && nc.name === "登録 十四" && nc.kana === "とうろく じゅうし" && nc.email === "j14@example.jp" && nc.postalCode === "861-1102" && nc.address === "熊本県合志市須屋 14" && nc.phone === "090-7777-0014", "名前・ふりがな・電話・メール・郵便番号・住所を AI 受付の項目から入れる");
eq(nc.firstContactChannel, "ai_phone", "最初の接点 = AI 電話受付");
const l14 = db().commLogs.filter((c) => c.relatedId === r14.inquiry.id);
ok(l14.length === 1 && l14[0].customerId === newCustId, "会話の記録が新しいお客様の履歴に移る (重ねない)");

// 重複の確認に AI 受付のメール・住所も使う
const r15 = await record({ id: "c-15", email: "j14@example.jp", name: "別名 十四", summary: "網戸", store: "合志店" }, "chat");
ok(r15.inquiry.customerId === newCustId, "登録したお客様のメールで、次の受付から自動でひも付く");

// 手入力の問い合わせ (記録なし) は、ひも付けたときに内容を 1 件残す (これまでどおり)
await store.mutate((d) => {
  d.inquiries.push({ id: "inq_manual_1", number: "INQ-2099-0001", contactName: "手入力 一", contactPhone: "090-7100-0001", channel: "phone", storeId: "koshi", category: "tatami", summary: "電話の相談", detail: "6畳", status: "new", receivedAt: nowIso, createdBy: koshiStaff.id, updatedAt: nowIso });
});
await act(koshiStaff, () => inquiryActions.linkInquiryToCustomer("inq_manual_1", custExisting));
const lm = db().commLogs.filter((c) => c.relatedId === "inq_manual_1");
ok(lm.length === 1 && lm[0].customerId === custExisting && lm[0].storeId === "koshi", "記録のない問い合わせは内容を 1 件残す (店舗つき)");

/* ================================================================== */
section("4. 引き継ぎの業務依頼の流れ");
eq(db().inquiries.find((i) => i.id === inq1.id).status, "new", "引き継いだ直後の問い合わせは新規");
const ack = await act(koshiManager, () => messageActions.taskStep(t1.id, "ack", form({})));
ok(ack.msg?.includes("確認しました"), "引き継ぎ先 (店長) が確認");
eq(db().inquiries.find((i) => i.id === inq1.id).status, "in_progress", "確認で問い合わせが対応中になる");
ok(db().auditLogs.some((l) => l.entity === "inquiry" && l.entityId === inq1.id && l.summary.includes("引き継ぎの確認")), "問い合わせの変更履歴に残る");
const rep = await act(koshiManager, () => messageActions.taskStep(t1.id, "report", form({ body: "折返しして 11/25 に現地調査を予約" })));
ok(rep.msg?.includes("報告"), "対応を報告");
ok(P.canConfirmTask(koshiManager, db().threads.find((t) => t.id === t1.id)), "システムの依頼は依頼先が自分で完了にできる");
ok(!P.canConfirmTask(koshiStaff, db().threads.find((t) => t.id === t1.id)), "依頼先でも依頼者でもない社員は完了にできない");
const conf = await act(koshiManager, () => messageActions.taskStep(t1.id, "confirm", form({})));
ok(conf.msg?.includes("完了"), `依頼先が完了にする (${conf.msg ?? conf.err})`);
eq(db().threads.find((t) => t.id === t1.id).taskStatus, "confirmed", "業務依頼は完了");
// 店長が依頼者の依頼は、依頼先は完了にできない (店長が報告を確かめる)
await act(koshiStaff, () => messageActions.taskStep(t8.id, "report", form({ body: "折返し済み" })));
const conf8 = await act(koshiStaff, () => messageActions.taskStep(t8.id, "confirm", form({})));
ok(conf8.err?.includes("依頼した人"), "店長が依頼者の依頼は、依頼先 (社員) が完了にできない");
const conf8b = await act(koshiManager, () => messageActions.taskStep(t8.id, "confirm", form({})));
ok(conf8b.msg?.includes("完了"), "依頼者 (店長) が報告を確かめて完了");
// 画面からの引き継ぎ (別の社員へ)
const ho = await act(koshiManager, () => inquiryActions.handoffInquiry(inq7.id, form({ assigneeId: koshiStaff.id, note: "明日午前に折返し", dueDate: "2031-11-26" })));
ok(ho.msg?.includes("依頼しました"), `問い合わせの画面から担当者に依頼する (以前の「引き継ぎ」の入力も使える: ${ho.msg ?? ho.err})`);
const tm = db().threads.filter((t) => t.relatedId === inq7.id).find((t) => t.createdBy === koshiManager.id);
ok(tm && db().messages.find((m) => m.threadId === tm.id)?.userId === koshiManager.id, "画面からの引き継ぎは操作した社員の名前で依頼");

/* ================================================================== */
section("5. 受信の入口 POST /api/integrations/ai-intake");
const route = await imp("app/api/integrations/ai-intake/route.ts");
const call = (body, { token, query = "source=phone", type = "application/json" } = {}) =>
  route.POST(new Request(`http://127.0.0.1:3000/api/integrations/ai-intake?${query}`, { method: "POST", headers: { "content-type": type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) }));
eq((await call({ summary: "x" })).status, 503, "共有鍵が未設定なら 503 (受け付けない)");
process.env.AI_INTAKE_SECRET = "intake-secret-123";
eq((await call({ summary: "x" }, { token: "wrong" })).status, 401, "鍵が違えば 401");
eq((await call("not json{", { token: "intake-secret-123", type: "text/plain" })).status, 400, "本文が読めなければ 400");
eq((await call({ name: "a" }, { token: "intake-secret-123" })).status, 400, "内容がなければ 400");
const res = await call({ callId: "R-1", callerNumber: "+819070010001", summary: "畳の表替えの相談", handoff: true }, { token: "intake-secret-123" });
const body = await res.json();
ok(res.status === 200 && body.ok && body.number && body.customerMatched === true, "受付を登録して番号と顧客の一致を返す");
ok(body.handoff?.assignee && body.handoff.taskId, "引き継ぎ先と業務依頼を返す");
const again = await (await call({ callId: "R-1", callerNumber: "+819070010001", summary: "畳の表替えの相談" }, { token: "intake-secret-123" })).json();
ok(again.duplicate && again.number === body.number && again.handoff?.taskId === body.handoff.taskId, "再送は duplicate と最初の受付・引き継ぎを返す");
const viaToken = await route.POST(new Request("http://127.0.0.1:3000/api/integrations/ai-intake?source=voice&token=intake-secret-123", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id: "F-1", phone: "0970000001", summary: "障子の張替え" }).toString() }));
ok(viaToken.status === 200 && (await viaToken.json()).number, "フォーム形式・URL の token でも受け付ける (ヘッダーを設定できないシステム)");
const delivered = db().deliveries.filter((d) => d.relatedType === "thread" && d.relatedId === body.handoff.taskId);
ok(delivered.every((d) => d.status !== "sent"), `送信の設定がないときは送らない (送信履歴 ${delivered.length} 件・すべて未送信)`);
delete process.env.AI_INTAKE_SECRET;

/* ================================================================== */
section("6. 媒体の読み替え");
eq(media.mapMediaText(media.readMediaRules(db()).rules, "チラシ"), "flyer", "「チラシ」は媒体のチラシ");
const r16 = await record({ id: "p-16", phone: "090-7001-0001", purpose: "畳", media: "宇宙人から聞いた" }, "phone");
const inq16 = db().inquiries.find((i) => i.id === r16.inquiry.id);
ok(!inq16.media && inq16.intake?.mediaText === "宇宙人から聞いた" && inq16.detail.includes("読み替えられませんでした"), "読み替えられないきっかけは媒体を空にして内容に書く (人が選ぶ)");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
