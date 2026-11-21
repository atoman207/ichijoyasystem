// 実行: npm run test:knowledge (または node scripts/tests/knowledge/knowledge.test.mjs)
// 社内資料の管理 (担当者・確認期限・期限切れ)・Google スプレッドシートの同期 (行ごとの確認・一方向・失敗の知らせ・最後の成功)・
// 長い記録の要約 (期間・内容の絞り込み・区分ごと → 全体・根拠のリンク)。
// データは一時フォルダーのサンプルデータ。Google・AI には接続しない (シートは fetch の差し替え、AI はモックのサーバー)
import http from "node:http";
import { imp, ok, eq, section, summary } from "../chatbot/harness.mjs";

const store = await imp("lib/db/store.ts");
const R = await imp("lib/knowledge-review.ts");
const SH = await imp("lib/knowledge-sheet.ts");
const K = await imp("lib/knowledge.ts");
const SY = await imp("lib/knowledge-sync.ts");
const EV = await imp("lib/notify/events.ts");
const SUM = await imp("lib/ai/summary.ts");

const db = store.getDb();
const admin = db.users.find((u) => u.role === "admin" && u.active);
const hq = db.users.find((u) => u.role === "hq_staff" && u.active);
const manager = db.users.find((u) => u.role === "store_manager" && u.active);
const staff = db.users.find((u) => u.role === "store_staff" && u.active && u.storeId === manager.storeId) ?? db.users.find((u) => u.role === "store_staff" && u.active);
const today = R.todayKey();
const now = new Date().toISOString();
let seq = 0;
const nid = () => `kn_test_${++seq}`;
const entry = (over = {}) => ({ id: nid(), title: `資料 ${seq}`, body: "本文", category: "社内ルール", tags: [], source: "manual", active: true, createdBy: admin.id, createdAt: now, updatedAt: now, ...over });

/* ================================================================== */
section("社内資料の管理: 担当者・次に確かめる日・見られる人・分類");
{
  const s = R.reviewSettings(db);
  eq(R.intervalFor(s, "商品・価格"), 90, "価格は 90 日ごと (既定)");
  eq(R.intervalFor(s, "議事録・決定事項"), 365, "議事録は 1 年ごと (既定)");
  eq(s.soonDays, 14, "期限が近いのは 14 日前から (既定)");
  const ctx = R.reviewCtx(db);
  const bare = entry({ category: "その他" });
  const issues = R.knowledgeIssues(bare, ctx);
  ok(["no_owner", "no_review", "no_category", "no_visibility"].every((i) => issues.includes(i)), "何も決まっていない資料は 担当者なし・確認日なし・分類なし・公開範囲が未設定");
  ok(!R.isReady(issues), "整っていない");
  const good = entry({ ownerId: manager.id, visibility: "all", reviewDue: R.addDays(today, 60) });
  eq(R.knowledgeIssues(good, ctx), [], "担当者・期限内の確認日・見られる人・分類がそろうと問題なし");
  eq(R.knowledgeIssues({ ...good, reviewDue: R.addDays(today, -1) }, ctx), ["overdue"], "次に確かめる日を過ぎると確認期限切れ");
  eq(R.knowledgeIssues({ ...good, reviewDue: R.addDays(today, 5) }, ctx), ["due_soon"], "14 日以内は期限が近い");
  ok(R.isReady(["due_soon"]), "期限が近いだけなら整っている");
  ok(R.knowledgeIssues({ ...good, ownerId: staff.id }, ctx).includes("owner_invalid"), "店舗スタッフ (社内資料を編集できない) は担当者にできない");
  ok(R.knowledgeIssues({ ...good, visibility: "hq" }, ctx).includes("owner_invalid"), "本部以上の資料の担当者に店長は見直しが必要");
  ok(R.knowledgeIssues({ ...good, ownerId: "u_gone" }, ctx).includes("owner_invalid"), "いない社員の担当者は見直しが必要");
  const p = R.confirmedPatch(s, { category: "商品・価格" }, manager.id);
  eq(p.reviewDue, R.addDays(today, 90), "「確認した」で次に確かめる日 = 今日 + 分類の間隔");
  eq(p.reviewedBy, manager.id, "確かめた人を残す");
  eq(R.confirmedPatch(s, { category: "商品・価格", reviewIntervalDays: 30 }, manager.id).reviewDue, R.addDays(today, 30), "資料ごとの間隔があればそちら");
  const init = R.initialReview({ ...s, defaultOwnerId: hq.id }, "マニュアル");
  eq([init.ownerId, init.reviewDue], [hq.id, R.addDays(today, 180)], "新しい資料は既定の担当者と 今日 + 間隔");
  ok(R.staleNote({ reviewDue: R.addDays(today, -3) }, today)?.includes("古い可能性"), "期限切れの資料は AI に「古い可能性」の注記を渡す");
  eq(R.staleNote({ reviewDue: R.addDays(today, 3) }, today), undefined, "期限内は注記なし");
  const list = [good, { ...good, id: "x1", reviewDue: R.addDays(today, -1) }, { ...good, id: "x2", active: false, reviewDue: R.addDays(today, -1) }];
  const q = R.knowledgeQuality(list, ctx);
  eq([q.counts.overdue, q.ready], [1, 2], "AI に使わない資料は期限切れに数えない");
  const mine = R.myReviewItems(list, manager.id, ctx);
  eq(mine.overdue.map((k) => k.id), ["x1"], "自分が担当の期限切れ (AI に使うものだけ)");
  ok(R.ownerCandidates(db).every((u) => u.active && u.role !== "store_staff"), "担当者の候補は社内資料を編集できる有効な社員");
}

/* ================================================================== */
section("スプレッドシートの行ごとの確認 (同期の前のプレビュー)");
const src = { id: "ks_t", label: "テストのシート", url: "https://docs.google.com/spreadsheets/d/TESTSHEET123abcdefghijklmnop/edit#gid=0", category: "よくある質問", ownerId: manager.id, visibility: "all" };
const head = ["タイトル", "内容", "分類", "見られる人", "担当者", "次回確認日", "日付", "備考"];
const csvOf = (rows) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
const rows1 = [
  head,
  ["支払方法", "現金・カード・PayPay", "よくある質問", "全員", admin.name, "2027-01-31", "", "注意: 振込は 2 週間以内"],
  ["支払方法", "重複した行", "", "", "", "", "", ""],
  ["空の内容", "", "", "", "", "", "", ""],
  ["見積の有効期限", "30 日", "", "本部以上", "", "2026/02/30", "", ""],
  ["価格表", "畳表 さくら 1 畳 8,000 円", "商品・価格", "店長以上", "", "", "2026年11月1日", ""],
  ["範囲の誤り", "x", "", "社外の人", "", "", "", ""],
  ["保証", "施工後 1 年", "", "", "知らない人", "", "", ""],
  ["", "", "", "", "", "", "", ""],
];
let plan = SH.planSheetSync(db, src, csvOf(rows1), rows1);
{
  ok(plan.headerFound && !plan.sheetErrors.length, "見出しを読み取れる");
  eq(plan.columns.visibility, "見られる人", "見られる人の列を読む");
  eq(plan.columns.extra, ["備考"], "ほかの列は内容に足す");
  eq([plan.counts.add, plan.counts.skip], [3, 4], "取り込む 3 行・取り込まない 4 行 (空の行は数えない)");
  const byLine = (n) => plan.rows.find((r) => r.line === n);
  ok(byLine(3).issues.some((i) => i.message.includes("同じタイトルが 2 行目")), "同じタイトルの 2 行目以降は取り込まない (理由つき)");
  ok(byLine(4).issues.some((i) => i.message.includes("内容が空")), "内容が空の行は取り込まない");
  ok(byLine(5).issues.some((i) => i.level === "error" && i.message.includes("日付として読めません")), "ありえない日付 (2/30) は取り込まない");
  ok(byLine(7).issues.some((i) => i.message.includes("見られる人「社外の人」")), "見られる人の値の誤りは取り込まない");
  ok(byLine(8).action === "add" && byLine(8).issues.some((i) => i.level === "warn" && i.message.includes("知らない人")), "担当者が見つからない行は注意つきで取り込む (取込元の担当者)");
  const pay = byLine(2).draft;
  eq([pay.ownerId, pay.reviewDue, pay.visibility], [admin.id, "2027-01-31", "all"], "担当者 (氏名)・次回確認日・見られる人をシートから");
  ok(pay.body.includes("備考: 注意: 振込は 2 週間以内"), "ほかの列は「見出し: 値」で内容に");
  const price = byLine(6).draft;
  eq([price.visibility, price.recordDate, price.category], ["manager", "2026-11-01", "商品・価格"], "店長以上・日付 (2026年11月1日)・分類");
  eq(SH.planSheetSync(db, src, csvOf(rows1), rows1).hash, plan.hash, "同じ中身は同じ hash");
}
const sheetCount = () => store.getDb().knowledge.filter((k) => k.sourceRef?.startsWith(SH.sheetPrefix(src.id))).length;
{
  await store.mutate((d) => SH.applySheetPlan(d, src, plan, admin.id, () => store.newId("kn")));
  eq(sheetCount(), 3, "計画のとおりに 3 件を登録");
  const kd = store.getDb().knowledge.find((k) => k.title === "保証");
  eq([kd.ownerId, kd.visibility, kd.source], [manager.id, "all", "sheet"], "列がない項目は取込元の既定 (担当者・見られる人)");
  ok(kd.reviewDue === R.addDays(today, R.intervalFor(R.reviewSettings(db), "よくある質問")), "新しい資料は 次に確かめる日 = 今日 + 間隔");
  // 2 回目: 支払方法を直し、価格表の内容を消し (取り込めない → 前の内容のまま)、保証の行を消す (削除)
  const rows2 = [head, ["支払方法", "現金・カード・PayPay・銀行振込", "よくある質問", "全員", admin.name, "2027-01-31", "", "注意: 振込は 2 週間以内"], ["価格表", "", "商品・価格", "店長以上", "", "", "", ""]];
  plan = SH.planSheetSync(store.getDb(), src, csvOf(rows2), rows2);
  eq([plan.counts.update, plan.kept.length, plan.counts.remove], [1, 1, 1], "更新 1・前の内容のまま残す 1・削除 1");
  ok(plan.rows.find((r) => r.title === "支払方法").changes.includes("内容"), "変わる項目を出す");
  ok(!plan.massDelete, "1 件の削除は大量の削除ではない");
  await store.mutate((d) => SH.applySheetPlan(d, src, plan, admin.id, () => store.newId("kn")));
  ok(store.getDb().knowledge.some((k) => k.title === "価格表" && k.body.includes("8,000")), "取り込めない行の資料は前の内容のまま");
  ok(!store.getDb().knowledge.some((k) => k.title === "保証" && k.source === "sheet"), "シートから消した行の資料は削除");
  // 見出しがない・取り込める行がない
  const noHead = [["a", "b"], ["c", "d"]];
  ok(SH.planSheetSync(db, src, csvOf(noHead), noHead).sheetErrors[0].includes("見出し"), "見出しがないシートは同期しない");
  const empty = [head, ["価格表", "", "", "", "", "", "", ""]];
  ok(SH.planSheetSync(store.getDb(), src, csvOf(empty), empty).sheetErrors.some((e) => e.includes("1 行もありません")), "取り込める行が 1 行もなければ、登録済みを消さないよう止める");
  eq(SH.parseVisibility("本部・管理者"), "hq", "見られる人の言い方 (本部・管理者 → 本部以上)");
  eq(SH.parseSheetDate("2026.12.1"), "2026-12-01", "日付の書き方 (2026.12.1)");
}

/* ================================================================== */
section("同期 (一方向・確認のあとの変更・失敗の知らせ・最後の成功・定期実行)");
let sheetText = "";
let sheetMode = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("docs.google.com")) {
    if (sheetMode === "fail") return new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
    return new Response(sheetText, { status: 200, headers: { "content-type": "text/csv" } });
  }
  return realFetch(url, init);
};
const srcId = "ks_sync";
await store.mutate((d) => SY.saveSources(d, [...K.knowledgeSources(d), { id: srcId, label: "FAQ シート", url: "https://docs.google.com/spreadsheets/d/SYNCSHEET999abcdefghijklmnop/edit#gid=0", category: "よくある質問", ownerId: manager.id, visibility: "all" }], admin.id));
const srcNow = () => K.knowledgeSources(store.getDb()).find((s) => s.id === srcId);
const syncCount = () => store.getDb().knowledge.filter((k) => k.sourceRef?.startsWith(SH.sheetPrefix(srcId))).length;
{
  const rows = [head, ...Array.from({ length: 8 }, (_, i) => [`質問 ${i + 1}`, `回答 ${i + 1}`, "", "", "", "", "", ""])];
  sheetText = csvOf(rows);
  const pv = await SY.previewSource(srcId);
  ok(pv.ok && pv.preview.plan.counts.add === 8, "確認 (プレビュー) は書かずに計画だけ");
  eq(syncCount(), 0, "確認では資料を登録しない");
  const hash = pv.preview.plan.hash;
  let r = await SY.syncSource(srcId, admin.id, { trigger: "manual", expectHash: hash });
  ok(r.ok && syncCount() === 8, "確認した内容で同期");
  ok(srcNow().lastSuccessAt && srcNow().history.length === 1 && srcNow().history[0].ok, "最後に成功した日時と同期の記録を残す");
  sheetText = csvOf([...rows, ["質問 9", "回答 9", "", "", "", "", "", ""]]);
  r = await SY.syncSource(srcId, admin.id, { trigger: "manual", expectHash: hash });
  ok(!r.ok && r.blocked && syncCount() === 8, "確認のあとにシートが変わったら同期しない");
  // 失敗: 定期の同期の最初の失敗だけ知らせる (24 時間に 1 回)
  sheetMode = "fail";
  r = await SY.syncSource(srcId, "system", { trigger: "cron" });
  ok(!r.ok && srcNow().failCount === 1 && srcNow().lastNotifiedAt, "定期の同期の失敗: 続けて失敗した回数と、知らせた日時を残す");
  const notified = srcNow().lastNotifiedAt;
  r = await SY.syncSource(srcId, "system", { trigger: "cron" });
  ok(srcNow().failCount === 2 && srcNow().lastNotifiedAt === notified, "同じ失敗は 24 時間に 1 回だけ知らせる");
  eq(syncCount(), 8, "失敗している間も前の資料のまま");
  eq(SY.sourceHealth(srcNow()).tone, "critical", "取込元の状態は「失敗」");
  ok(srcNow().lastSuccessAt, "最後に成功した日時は失敗しても残る");
  // 復旧
  sheetMode = "ok";
  r = await SY.syncSource(srcId, "system", { trigger: "cron" });
  ok(r.ok && srcNow().failCount === 0 && !srcNow().lastNotifiedAt && syncCount() === 9, "復旧: 失敗の回数を 0 に戻し、増えた行を取り込む");
  // 大量の削除: 定期では止める、画面で確かめれば実行
  sheetText = csvOf([head, ["質問 1", "回答 1", "", "", "", "", "", ""]]);
  r = await SY.syncSource(srcId, "system", { trigger: "cron" });
  ok(!r.ok && syncCount() === 9 && srcNow().lastError.includes("消えた行が多い"), "大量の削除は定期の同期では止めて知らせる");
  r = await SY.syncSource(srcId, admin.id, { trigger: "manual", allowMassDelete: true });
  ok(r.ok && syncCount() === 1, "画面で削除を確かめれば同期する");
  // 知らせの文面 (メールを受け取る設定の社員へ)
  const u = { ...manager, notifyByEmail: true, email: "manager@ichijoya.invalid" };
  const out = EV.knowledgeSyncNotices(store.getDb(), [u], { id: srcId, label: "FAQ シート", lastError: "共有されていません", failCount: 2, lastSuccessAt: now }, "failed");
  ok(out.some((o) => o.channel === "email" && o.subject.includes("同期に失敗") && o.body.includes("最後に成功した日時")), "失敗の知らせに理由と最後に成功した日時");
  globalThis.fetch = realFetch;
}
{
  // 定期実行: 実行した時刻を残す (止まっていないかを画面で確かめる) + 確認期限の知らせ (1 日 1 回)
  globalThis.fetch = async (url, init) => (String(url).includes("docs.google.com") ? new Response(sheetText, { status: 200, headers: { "content-type": "text/csv" } }) : realFetch(url, init));
  await store.mutate((d) => {
    const m = d.users.find((x) => x.id === manager.id);
    m.notifyByEmail = true;
    m.notifyEmail = "manager@ichijoya.invalid";
    d.knowledge.push(entry({ title: "期限切れのルール", ownerId: manager.id, visibility: "all", reviewDue: R.addDays(today, -10) }));
  });
  eq(SY.cronHealth(store.getDb()).ok, false, "定期の同期がまだ動いていないと「止まっている」");
  const r = await SY.runKnowledgeCron("system");
  ok(r.results.length >= 1 && SY.cronHealth(store.getDb()).ok, "定期実行の時刻を残す");
  eq(r.reviewNotified, 1, "確認期限を過ぎた資料の担当者に知らせる");
  ok(store.getDb().deliveries.some((d) => d.subject?.includes("社内資料の確認のお願い") && d.recipientLabel === manager.name), "知らせは送信履歴に残る (送信の設定がなければ記録のみ)");
  eq(await SY.reviewDigest("system"), 0, "同じ日に 2 回は知らせない");
  globalThis.fetch = realFetch;
}

/* ================================================================== */
section("長い記録の要約: 期間・内容の絞り込みと根拠のリンク");
{
  const d0 = store.getDb();
  // 記録の多いお客様
  const counts = new Map();
  for (const o of d0.orders) counts.set(o.customerId, (counts.get(o.customerId) ?? 0) + 1);
  for (const c of d0.commLogs) if (c.customerId) counts.set(c.customerId, (counts.get(c.customerId) ?? 0) + 1);
  const cid = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const cust = d0.customers.find((c) => c.id === cid);
  const dg = SUM.recordDigest(d0, admin, "customer", cid);
  ok(dg && dg.sections.length >= 2, `区分ごとの根拠の一覧 (${dg?.sections.map((s) => `${s.label} ${s.items.length}`).join("・")})`);
  const refs = dg.sections.flatMap((s) => s.items.map((x) => x.ref));
  eq(new Set(refs).size, refs.length, "根拠の記号は重ならない");
  ok(dg.sections.every((s) => s.items.every((x) => x.href?.startsWith("/"))), "根拠の 1 件ずつに元の画面へのリンク");
  ok(dg.sections.every((s) => s.items.every((x, i, a) => i === 0 || (a[i - 1].date ?? "") <= (x.date ?? ""))), "区分の中は古い順 (時系列)");
  const only = SUM.recordDigest(d0, admin, "customer", cid, { sections: ["comms"] });
  ok(only.sections.every((s) => s.key === "comms"), "内容の区分で絞れる (やりとりだけ)");
  const dates = dg.sections.flatMap((s) => s.items.map((x) => x.date?.slice(0, 10))).filter(Boolean).sort();
  const mid = dates[Math.floor(dates.length / 2)];
  const ranged = SUM.recordDigest(d0, admin, "customer", cid, { from: mid });
  ok(ranged.sections.every((s) => s.items.every((x) => !x.date || x.date.slice(0, 10) >= mid)) && ranged.scope.includes("期間"), "期間で絞れる (始まりより前の記録を入れない)");
  const other = d0.users.find((u) => u.role === "store_staff" && u.active && u.storeId !== cust.storeId);
  if (other) eq(SUM.recordDigest(d0, other, "customer", cid), null, "ほかの店舗のお客様は要約しない");
  const f = SUM.recordFacts(d0, admin, "customer", cid);
  ok(f && f.facts.includes(cust.name), "文書の作成用の事実の一覧 (互換)");
  const o = d0.orders.find((x) => x.progressNotes.length && x.status !== "cancelled");
  const od = SUM.recordDigest(d0, admin, "order", o.id, { sections: ["progress"] });
  ok(od.sections[0]?.key === "progress" && od.sections[0].items.every((x) => x.href === `/orders/${o.id}`), "受注の進捗の根拠は受注の画面へ");
  // 自動まとめ (AI なし)
  const rr = await SUM.summarizeDigest(dg);
  ok(rr.ok && rr.provider === "rules" && rr.sections.length === dg.sections.length && rr.sources.length === refs.length, "AI のキーがないときは区分ごとの件数・最新の記録でまとめる");
  ok(rr.text.includes(dg.label) && rr.text.includes("【"), "コピー用の全文 (区分ごとの見出しつき)");
  // 塊に分ける
  const big = { key: "comms", label: "やりとり", items: Array.from({ length: 200 }, (_, i) => ({ ref: `C${i + 1}`, date: `2025-${String((i % 12) + 1).padStart(2, "0")}-01`, text: "お客様と電話で打ち合わせ。".repeat(12), label: "電話", href: "/contacts" })) };
  const ch = SUM.chunkSection(big, 6000, 4);
  ok(ch.chunks.length <= 4 && ch.dropped > 0 && ch.chunks.flat().at(-1).ref === "C200", "長い区分は新しいものから塊に分け、古いものは件数だけ");
  ok(ch.chunks.every((c) => c.map((x) => `[${x.ref}] ${x.text}`).join("\n").length <= 6000 + 200), "1 つの塊は目安の文字数まで");
  eq(SUM.cleanRefs("A です [P1]。B です [Z9]。C です [P1, Q99]", new Set(["P1"])), "A です [P1]。B です 。C です [P1]", "記録にない記号は消す");
}

/* ================================================================== */
section("長い記録の要約: AI (モック) で区分ごと → 全体");
{
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      calls.push(body);
      const json = Boolean(body.response_format) || JSON.stringify(body).includes("ichijoya_record_summary");
      const content = json
        ? JSON.stringify({ overview: "大事なやりとりが続いています [C1]。存在しない記号 [Z9]", points: ["最初の相談 [C1]", "最新の連絡 [C200]"], next_actions: ["折り返しの電話"], sections: [{ key: "comms", summary: "・電話の打ち合わせ [C150]" }, { key: "progress", summary: "・施工が進んでいます [P1]" }] })
        : "・期間の要点 [C120]";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", model: "gpt-4.1", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-mock", OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_MODEL: "gpt-4.1" });
  const items = (p, n, len) => Array.from({ length: n }, (_, i) => ({ ref: `${p}${i + 1}`, date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`, text: "記録の内容。".repeat(len), label: `${p}${i + 1}`, href: p === "C" ? "/contacts" : "/orders/o1" }));
  const digest = { kind: "customer", label: "テスト 様", href: "/customers/c1", head: ["テスト 様"], basics: ["顧客 テスト 様"], scope: "全期間 · すべての内容", sections: [{ key: "comms", label: "やりとり", items: items("C", 200, 20) }, { key: "progress", label: "進捗・作業", items: items("P", 5, 5) }] };
  const r = await SUM.summarizeDigest(digest);
  const chunkCalls = calls.filter((c) => !JSON.stringify(c).includes("ichijoya_record_summary")).length;
  ok(r.ok && r.provider === "openai" && r.calls === chunkCalls + 1 && chunkCalls >= 2, `長い区分は期間ごとに要約してから全体をまとめる (AI ${r.calls} 回)`);
  ok(r.calls <= SUM.MAX_CALLS, "AI の呼び出しは上限まで");
  ok(r.overview.includes("[C1]") && !r.overview.includes("Z9"), "全体の要約の記号: 記録にないものは消す");
  eq(r.sections.map((s) => s.key), ["comms", "progress"], "区分ごとの要約");
  ok(r.sections[0].used < r.sections[0].count, "多すぎる記録は新しいものから要約し、使った件数を示す");
  ok(r.sources.length === 205, "根拠の記録はすべて一覧に出す (要約に使わなかった古いものも)");
  const small = { ...digest, sections: [{ key: "progress", label: "進捗・作業", items: items("P", 3, 3) }] };
  calls.length = 0;
  const r2 = await SUM.summarizeDigest(small);
  ok(r2.calls === 1 && calls.length === 1, "短い記録は 1 回でまとめる");
  server.close();
  for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) delete process.env[k];
}

summary();
process.exit(process.exitCode ?? 0);
