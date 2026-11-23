// 実行: npm run test:posts-tidy (または node scripts/tests/posts-tidy/posts-tidy.test.mjs)
// 施工事例の投稿 (src/lib/case-posts.ts・src/lib/ai/case-post.ts) と 整理整頓チェック (src/lib/tidy.ts) の回帰テスト:
// お客様の個人情報を投稿文に入れない (除き方・残っていないかの確かめ)・案件からの初期値・定型文・確認する人の決め方・
// 状態の進み方と権限 (確認依頼中は確認する人だけ直す・作成者は承認できない・管理者は省略・承認のあとの修正で下書きに戻る)・
// AI の答えからも個人情報を除く (モックの AI)・チェック項目の貼り付け・キーの安定・点数・要改善の対応・店舗 × 月の集計・閲覧範囲。
// データはこのファイルの中の架空の記録だけ。AI はローカルのモックのサーバー (本物の AI・外部の送信・データベースには接続しない)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-posts-tidy-test-"));
for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?(OPEN_?AI|OPEN_?API|ANTHROPIC|CLAUDE|AI_API)[A-Z0-9_]*(KEY|BASE_URL)$/i.test(k) || k === "AI_PROVIDER" || k === "OPENAI_MODEL") delete process.env[k];
}
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SMTP_HOST", "RESEND_API_KEY", "SENDGRID_API_KEY", "CHATWORK_API_TOKEN", "CHATWORK_ROOM_ID", "LINE_CHANNEL_ACCESS_TOKEN"]) delete process.env[k];
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "posts-tidy-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  DB_CACHE_DIR: path.join(work, "cache"),
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "ichijoya-data.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  TZ: "Asia/Tokyo",
});
process.chdir(work);
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
const imp = (p) => jiti.import(path.join(root, "src", p));

let pass = 0;
const fails = [];
const ok = (cond, msg) => (cond ? (pass++, console.log("  ✓", msg)) : (fails.push(msg), console.log("  ✗", msg)));
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
    ok(e?.name === "CasePostError" && (!re || re.test(e.message)), re && !re.test(e?.message ?? "") ? `${msg} (got ${e?.message})` : msg);
  }
};

const CP = await imp("lib/case-posts.ts");
const T = await imp("lib/tidy.ts");
const P = await imp("lib/auth/permissions.ts");
const SCHEMA = await imp("lib/db/schema.ts");
const MIG = await imp("lib/db/migrate.ts");
const MODEL = await imp("lib/datastore/model.ts");

const NOW = "2030-06-15T01:00:00.000Z";
const user = (id, role, storeId, extra = {}) => ({ id, name: `社員${id}`, email: `${id}@example.test`, role, storeId, active: true, ...extra });
const admin = user("u_admin", "admin", "hq");
const admin2 = user("u_admin2", "admin", "koshi");
const hq = user("u_hq", "hq_staff", "hq");
const koshiMgr = user("u_km", "store_manager", "koshi");
const koshiStaff = user("u_ks", "store_staff", "koshi");
const nishiStaff = user("u_ns", "store_staff", "nishi");
const nishiMgr = user("u_nm", "store_manager", "nishi");
const demoAdmin = user("u_demo", "admin", "hq", { email: "demo@ichijoya.example" });

const customer = { id: "c1", code: "C1", name: "架空 太郎", kana: "カクウ タロウ", phone: "090-1234-5678", email: "taro@example.test", postalCode: "", address: "熊本県合志市須屋1234-5 サンプルハイツ101", storeId: "koshi", type: "individual", preferredChannel: "phone", tags: [], notes: "", contacts: [{ id: "k1", relation: "妻", name: "架空 花子", phone: "096-111-2222" }], createdAt: NOW, updatedAt: NOW };
const order = { id: "o1", number: "O-2030-0001", quoteId: "q1", customerId: "c1", storeId: "koshi", title: "架空様邸 和室6畳 表替え", category: "tatami", contractDate: "2030-06-01", total: 50000, status: "completed", workerIds: [], siteAddress: "", progressNotes: [], createdBy: "u_ks", createdAt: NOW, updatedAt: NOW, workDetails: "和室 6 畳の表替え (架空太郎様邸)。連絡先 090-1234-5678" };
const quote = { id: "q1", number: "Q-1", version: 1, customerId: "c1", storeId: "koshi", title: "表替え", category: "tatami", items: [
  { id: "i1", name: "畳表 熊本県産 ひのさらさ", qty: 6, unit: "枚", unitPrice: 8000, amount: 48000 },
  { id: "i2", name: "縁 紋縁", spec: "紺", qty: 6, unit: "枚", unitPrice: 0, amount: 0 },
  { id: "i3", name: "値引き", qty: 1, unit: "式", unitPrice: -3000, amount: -3000 },
  { id: "i4", name: "諸経費", qty: 1, unit: "式", unitPrice: 1000, amount: 1000 },
], subtotal: 46000, discount: 0, tax: 4600, total: 50600, status: "accepted", validUntil: "2030-07-01", createdBy: "u_ks", createdAt: NOW, updatedAt: NOW };
const photo = (id, extra = {}) => ({ id, parentType: "order", parentId: "o1", customerId: "c1", storeId: "koshi", kind: "photo", fileName: `${id}.jpg`, contentType: "image/jpeg", size: 100, storageKey: `order/x/${id}.jpg`, uploadedBy: "u_ks", uploadedAt: `2030-06-0${id.slice(-1)}T00:00:00.000Z`, ...extra });
const attachments = [photo("a1"), photo("a2"), photo("a3"), { ...photo("a4"), kind: "file", fileName: "図面.pdf" }, { ...photo("a5"), parentId: "o_other" }];
const baseDb = () => ({ users: [admin, admin2, hq, koshiMgr, koshiStaff, nishiStaff, nishiMgr, demoAdmin], settings: [], customers: [customer], orders: [order], quotes: [quote], attachments, casePosts: [], tidyChecks: [], stores: [{ id: "koshi", name: "合志店", shortName: "合志" }, { id: "nishi", name: "西店", shortName: "西" }, { id: "hq", name: "本社", shortName: "本社" }] });

/* ================================================================== */
section("データ: 表の定義・読み込み時の補完・AI の SQL の範囲");
{
  for (const [col, table, sample] of [
    ["casePosts", "case_posts", ["id", "number", "orderId", "storeId", "title", "photoIds", "products", "workContent", "area", "channels", "aiText", "text", "hashtags", "provider", "consent", "status", "requestedBy", "requestedAt", "approvedBy", "approvedAt", "postedAt", "postings", "events", "createdBy", "createdAt", "updatedBy", "updatedAt"]],
    ["tidyChecks", "tidy_checks", ["id", "number", "storeId", "date", "checkedBy", "place", "items", "score", "okCount", "ngCount", "naCount", "comment", "photos", "provisional", "createdBy", "createdAt", "updatedBy", "updatedAt"]],
  ]) {
    const def = SCHEMA.TABLES.find((t) => t.collection === col);
    ok(def && def.table === table, `schema.ts に ${table} がある`);
    const cols = new Set((def?.columns ?? []).map(([f]) => f));
    eq(sample.filter((k) => !cols.has(k)), [], `${table}: 型のすべての項目に列がある`);
  }
  const old = { meta: { version: 3 }, settings: [] };
  MIG.migrateDb(old);
  ok(Array.isArray(old.casePosts) && Array.isArray(old.tidyChecks), "古いデータは読み込み時に空の一覧を作る");
  const staffSql = MODEL.scopeStatements(koshiStaff).join("\n");
  ok(/temp view case_posts as select \* from main\.case_posts where store_id = 'koshi' or created_by = 'u_ks'/.test(staffSql), "AI の SQL: 店舗スタッフの施工事例の投稿は自店舗と自分の投稿");
  ok(/temp view tidy_checks as select \* from main\.tidy_checks where store_id = 'koshi'/.test(staffSql), "AI の SQL: 店舗スタッフの整理整頓チェックは自店舗");
  ok(!/tidy_checks/.test(MODEL.scopeStatements(koshiMgr).join("\n")), "AI の SQL: 店長は整理整頓チェックの全店舗を見られる (覆わない)");
}

/* ================================================================== */
section("個人情報: 投稿文から除く・残っていないかを確かめる");
const ctx = CP.personalContext(customer, order);
{
  const raw = "架空太郎様邸の和室を表替え。架空 様にもご満足いただきました。電話 090-1234-5678、メール taro@example.test。住所は熊本県合志市須屋1234-5 サンプルハイツ101 です。カクウ タロウ";
  const s = CP.scrubPersonal(raw, ctx);
  ok(!s.includes("架空") && !s.includes("カクウ"), "お名前 (姓名・姓だけ・ふりがな) を消す");
  ok(!s.includes("090") && !s.includes("taro@"), "電話番号・メールを消す");
  ok(s.includes("合志市須屋") && !s.includes("1234") && !s.includes("サンプルハイツ"), "住所は町名まで (番地・建物名を消す)");
  ok(s.includes("お客様"), "お名前は「お客様」に置き換える");
  ok(CP.scrubPersonal("襖の模様と畳表の仕様を選び直しました", ctx) === "襖の模様と畳表の仕様を選び直しました", "「模様」「仕様」などの言葉は名前と間違えない");
  eq(CP.scrubPersonal("山本様邸の網戸張替え", ctx), "お客様宅の網戸張替え", "知らない名前でも「〇〇様邸」は「お客様宅」にする");
  ok(CP.scrubPersonal("熊本市中央区水前寺3丁目12番5号の現場", ctx).indexOf("12番") < 0, "「3丁目12番5号」のような番地は消す");
  eq(CP.personalInfoFindings("合志市須屋で表替えをしました。", ctx), [], "町名だけの文は問題なし");
  const f = CP.personalInfoFindings("架空様の合志市須屋1234 で施工。090-1234-5678", ctx);
  ok(f.some((x) => x.includes("お名前")) && f.some((x) => x.includes("電話番号")) && f.some((x) => x.includes("番地")), `残っているお名前・電話番号・番地を見つける (${f.join(" / ")})`);
  ok(CP.personalInfoFindings("架空 花子さんにもご協力いただきました", ctx).some((x) => x.includes("架空")), "続柄の連絡先のお名前も見つける");
}

/* ================================================================== */
section("案件からの初期値・定型文・ハッシュタグ");
{
  const db = baseDb();
  const pre = CP.postPrefill(db, order);
  eq(pre.area, "合志市須屋", "地域は施工場所 (なければお客様の住所) の町名まで");
  eq(pre.products.split("\n"), ["畳表 熊本県産 ひのさらさ", "縁 紋縁 紺"], "商品名は見積の明細の品名 (値引き・諸経費を除く)");
  eq(pre.photoIds, ["a1", "a2", "a3"], "写真は受注の写真だけ (資料・ほかの案件を除く。古い順)");
  eq(pre.title, "合志市須屋 和室6畳 表替え", "見出しにお名前 (「〇〇様邸」) を入れない");
  ok(!pre.workContent.includes("架空") && !pre.workContent.includes("090"), "施工内容からもお名前・電話を除く");
  const t = CP.templateDraft({ title: pre.title, area: pre.area, products: pre.products.split("\n"), workContent: pre.workContent, categoryLabel: "畳", storeName: "合志店", channels: ["instagram"] });
  ok(t.text.includes("合志市須屋") && t.text.includes("ひのさらさ") && t.text.includes("一畳屋 合志店"), "定型文は地域・商品名・店舗名から作る");
  ok(t.hashtags.includes("#一畳屋") && t.hashtags.includes("#合志市") && t.hashtags.includes("#畳"), `ハッシュタグの候補 (${t.hashtags})`);
  eq(CP.templateDraft({ title: "", area: "", products: [], workContent: "", categoryLabel: "襖", storeName: "", channels: ["website"] }).hashtags, "", "ホームページだけのときはハッシュタグを付けない");
  eq(CP.normalizeHashtags("畳 #表替え,  ＃合志市 畳"), "#畳 #表替え #合志市", "ハッシュタグの書き方をそろえる (# 付き・重複なし)");
  eq(CP.nextPostNumber([{ number: "CP-2030-0007" }, { number: "CP-2029-0099" }], "2030-01-01"), "CP-2030-0008", "番号は年ごとの連番");
}

/* ================================================================== */
section("確認する人 (設定。既定 = 本部の管理者)");
{
  const db = baseDb();
  eq(CP.casePostReviewerIds(db), ["u_admin"], "既定: 本部 (hq) の管理者 (デモ用アカウントは社員と混ぜない)");
  db.users = db.users.map((u) => (u.id === "u_admin" ? { ...u, storeId: "koshi" } : u));
  eq(CP.casePostReviewerIds(db).sort(), ["u_admin", "u_admin2"], "本部の管理者がいなければ管理者全員");
  db.settings = [{ id: "case_posts", value: { reviewerIds: ["u_hq"] }, updatedAt: NOW }];
  eq(CP.casePostReviewerIds(db), ["u_hq"], "設定で選んだ社員");
  ok(CP.reviewersConfigured(db), "設定ありと分かる");
  db.users = db.users.map((u) => (u.id === "u_hq" ? { ...u, active: false } : u));
  eq(CP.casePostReviewerIds(db).sort(), ["u_admin", "u_admin2"], "選んだ社員が無効なら既定に戻る");
}

/* ================================================================== */
section("状態の進み方と権限");
{
  const db = baseDb();
  const ids = ["u_admin"];
  const pre = CP.postPrefill(db, order);
  const p = CP.createCasePost(db, koshiStaff, { id: "cp1", order, fields: { ...pre, text: "合志市須屋で表替えをしました。", hashtags: "#一畳屋" }, provider: "rules" }, NOW);
  eq([p.status, p.number, p.storeId, p.consent], ["draft", "CP-2030-0001", "koshi", "unconfirmed"], "作成: 下書き・番号・案件の店舗・掲載の了承は未確認");
  ok(P.canViewCasePost(koshiStaff, p, ids) && P.canViewCasePost(koshiMgr, p, ids) && P.canViewCasePost(admin, p, ids), "見られる: 作成者・店舗のメンバー・確認する人");
  ok(!P.canViewCasePost(nishiStaff, p, ids) && !P.canViewCasePost(nishiMgr, p, ids), "ほかの店舗のロールは見られない");
  ok(P.canViewCasePost(nishiStaff, p, ["u_ns"]), "確認する人に選ばれていれば店舗を問わず見られる");
  ok(!P.canCreateCasePost(nishiStaff, "koshi") && P.canCreateCasePost(koshiStaff, "koshi"), "作れるのは案件の店舗の担当者");

  const r1 = CP.editCasePost(p, koshiStaff, { text: "架空様の合志市須屋のお宅で表替え。" }, ids, NOW);
  ok(r1.changed && r1.changes.some((c) => c.field === "text"), "修正: 変わった項目を変更履歴に (本文は文字数)");
  throws(() => CP.transitionCasePost(p, koshiStaff, "request", ids, ctx, "", NOW), /個人情報/, "お名前が残っていると確認を依頼できない");
  CP.editCasePost(p, koshiStaff, { text: "合志市須屋で和室 6 畳の表替えをしました。", photoIds: [] }, ids, NOW);
  throws(() => CP.transitionCasePost(p, koshiStaff, "request", ids, ctx, "", NOW), /写真/, "写真がないと確認を依頼できない");
  CP.editCasePost(p, koshiStaff, { photoIds: ["a1", "a2"] }, ids, NOW);
  CP.transitionCasePost(p, koshiStaff, "request", ids, ctx, "", NOW);
  eq([p.status, p.requestedBy], ["review", "u_ks"], "確認の依頼 → 確認依頼中");
  ok(!P.canEditCasePost(koshiStaff, p, ids) && P.canEditCasePost(admin, p, ids), "確認依頼中は確認する人だけが直せる");
  throws(() => CP.editCasePost(p, koshiStaff, { text: "x" }, ids, NOW), /確認する人だけ/, "担当者の修正は断る");
  throws(() => CP.transitionCasePost(p, koshiMgr, "approve", ids, ctx, "", NOW), /権限/, "確認する人でない店長は承認できない");
  throws(() => CP.transitionCasePost(p, admin, "return", ids, ctx, "", NOW), /理由/, "差し戻しは理由が必要");
  CP.transitionCasePost(p, admin, "return", ids, ctx, "2 枚目に表札が写っています", NOW);
  eq([p.status, CP.lastReturnComment(p)], ["returned", "2 枚目に表札が写っています"], "差し戻し (理由を残す)");
  eq(CP.casePostAttention({ ...db, settings: [] }, koshiStaff).returned.map((x) => x.id), ["cp1"], "知らせ: 差し戻された自分の投稿");
  CP.editCasePost(p, koshiStaff, { photoIds: ["a1"] }, ids, NOW);
  CP.transitionCasePost(p, koshiStaff, "request", ids, ctx, "", NOW);
  eq(CP.casePostAttention({ ...db, settings: [{ id: "case_posts", value: { reviewerIds: ids }, updatedAt: NOW }] }, admin).toReview.map((x) => x.id), ["cp1"], "知らせ: 確認する人に確認依頼");
  CP.transitionCasePost(p, admin, "approve", ids, ctx, "", NOW);
  eq([p.status, p.approvedBy], ["approved", "u_admin"], "確認する人が承認");
  const keep = CP.editCasePost(p, admin, { hashtags: "#一畳屋 #畳" }, ids, NOW);
  ok(keep.changed && !keep.reset && p.status === "approved", "確認する人の修正は承認済みのまま");
  const reset = CP.editCasePost(p, koshiStaff, { text: "合志市須屋で表替えをしました (直した)。" }, ids, NOW);
  ok(reset.reset && p.status === "draft" && !p.approvedBy, "承認のあとに担当者が文面を直すと下書きに戻る");
  const consentOnly = CP.createCasePost(db, koshiStaff, { id: "cp2", order, fields: { ...pre, text: "合志市須屋で表替え。" }, provider: "rules" }, NOW);
  CP.transitionCasePost(consentOnly, koshiStaff, "request", ids, ctx, "", NOW);
  CP.transitionCasePost(consentOnly, admin, "approve", ids, ctx, "", NOW);
  ok(!CP.editCasePost(consentOnly, koshiStaff, { consent: "obtained" }, ids, NOW).reset && consentOnly.status === "approved", "掲載の了承の記録だけの変更は承認をやり直さない");
  throws(() => CP.recordCasePosting(p, koshiStaff, { channel: "instagram", on: "2030-06-16" }, ids, NOW), /承認済み/, "承認前は投稿を記録できない");
  CP.recordCasePosting(consentOnly, koshiStaff, { channel: "instagram", on: "2030-06-16", url: "https://www.instagram.com/p/xyz/" }, ids, NOW);
  CP.recordCasePosting(consentOnly, koshiStaff, { channel: "website", on: "2030-06-17" }, ids, NOW);
  eq([consentOnly.status, consentOnly.postings.map((x) => x.channel)], ["posted", ["instagram", "website"]], "投稿を記録 → 投稿済み (投稿先ごとに追加できる)");
  throws(() => CP.recordCasePosting(consentOnly, koshiStaff, { channel: "google", on: "2030-06-17", url: "javascript:alert(1)" }, ids, NOW), /https/, "URL は https:// だけ");
  throws(() => CP.transitionCasePost(consentOnly, koshiStaff, "discard", ids, ctx, "", NOW), /投稿済み/, "投稿済みは取りやめにできない");
  ok(!P.canEditCasePost(koshiStaff, consentOnly, ids), "投稿済みは直せない");
  CP.transitionCasePost(p, koshiStaff, "discard", ids, ctx, "", NOW);
  ok(p.status === "discarded" && !P.canEditCasePost(koshiStaff, p, ids), "取りやめ (直せない)");
  CP.transitionCasePost(p, koshiStaff, "restore", ids, ctx, "", NOW);
  eq(p.status, "draft", "取りやめから下書きに戻す");

  // 作成者が確認する人のとき: 管理者でない確認する人は自分の投稿を承認できない (ほかの確認する人が承認)、管理者は省略できる
  const own = CP.createCasePost(db, koshiMgr, { id: "cp3", order, fields: { ...pre, text: "合志市須屋で表替え。" }, provider: "rules" }, NOW);
  const ids2 = ["u_km", "u_admin"];
  CP.transitionCasePost(own, koshiMgr, "request", ids2, ctx, "", NOW);
  ok(!P.canApproveCasePost(koshiMgr, own, ids2) && P.canApproveCasePost(admin, own, ids2), "確認する人の店長は自分の投稿を承認できない (管理者が承認)");
  const mine = CP.createCasePost(db, admin, { id: "cp4", order, fields: { ...pre, text: "合志市須屋で表替え。" }, provider: "rules" }, NOW);
  CP.transitionCasePost(mine, admin, "request", ["u_admin"], ctx, "", NOW);
  ok(P.canApproveCasePost(admin, mine, ["u_admin"]), "管理者 (確認する人) は自分の投稿も承認できる (承認の省略)");
  CP.transitionCasePost(mine, admin, "withdraw", ["u_admin"], ctx, "", NOW);
  eq(mine.status, "draft", "確認の依頼を取り下げると下書き");
  ok(mine.events.map((e) => e.action).join(",") === "create,request,withdraw", "処理の記録 (作成・依頼・取り下げ)");
}

/* ================================================================== */
section("AI の下書き: 個人情報を渡さず、答えからも除く (モックの AI)");
{
  const AI = await imp("lib/ai/case-post.ts");
  const input = { title: "架空様邸 表替え", area: "合志市須屋", products: ["畳表 ひのさらさ"], workContent: "架空太郎様のお宅 (090-1234-5678) の和室", categoryLabel: "畳", storeName: "合志店", channels: ["instagram"] };
  const rules = await AI.draftCasePostText(input, ctx, "u_ks");
  ok(rules.provider === "rules" && !rules.text.includes("架空") && rules.text.includes("合志市須屋"), "AI のキーがないときは定型文 (お名前なし)");
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push(raw);
      res.writeHead(200, { "content-type": "application/json" });
      const content = JSON.stringify({ text: "【施工事例】架空太郎様のお宅 (合志市須屋1234-5) で表替えをしました。090-1234-5678", hashtags: ["畳", "表替え"] });
      res.end(JSON.stringify({ id: "c", model: "gpt-4.1", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-mock", OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_MODEL: "gpt-4.1" });
  const r = await AI.draftCasePostText(input, ctx, "u_ks");
  const sent = requests.join("\n");
  ok(r.provider === "openai", "モックの AI で下書きを作る");
  ok(!sent.includes("架空") && !sent.includes("090-1234") && !sent.includes("1234-5"), "AI にお名前・電話・番地を渡さない");
  ok(!r.text.includes("架空") && !r.text.includes("090") && !r.text.includes("1234") && r.text.includes("合志市須屋"), `AI の答えからも個人情報を除く (${r.text})`);
  ok(r.hashtags.startsWith("#一畳屋") && r.hashtags.includes("#表替え"), `ハッシュタグに #一畳屋 を必ず入れる (${r.hashtags})`);
  server.close();
  for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) delete process.env[k];
}

/* ================================================================== */
section("整理整頓: チェック項目 (設定・貼り付け・キー)");
{
  const s0 = T.tidySettings({ settings: [] });
  ok(s0.provisional && s0.items.length === T.DEFAULT_TIDY_ITEMS.length, "設定がないときは暫定の項目");
  const text = "■作業場\n1. 床にゴミがない\n・道具が戻されている\n□ 床にゴミがない\n\n【車両】\n車内がきれい\n店舗:\n- 入口がきれい";
  const r = T.parseTidyItemsText(text);
  eq(r.items.map((i) => [i.group, i.label]), [["作業場", "床にゴミがない"], ["作業場", "道具が戻されている"], ["車両", "車内がきれい"], ["店舗", "入口がきれい"]], "見出し (■・【】・コロン) と行の頭の番号・記号を読み分ける");
  eq(r.skipped, ["床にゴミがない"], "同じ項目の重複は 1 つにする");
  ok(T.tidyItemKey("床にゴミがない", "作業場") === r.items[0].key && T.tidyItemKey("床に ゴミがない", "作業場") === r.items[0].key, "キーは名前から決まる (空白の違いは同じ)");
  ok(T.tidyItemKey("床にゴミがない", "店舗") !== r.items[0].key, "見出しが違えば別の項目");
  eq(T.parseTidyItemsText(T.tidyItemsText(r.items)).items, r.items, "貼り付けの形に戻して読み直しても同じ");
  const s1 = T.tidySettings({ settings: [{ id: "tidy_items", value: { items: r.items, provisional: false }, updatedAt: NOW }] });
  ok(!s1.provisional && s1.items.length === 4, "設定の項目 (確定)");
}

/* ================================================================== */
section("整理整頓: 結果・点数・要改善の対応");
{
  const defs = T.parseTidyItemsText("■A\na1\na2\na3\n■B\nb1").items;
  const k = defs.map((d) => d.key);
  const items = T.buildTidyItems(defs, [{ key: k[0], result: "ok" }, { key: k[1], result: "ng", note: "工具が出しっぱなし", dueDate: "2030-06-20" }, { key: k[2], result: "na" }, { key: k[3], result: "bogus" }]);
  eq(items.map((i) => i.result), ["ok", "ng", "na", "na"], "答えていない・正しくない値は対象外");
  eq([items[1].fixStatus, items[1].dueDate, items[1].note], ["open", "2030-06-20", "工具が出しっぱなし"], "要改善は未対応・期限・メモ");
  eq(T.tidyScore(items), { score: 50, okCount: 1, ngCount: 1, naCount: 2 }, "点数 = 良い ÷ (良い + 要改善) × 100 (対象外は数えない)");
  eq(T.tidyScore([{ result: "na" }]).score, undefined, "対象外だけなら点数なし");
  eq(T.tidyScore([{ result: "ok" }, { result: "ok" }, { result: "ng" }]).score, 66.7, "小数 1 桁");
  // 修正: 直した記録は要改善のままなら残る・設定から外れた項目も残る
  items[1].fixStatus = "fixed";
  items[1].fixedBy = "u_ks";
  const later = T.buildTidyItems(defs.slice(0, 2), [{ key: k[0], result: "ok" }, { key: k[1], result: "ng" }], items);
  ok(later[1].fixStatus === "fixed" && later[1].fixedBy === "u_ks" && later[1].dueDate === "2030-06-20", "修正しても、要改善のままの項目の「直した」・期限は残る");
  ok(later.some((i) => i.key === k[3]), "設定から外した項目も、記録済みのチェックには残る");
  const okNow = T.buildTidyItems(defs, [{ key: k[1], result: "ok" }], items);
  ok(okNow[1].result === "ok" && !okNow[1].fixStatus, "良いに直すと要改善の対応は消える");
  const before = { date: "2030-06-01", storeId: "koshi", checkedBy: "u_ks", items };
  const ch = T.tidyChanges(before, { ...before, items: okNow });
  ok(ch.some((c) => c.field === `item:${defs[1].label}` && c.before === "要改善" && c.after === "良い"), "変更履歴に項目ごとの結果の変更");

  const check = (id, storeId, date, its, extra = {}) => ({ id, number: id, storeId, date, checkedBy: "u_ks", items: its, ...T.tidyScore(its), photos: [], createdBy: "u_ks", createdAt: `${date}T00:00:00Z`, updatedAt: `${date}T00:00:00Z`, ...extra });
  const ng = (key, label, due, fixed) => ({ key, label, result: "ng", dueDate: due, fixStatus: fixed ? "fixed" : "open" });
  const checks = [
    check("c1", "koshi", "2030-05-10", [{ key: "x", label: "床", result: "ok" }, ng("y", "道具", "2030-06-01")]),
    check("c2", "koshi", "2030-06-05", [{ key: "x", label: "床", result: "ok" }, { key: "y", label: "道具", result: "ok" }]),
    check("c3", "nishi", "2030-06-07", [ng("x", "床", undefined), ng("y", "道具", "2030-06-30", true)]),
  ];
  const f = T.openFollowUps(checks, "2030-06-15");
  eq(f.map((x) => [x.check.id, x.item.key, x.overdue]), [["c1", "y", true], ["c3", "x", false]], "直していない要改善 (期限切れ・期限なしは後ろ。直したものは出さない)");
  const months = T.monthsBack("2030-06-15", 3);
  eq(months, ["2030-04", "2030-05", "2030-06"], "月の並び (古い順)");
  eq(T.monthsBack("2031-01-03", 2), ["2030-12", "2031-01"], "年をまたぐ月");
  const sum = T.tidySummary(checks, ["koshi", "nishi"], months);
  eq(sum.get("koshi").get("2030-05"), { count: 1, ng: 1, avg: 50 }, "店舗 × 月: 回数・要改善・平均点");
  eq(sum.get("koshi").get("2030-06"), { count: 1, ng: 0, avg: 100 }, "月ごと");
  eq(sum.get("nishi").get("2030-06").avg, 0, "全部要改善なら 0 点");
  eq(T.frequentNg(checks).map((x) => [x.label, x.count, x.of]), [["道具", 2, 3], ["床", 1, 3]], "よく要改善になる項目");
  eq(T.nextTidyNumber([{ number: "TC-2030-0002" }], "2030-07-01"), "TC-2030-0003", "番号は年ごとの連番");
  eq(T.fmtScore(66.7), "66.7 点", "点数の表示");
}

/* ================================================================== */
section("整理整頓: 権限 (店舗スタッフは自店舗、店長・本部・管理者は全店舗。項目は管理者)");
{
  const c = { storeId: "koshi", checkedBy: "u_ks", createdBy: "u_ks" };
  ok(P.canViewTidyCheck(koshiStaff, c) && !P.canViewTidyCheck(nishiStaff, c), "店舗スタッフは自店舗だけ見られる");
  ok(P.canViewTidyCheck(nishiMgr, c) && P.canViewTidyCheck(hq, c), "店長・本部は全店舗を見られる");
  ok(P.canRecordTidyCheck(koshiStaff, "koshi") && !P.canRecordTidyCheck(koshiStaff, "nishi") && P.canRecordTidyCheck(hq, "nishi"), "記録は所属店舗 (本部・管理者は全店舗)");
  ok(P.canEditTidyCheck(koshiMgr, c) && !P.canEditTidyCheck(nishiMgr, c), "ほかの店舗の店長は見られるが直せない");
  ok(P.canDeleteTidyCheck(koshiStaff, c) && !P.canDeleteTidyCheck({ ...koshiStaff, id: "u_other" }, c) && P.canDeleteTidyCheck(koshiMgr, c), "削除: チェックした本人・その店舗の店長");
  ok(P.canManageTidyItems(admin) && !P.canManageTidyItems(hq) && !P.canManageTidyItems(koshiMgr), "項目の変更は管理者だけ");
  ok(P.canUseLineGroupPhotos(koshiStaff, "koshi") && !P.canUseLineGroupPhotos(koshiStaff, "nishi") && P.canUseLineGroupPhotos(nishiStaff, undefined), "LINE の写真: 店舗のグループは所属店舗、店舗のないグループは全員");
  const db = { tidyChecks: [{ ...c, id: "t1" }, { storeId: "nishi", id: "t2" }] };
  eq(T.visibleTidyChecks(db, koshiStaff).map((x) => x.id), ["t1"], "一覧も閲覧範囲で絞る");
}

console.log(`\n${pass} 件成功 / ${fails.length} 件失敗`);
fs.rmSync(work, { recursive: true, force: true });
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
