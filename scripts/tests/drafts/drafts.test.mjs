// 実行: npm run test:drafts (または node scripts/tests/drafts/drafts.test.mjs)
// 文書の下書きの管理 (AI アシスタント →「文書の作成」の保存・版・確認 → 承認 → 送信・差し戻し・破棄・複製) の回帰テスト:
// 状態の進み方と権限 (作成者は承認できない・店長は自店舗・管理者は省略できる)・承認のあとの修正で下書きに戻る・
// 送信できるのは承認済みだけ・版の違い・閲覧範囲 (画面と AI の SQL)・承認者の決め方・社内資料の見られる人 (文書の作成に渡す資料)。
// データは一時フォルダーの JSON (サンプルデータ)。AI はローカルのモックのサーバー (本物の AI・外部の送信には接続しない)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-drafts-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?(OPEN_?AI|OPEN_?API|ANTHROPIC|CLAUDE|AI_API)[A-Z0-9_]*(KEY|BASE_URL)$/i.test(k) || k === "AI_PROVIDER" || k === "OPENAI_MODEL") delete process.env[k];
}
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SMTP_HOST", "RESEND_API_KEY", "SENDGRID_API_KEY", "CHATWORK_API_TOKEN", "CHATWORK_ROOM_ID", "LINE_CHANNEL_ACCESS_TOKEN"]) delete process.env[k];
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "drafts-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  DB_CACHE_DIR: path.join(work, "cache"),
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "ichijoya-data.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  BACKUP_DIR: path.join(work, "backups"),
  BACKUP_STATUS_FILE: path.join(work, "backup-status.json"),
  TZ: "Asia/Tokyo",
});
process.chdir(work);
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
const imp = (p) => jiti.import(path.join(root, "src", p));

let pass = 0;
let failn = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    failn++;
    fails.push(msg);
    console.log("  ✗", msg);
  }
}
const eq = (a, b, msg) => {
  const c = JSON.stringify(a) === JSON.stringify(b);
  ok(c, c ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};
const section = (t) => console.log("\n■ " + t);
const throws = (fn, re, msg) => {
  try {
    fn();
    ok(false, `${msg} (断られなかった)`);
  } catch (e) {
    ok(e?.name === "DocDraftError" && (!re || re.test(e.message)), re && !re.test(e?.message ?? "") ? `${msg} (got ${e?.message})` : msg);
  }
};

const store = await imp("lib/db/store.ts");
const P = await imp("lib/auth/permissions.ts");
const PT = await imp("lib/auth/permission-table.ts");
const D = await imp("lib/doc-drafts.ts");
const EV = await imp("lib/notify/events.ts");
const MODEL = await imp("lib/datastore/model.ts");
const SCHEMA = await imp("lib/db/schema.ts");
const MIG = await imp("lib/db/migrate.ts");
const DRAFT = await imp("lib/ai/draft.ts");

const db = store.getDb();
const active = (pred) => db.users.find((u) => u.active && pred(u));
const admin = active((u) => u.role === "admin");
const hq = active((u) => u.role === "hq_staff");
const koshiMgr = active((u) => u.role === "store_manager" && u.storeId === "koshi");
const chuoMgr = active((u) => u.role === "store_manager" && u.storeId === "chuo");
const koshiStaff = active((u) => u.role === "store_staff" && u.storeId === "koshi");
const chuoStaff = active((u) => u.role === "store_staff" && u.storeId === "chuo");
ok(admin && hq && koshiMgr && chuoMgr && koshiStaff && chuoStaff, "サンプルデータに各ロールの社員がいる");
const order = db.orders.find((o) => o.storeId === "koshi" && o.customerId && db.customers.some((c) => c.id === o.customerId));
ok(Boolean(order), "合志店の受注がある");

/* ================================================================== */
section("データ: 表の定義・読み込み時の補完");
{
  const def = SCHEMA.TABLES.find((t) => t.collection === "docDrafts");
  ok(def && def.table === "doc_drafts", "schema.ts に doc_drafts がある");
  const cols = new Set(def.columns.map(([f]) => f));
  const sample = { id: 1, number: 1, title: 1, template: 1, format: 1, audience: 1, subject: 1, body: 1, status: 1, storeId: 1, refs: 1, provider: 1, notes: 1, version: 1, versions: 1, events: 1, createdBy: 1, createdAt: 1, updatedBy: 1, updatedAt: 1, reviewedBy: 1, reviewedAt: 1, approvedBy: 1, approvedAt: 1, sentBy: 1, sentAt: 1, channel: 1, recipient: 1, recipientLabel: 1, deliveryIds: 1, commLogId: 1, copiedFrom: 1 };
  const missing = Object.keys(sample).filter((k) => !cols.has(k));
  eq(missing, [], "DocDraft のすべての項目に列がある");
  const old = { ...db, meta: { version: 3 } };
  delete old.docDrafts;
  MIG.migrateDb(old);
  ok(Array.isArray(old.docDrafts), "docDrafts のない古いデータは読み込み時に空の一覧を作る");
  ok(Array.isArray(db.docDrafts), "サンプルデータに docDrafts がある");
}

/* ================================================================== */
section("作成: 件名の分け方・関係する記録・版 1");
let d;
{
  eq(D.splitSubject("email", "件名: お見積書の送付\n\n山田様\n本文"), { subject: "お見積書の送付", body: "山田様\n本文" }, "メールの 1 行目の「件名:」を件名に分ける");
  eq(D.splitSubject("line", "件名: x\n本文"), { body: "件名: x\n本文" }, "LINE は件名を分けない");
  const facts = DRAFT.factsByRef(db, koshiStaff, order.number);
  ok(facts && facts.href === `/orders/${order.id}`, "番号から記録を探せる (自店舗)");
  ok(DRAFT.factsByRef(db, chuoStaff, order.number) === null, "ほかの店舗の記録は番号で探せない");
  const r = D.draftRefs(db, koshiStaff, { label: facts.label, href: facts.href });
  eq(r.refs.map((x) => x.type), ["order", "customer"], "関係する記録 = 受注とそのお客様");
  eq(r.storeId, "koshi", "文書の店舗 = 記録の店舗");
  eq(D.draftRefs(db, hq).storeId, hq.storeId, "記録がないときは作成者の店舗");
  d = D.createDocDraft(db, koshiStaff, { template: "schedule", templateLabel: "施工日程のご連絡", format: "email", audience: "customer", subject: "施工日程のご連絡", body: "○○ 様\n\n施工日は 11/26 です。\nよろしくお願いいたします。", provider: "rules", refs: r.refs, storeId: r.storeId });
  ok(/^DOC-\d{4}-0001$/.test(d.number), `文書番号 ${d.number}`);
  eq([d.status, d.version, d.versions.length, d.events[0].action], ["draft", 1, 1, "create"], "下書き・第 1 版・作成の記録");
  ok(d.title.includes(order.number), "名前に記録の番号が入る");
  const d2 = D.createDocDraft(db, koshiStaff, { template: "free", templateLabel: "自由に作成", format: "document", audience: "internal", body: "社内メモ", provider: "rules", refs: [], storeId: "koshi" });
  ok(d2.number.endsWith("0002"), "番号は連番");
  throws(() => D.createDocDraft(db, koshiStaff, { template: "free", templateLabel: "x", format: "document", audience: "internal", body: "  ", provider: "rules", refs: [], storeId: "koshi" }), /空/, "空の文面は保存しない");
}

/* ================================================================== */
section("権限: 見られる範囲・直せる人");
{
  ok(P.canViewDocDraft(koshiStaff, d) && P.canViewDocDraft(koshiMgr, d), "同じ店舗の人は見られる");
  ok(!P.canViewDocDraft(chuoStaff, d) && !P.canViewDocDraft(chuoMgr, d), "ほかの店舗の人は見られない");
  ok(P.canViewDocDraft(hq, d) && P.canViewDocDraft(admin, d), "本部・管理者は全店舗の文書を見られる");
  ok(P.canViewDocDraft(chuoStaff, { ...d, createdBy: chuoStaff.id }), "自分が作った文書は店舗が違っても見られる");
  const colleague = db.users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi" && u.id !== koshiStaff.id);
  if (colleague) ok(!P.canEditDocDraft(colleague, d) && P.canReviewDocDraft(colleague, d), "同じ店舗のほかのスタッフは確認はできるが直せない");
  ok(P.canEditDocDraft(koshiStaff, d) && P.canEditDocDraft(koshiMgr, d) && P.canEditDocDraft(hq, d), "作成者・店長・本部は直せる");
  const rows = PT.PERMISSION_TABLE.filter((r) => r.action.includes("文書"));
  ok(rows.length >= 4, "設定の権限一覧に文書の行がある");
}

/* ================================================================== */
section("修正: 版が増える・同じ文面は増やさない");
{
  const same = D.editDocDraft(d, koshiStaff, { subject: d.subject, body: d.body });
  eq([same.changed, d.version], [false, 1], "同じ文面は版を増やさない");
  const r = D.editDocDraft(d, koshiStaff, { subject: d.subject, body: `${d.body}\n駐車場を 1 台分お願いします。`, note: "駐車場のお願いを追加" });
  eq([r.changed, r.reset, d.version, d.versions.length, d.versions[1].source, d.versions[1].note], [true, false, 2, 2, "edit", "駐車場のお願いを追加"], "修正で第 2 版");
  ok(r.changes.some((c) => c.field === "body"), "変更履歴に本文の変更 (文字数) を残す");
  throws(() => D.editDocDraft(d, chuoMgr, { body: "x" }), /権限/, "ほかの店舗の店長は直せない");
}

/* ================================================================== */
section("確認 → 承認: 作成者は承認できない・店長は自店舗");
{
  throws(() => D.transitionDocDraft(d, koshiMgr, "approve"), /確認済み/, "下書きのままは承認できない");
  D.transitionDocDraft(d, koshiStaff, "review");
  eq([d.status, d.reviewedBy], ["reviewed", koshiStaff.id], "作成者が「内容を確認した」→ 確認済み");
  ok(!P.canApproveDocDraft(koshiStaff, d), "作成者 (店舗スタッフ) は承認できない");
  ok(!P.canApproveDocDraft(chuoMgr, d), "ほかの店舗の店長は承認できない");
  ok(P.canApproveDocDraft(hq, d) && P.canApproveDocDraft(admin, d) && P.canApproveDocDraft(koshiMgr, d), "その店舗の店長・本部・管理者は承認できる");
  const att = D.docDraftAttention(db, koshiMgr);
  ok(att.toApprove.some((x) => x.id === d.id), "店長のヘッダーの知らせに承認待ちとして出る");
  ok(!D.docDraftAttention(db, chuoMgr).toApprove.some((x) => x.id === d.id), "ほかの店舗の店長には出ない");
  const approvers = D.docDraftApprovers(db, d);
  ok(approvers.length > 0 && approvers.every((u) => u.role === "store_manager" && u.storeId === "koshi" && u.id !== d.createdBy), "承認を頼む相手 = その店舗の店長 (作成者を除く)");
  const hqDraft = { ...d, storeId: "hq", createdBy: hq.id };
  ok(D.docDraftApprovers(db, hqDraft).every((u) => (u.role === "admin" || u.role === "hq_staff") && u.id !== hq.id), "本部の文書は本部スタッフ・管理者に頼む (作成者を除く)");
  ok(Array.isArray(EV.docDraftReviewNotices(db, d, approvers)), "承認の依頼の知らせを作れる");
  D.transitionDocDraft(d, koshiMgr, "approve", "OK です");
  eq([d.status, d.approvedBy, d.events.at(-1).action, d.events.at(-1).comment], ["approved", koshiMgr.id, "approve", "OK です"], "店長が承認 → 承認済み (コメントを残す)");
  eq(EV.docDraftResultNotices(db, d, koshiStaff.id, "approved"), [], "自分の操作の結果は自分に知らせない");
}

/* ================================================================== */
section("承認のあとの修正: 下書きに戻る (承認した文面 = 送る文面)");
{
  const r = D.editDocDraft(d, koshiStaff, { subject: d.subject, body: d.body.replace("11/26", "11/27") });
  eq([r.reset, d.status, d.reviewedBy, d.approvedBy, d.version], [true, "draft", undefined, undefined, 3], "承認済みを直すと下書きに戻り、確認・承認が消える");
  ok(r.changes.some((c) => c.field === "status"), "変更履歴に状態の変更も残す");
  throws(() => D.assertSendable(d, koshiStaff), /承認済み/, "下書きは送信できない");
}

/* ================================================================== */
section("差し戻し: 理由が必要・作成者に知らせる");
{
  D.transitionDocDraft(d, koshiStaff, "review");
  throws(() => D.transitionDocDraft(d, koshiMgr, "return", "  "), /理由/, "理由のない差し戻しは断る");
  D.transitionDocDraft(d, koshiMgr, "return", "日程をお客様に確かめてください");
  ok(d.status === "draft" && D.isReturned(d), "差し戻し → 下書き (差し戻しの印)");
  ok(D.docDraftAttention(db, koshiStaff).returned.some((x) => x.id === d.id), "作成者のヘッダーの知らせに差し戻しとして出る");
  throws(() => D.transitionDocDraft(d, koshiMgr, "return", "x"), /確認済み・承認済み/, "下書きは差し戻せない");
}

/* ================================================================== */
section("送信: 承認済みだけ・送ったら直せない");
{
  D.transitionDocDraft(d, koshiStaff, "review");
  D.transitionDocDraft(d, hq, "approve");
  ok(!D.isReturned(d), "承認したら差し戻しの印は消える");
  throws(() => D.assertSendable(d, chuoStaff), /権限/, "ほかの店舗の人は送れない");
  D.assertSendable(d, koshiStaff);
  ok(true, "作成者は承認済みの文書を送れる");
  D.noteSendProblem(d, koshiStaff, "send_skipped", { comment: "メールの送信の設定がありません" });
  eq(d.status, "approved", "送れなかったときは承認済みのまま");
  D.markDocDraftSent(d, koshiStaff, { channel: "email", recipient: "a@example.com", recipientLabel: "お客様", deliveryId: "dlv_x" });
  eq([d.status, d.channel, d.sentBy, d.deliveryIds], ["sent", "email", koshiStaff.id, ["dlv_x"]], "送信済み (送信方法・送った人・送信履歴)");
  throws(() => D.editDocDraft(d, koshiStaff, { body: "x" }), /送信済み/, "送信済みの文書は直せない");
  throws(() => D.transitionDocDraft(d, admin, "discard"), /送信済み/, "送信済みの文書は破棄できない");
  throws(() => D.markDocDraftSent(d, koshiStaff, { channel: "manual_mail" }), /送信済み/, "二重に送信済みにしない");
  const c = D.copyDocDraft(db, koshiStaff, d);
  eq([c.status, c.version, c.copiedFrom, c.versions[0].source, c.events[0].action, c.body], ["draft", 1, d.id, "copy", "copy", d.body], "複製して新しい下書き (元の文書を記録)");
}

/* ================================================================== */
section("破棄・戻す・郵送の記録・管理者の自分の文書");
{
  const x = D.createDocDraft(db, chuoStaff, { template: "free", templateLabel: "自由に作成", format: "document", audience: "internal", body: "中央店のメモ", provider: "rules", refs: [], storeId: "chuo" });
  throws(() => D.transitionDocDraft(x, koshiMgr, "discard"), /権限/, "ほかの店舗の店長は破棄できない");
  D.transitionDocDraft(x, chuoStaff, "discard");
  eq(x.status, "discarded", "作成者が破棄");
  throws(() => D.editDocDraft(x, chuoStaff, { body: "y" }), /破棄/, "破棄した文書は直せない");
  D.transitionDocDraft(x, chuoStaff, "restore");
  eq(x.status, "draft", "下書きに戻す");
  D.transitionDocDraft(x, chuoStaff, "review");
  D.transitionDocDraft(x, chuoMgr, "approve");
  D.markDocDraftSent(x, chuoStaff, { channel: "manual_mail", recipient: "普通郵便" });
  eq([x.status, x.events.at(-1).action], ["sent", "record_manual"], "郵送の記録で送信済み");
  const own = D.createDocDraft(db, admin, { template: "free", templateLabel: "自由に作成", format: "document", audience: "internal", body: "社長のメモ", provider: "rules", refs: [], storeId: "hq" });
  D.transitionDocDraft(own, admin, "review");
  ok(P.canApproveDocDraft(admin, own), "管理者 (社長) は自分の文書を承認できる (承認の省略)");
  const hqOwn = { ...own, createdBy: hq.id };
  ok(!P.canApproveDocDraft(hq, hqOwn), "本部スタッフは自分の文書を承認できない");
}

/* ================================================================== */
section("版の違い (行ごと)");
{
  const diff = D.lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
  eq(diff.map((l) => `${l.op}:${l.text}`), ["same:a", "del:b", "add:B", "same:c", "same:d", "add:e"], "変わった行・増えた行が分かる");
  eq(D.lineDiff("x", "x").map((l) => l.op), ["same"], "同じ文面は違いなし");
  const big = Array.from({ length: 1000 }, (_, i) => `行 ${i}`).join("\n");
  const big2 = big.replace("行 500", "行 五百");
  const bd = D.lineDiff(big, big2);
  eq([bd.filter((l) => l.op === "del").length, bd.filter((l) => l.op === "add").length], [1, 1], "長い文面でも変わった 1 行だけを出す");
}

/* ================================================================== */
section("AI の SQL の閲覧範囲: 店舗のロールは所属店舗と自分の文書だけ");
{
  const scope = MODEL.scopeStatements(koshiStaff).join("\n");
  ok(/create temp view doc_drafts as select \* from main\.doc_drafts where store_id = 'koshi' or created_by = '/.test(scope), "店舗のロールには doc_drafts を範囲で覆う");
  eq(MODEL.scopeStatements(hq), [], "全店舗ロールは覆わない");
}

/* ================================================================== */
section("保存: 書き込み (JSON) と読み直し");
{
  const before = store.getDb().docDrafts.length;
  const saved = await store.mutate((x) => D.createDocDraft(x, koshiStaff, { template: "quote_send", templateLabel: "見積書送付のご案内", format: "email", audience: "customer", body: "本文", provider: "openai", refs: [], storeId: "koshi" }).id);
  ok(store.getDb().docDrafts.length === before + 1 && store.getDb().docDrafts.some((x) => x.id === saved), "mutate で保存できる");
  const file = fs.readdirSync(path.join(work, "data")).find((f) => f.endsWith(".json"));
  ok(file && JSON.parse(fs.readFileSync(path.join(work, "data", file), "utf8")).docDrafts.some((x) => x.id === saved), "JSON のファイルに書かれる");
}

/* ================================================================== */
section("文書の作成: 社内資料は作る人が見られるものだけを AI に渡す");
{
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", model: "gpt-4.1", choices: [{ message: { role: "assistant", content: "件名: 施工日程のご連絡\n\n○○ 様\n本文です。" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-mock", OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_MODEL: "gpt-4.1" });
  const now = new Date().toISOString();
  const kdb = { ...db, knowledge: [
    { id: "kn_all", title: "施工日程のご連絡の決まり", body: "施工日程のご連絡は前日までに電話でも確認する。合言葉 ALLVISIBLE", category: "お客様対応", tags: [], source: "manual", active: true, createdBy: admin.id, createdAt: now, updatedAt: now, visibility: "all" },
    { id: "kn_hq", title: "施工日程のご連絡 (本部の原価メモ)", body: "施工日程のご連絡に関する原価のメモ 合言葉 HQSECRET", category: "お客様対応", tags: [], source: "manual", active: true, createdBy: admin.id, createdAt: now, updatedAt: now, visibility: "hq" },
  ] };
  const rs = await DRAFT.draftDocument(kdb, koshiStaff, { template: "schedule", format: "email", ref: order.number });
  ok(rs.ok && rs.provider === "openai" && rs.used?.href === `/orders/${order.id}`, "モックの AI で下書きを作れる (参照した記録つき)");
  const sent = requests.join("\n");
  ok(sent.includes("ALLVISIBLE") && !sent.includes("HQSECRET"), "店舗スタッフの文書には本部向けの社内資料を渡さない");
  requests.length = 0;
  await DRAFT.draftDocument(kdb, hq, { template: "schedule", format: "email" });
  ok(requests.join("\n").includes("HQSECRET"), "本部スタッフの文書には本部向けの資料も使う");
  server.close();
  for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) delete process.env[k];
  const rules = await DRAFT.draftDocument(db, koshiStaff, { template: "schedule", format: "email", ref: order.number });
  ok(rules.ok && rules.provider === "rules", "AI のキーがないときは定型文 (保存できる形のまま)");
}

console.log(`\n${pass} passed, ${failn} failed`);
if (failn) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
