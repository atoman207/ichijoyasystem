import "server-only";
import type { Database, User } from "@/lib/db/types";
import { canApprove, canSeeAllStores, canViewKnowledge, scopeByStore } from "@/lib/auth/permissions";
import { monthlySales, storeKpis } from "@/lib/db/queries";
import { addDays, fmtDate, fmtMonth, toDateKey, toMonthKey, yen } from "@/lib/format";
import { APPROVAL_TYPE_LABEL, CHANNEL_LABEL, INQUIRY_STATUS, ORDER_STATUS, SCHEDULE_KIND } from "@/lib/constants";
import { analyzeConflicts, compareEvents, occursOn, overlapsRange, periodLabel, shortDate, timeLabel } from "@/lib/calendar";
import { aiEnabled } from "./provider";
import { searchRecords } from "./search";
import { isStrongHit, searchKnowledge, type KnowledgeHit } from "@/lib/knowledge";

/**
 * AI アシスタント
 * ------------------------------------------------------------
 * 一元化されたデータを使って、問い合わせ対応・検索・集計・文面作成を支援する。
 * - AI の API キー (OpenAI / Anthropic。src/lib/ai/provider.ts) があれば、「ユーザーの権限で見える範囲のデータ要約」を
 *   コンテキストとして渡して回答する
 * - 無ければ、キーワードに基づくルールベースの回答 (同じデータソース) を返す
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const name = (db: Database, id?: string) => db.users.find((u) => u.id === id)?.name ?? "-";
const cname = (db: Database, id?: string) => db.customers.find((c) => c.id === id)?.name ?? "-";
const sname = (db: Database, id: string) => db.stores.find((s) => s.id === id)?.name ?? id;

/** ユーザー権限内のデータ要約 (Claude のコンテキスト兼ルール回答の材料) */
export function buildContext(db: Database, user: User, now = new Date()) {
  const today = toDateKey(now);
  const all = canSeeAllStores(user);
  const kpis = storeKpis(db, now).filter((k) => all || k.storeId === user.storeId);
  // 店舗のロールには自店舗の売上だけを渡す (レポート・ダッシュボードと同じ閲覧範囲)
  const sales = monthlySales(db, 6, now).map((m) => {
    if (all) return m;
    const own = m.byStore[user.storeId] ?? 0;
    const byStore = Object.fromEntries(Object.keys(m.byStore).map((s) => [s, s === user.storeId ? own : 0])) as typeof m.byStore;
    return { ...m, byStore, total: own };
  });
  const pending = db.approvals.filter((a) => a.status === "pending" && (all || a.storeId === user.storeId));
  const mine = pending.filter((a) => canApprove(user, a));
  const invoices = scopeByStore(user, db.invoices).filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status));
  const overdue = invoices.filter((i) => i.status === "overdue" || i.dueDate < today);
  // 予定表は全社共有。回答には自店舗・全社共通・自分の担当の予定を使う (全店舗ロールは全件)
  const events = db.schedule
    .filter((e) => overlapsRange(e, today, addDays(today, 7)) && (all || e.storeId === user.storeId || e.companyWide || e.assigneeIds.includes(user.id)))
    .sort(compareEvents);
  const inquiries = scopeByStore(user, db.inquiries).filter((i) => ["new", "in_progress"].includes(i.status)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const jobs = scopeByStore(user, db.orders).filter((o) => ["confirmed", "scheduled", "in_progress"].includes(o.status));
  const month = toMonthKey(now);
  const expenses = scopeByStore(user, db.expenses).filter((e) => e.date.startsWith(month) && e.status !== "draft" && e.status !== "rejected" && e.status !== "denied");
  const purchases = all ? db.purchases.filter((p) => p.status !== "paid" && p.status !== "rejected") : [];
  return { today, all, kpis, sales, pending, mine, invoices, overdue, events, inquiries, jobs, expenses, purchases };
}

/* ------------------------------------------------------------------ */
/* ルールベース回答                                                      */
/* ------------------------------------------------------------------ */

export function rulesAnswer(db: Database, user: User, q: string, now = new Date()): string {
  const ctx = buildContext(db, user, now);
  const has = (...ws: string[]) => ws.some((w) => q.includes(w));
  // 顧客・案件の検索 (名前の敬称・番号・電話番号・「」の言葉) を最初に見る
  const found = searchRecords(db, user, q);
  if (found.context) return `検索の結果です (閲覧できる店舗の記録から)。\n\n${found.context}\n\n番号・名前をクリックすると詳しい画面を開きます。`;
  // 社内資料にはっきり当てはまるとき (例: 「支払方法は？」に資料「お支払い方法」) は、集計のルールより先に答える
  const strong = searchKnowledge(db.knowledge.filter((k) => canViewKnowledge(user, k)), q, { limit: 3 });
  if (isStrongHit(strong[0])) return knowledgeAnswer(strong);

  if (has("売上", "うりあげ", "業績")) {
    const total = ctx.kpis.reduce((a, k) => a + k.salesThisMonth, 0);
    const last = ctx.kpis.reduce((a, k) => a + k.salesLastMonth, 0);
    const rows = ctx.kpis.map((k) => `・${sname(db, k.storeId)}: ${yen(k.salesThisMonth)} (先月 ${yen(k.salesLastMonth)}, 年初来 ${yen(k.salesYtd)})`).join("\n");
    const trend = ctx.sales.map((m) => `${fmtMonth(m.month)} ${yen(m.total)}`).join(" / ");
    return `今月 (${fmtMonth(toMonthKey(now))}) の売上は **${yen(total)}** です (先月 ${yen(last)}、前月比 ${last ? Math.round(((total - last) / last) * 100) : 0}%)。\n\n${rows}\n\n直近6か月の推移: ${trend}\n\n※ 施工完了 (売上計上日) ベース・税込。詳細は「レポート・分析」で確認できます。`;
  }
  if (has("未入金", "売掛", "入金", "督促", "回収")) {
    if (ctx.invoices.length === 0) return "未入金の請求はありません。";
    const list = ctx.invoices.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 8).map((i) => `・${i.number} ${cname(db, i.customerId)} 様: 残 ${yen(i.total - i.paidAmount)} (期限 ${fmtDate(i.dueDate)}${i.dueDate < ctx.today ? " ⚠ 超過" : ""})`).join("\n");
    return `未入金の請求は ${ctx.invoices.length} 件、合計 ${yen(ctx.invoices.reduce((a, i) => a + i.total - i.paidAmount, 0))} です。うち期日超過は ${ctx.overdue.length} 件。\n\n${list}\n\n期日超過分は「請求・入金」画面から督促の記録と入金登録ができます。`;
  }
  if (has("承認")) {
    if (ctx.pending.length === 0) return "承認待ちの案件はありません。";
    const list = ctx.pending.slice(0, 10).map((a) => `・[${APPROVAL_TYPE_LABEL[a.type]}] ${a.title} — ${yen(a.amount)} (申請: ${name(db, a.requestedBy)}, ${a.requiredRole === "admin" ? "管理者" : "店長"}承認)`).join("\n");
    return `承認待ちは ${ctx.pending.length} 件です。あなたが承認できるものは ${ctx.mine.length} 件。\n\n${list}\n\n「承認」画面で内容を確認のうえ承認・却下できます。`;
  }
  if (has("重複", "ダブルブッキング", "かぶ", "被")) {
    const pairs = analyzeConflicts(ctx.events).pairs;
    if (pairs.length === 0) return "今後7日間、担当者の予定の重複はありません。";
    const list = pairs
      .slice(0, 10)
      .map((p) => {
        const a = ctx.events.find((e) => e.id === p.aId);
        const b = ctx.events.find((e) => e.id === p.bId);
        return a && b ? `・${shortDate(p.day)} ${name(db, p.userId)}: ${timeLabel(a)}「${a.title}」と ${timeLabel(b)}「${b.title}」` : "";
      })
      .filter(Boolean)
      .join("\n");
    return `今後7日間で担当者の予定が重複しているのは ${pairs.length} 件です。\n\n${list}\n\n「予定表」の担当者別・日表示で空いている社員を確認し、日時か担当者を調整してください。`;
  }
  if (has("予定", "今日", "本日", "明日", "スケジュール", "今週")) {
    const target = has("明日") ? addDays(ctx.today, 1) : has("今週") ? null : ctx.today;
    const list = ctx.events.filter((e) => !target || occursOn(e, target));
    if (list.length === 0) return `${target ? fmtDate(target) : "今週"}の予定はありません。`;
    return `${target ? fmtDate(target, { weekday: true }) : "今後7日"}の予定 (${list.length} 件):\n\n${list.map((e) => `・${target ? timeLabel(e) : periodLabel(e)} [${SCHEDULE_KIND[e.kind].label}] ${e.title} — ${sname(db, e.storeId)}${e.companyWide ? " (全社共通)" : ""} / ${e.assigneeIds.map((a) => name(db, a)).join("・") || "担当者なし"}${e.location ? ` @${e.location}` : ""}`).join("\n")}\n\n予定表 (全社カレンダー) では全店舗・全社員の予定を確認できます。`;
  }
  if (has("問い合わせ", "問合せ", "未対応", "対応中")) {
    if (ctx.inquiries.length === 0) return "未対応・対応中の問い合わせはありません。";
    return `未対応・対応中の問い合わせは ${ctx.inquiries.length} 件です。\n\n${ctx.inquiries.slice(0, 10).map((i) => `・${i.number} [${CHANNEL_LABEL[i.channel]}] ${i.contactName}: ${i.summary} (${INQUIRY_STATUS[i.status].label}, 担当 ${name(db, i.assignedUserId)}${i.nextAction ? `, 次: ${i.nextAction}` : ""})`).join("\n")}`;
  }
  if (has("施工", "工事", "現場", "進行中")) {
    if (ctx.jobs.length === 0) return "進行中の施工はありません。";
    return `進行中の施工は ${ctx.jobs.length} 件です。\n\n${ctx.jobs.slice(0, 10).map((o) => `・${o.number} ${cname(db, o.customerId)} 様 ${o.title} — ${ORDER_STATUS[o.status].label}, 施工予定 ${o.scheduledStart ? fmtDate(o.scheduledStart) : "未定"}, 担当 ${o.workerIds.map((w) => name(db, w)).join("・")}`).join("\n")}`;
  }
  if (has("経費", "レシート", "ガソリン")) {
    const byAcc = new Map<string, number>();
    for (const e of ctx.expenses) byAcc.set(e.account, (byAcc.get(e.account) ?? 0) + e.amount);
    return `今月の経費は ${yen(ctx.expenses.reduce((a, e) => a + e.amount, 0))} (${ctx.expenses.length} 件) です。\n\n${[...byAcc.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `・${k}: ${yen(v)}`).join("\n")}\n\n承認待ちの経費は ${ctx.pending.filter((a) => a.type === "expense").length} 件です。`;
  }
  if (has("仕入", "買掛", "支払")) {
    if (!ctx.all) return "仕入・買掛の情報は本部スタッフ・管理者のみ参照できます。";
    return `未払の仕入請求は ${ctx.purchases.length} 件、合計 ${yen(ctx.purchases.reduce((a, p) => a + p.amount, 0))} です。\n\n${ctx.purchases.map((p) => `・${p.number} ${db.suppliers.find((s) => s.id === p.supplierId)?.name}: ${yen(p.amount)} (期限 ${fmtDate(p.dueDate)}, ${p.status === "pending_approval" ? "支払依頼中" : p.status === "approved" ? "支払待ち (承認済)" : p.status === "disputed" ? "差戻し (照会中)" : "受領"})`).join("\n")}`;
  }
  if (has("文面", "返信", "メール", "LINE", "案内文", "テンプレ")) {
    return `以下は見積送付時の文面例です。お客様名・金額・施工日はシステムの情報で自動的に差し込めます。\n\n---\n○○ 様\n\nこのたびはお問い合わせいただき、誠にありがとうございます。\n株式会社一畳屋 ${sname(db, user.storeId)} の ${user.name} です。\n\nご依頼いただきました「和室6畳 畳表替え (さくら)」のお見積書 (合計 ¥121,000 税込) をお送りいたします。\n工賃・配送・古畳の処分費を含んだ金額です。土・祝日の施工もご予約にて承ります。\n\nご不明な点がございましたら、お電話 (0120-158-108) または LINE にてお気軽にお問い合わせください。\n\n株式会社一畳屋 ${sname(db, user.storeId)}\n---`;
  }
  // 社内資料
  const hits = searchKnowledge(db.knowledge.filter((k) => canViewKnowledge(user, k)), q, { limit: 3 });
  if (hits.length) return knowledgeAnswer(hits);
  // 顧客検索 (姓だけ)
  const custHit = scopeByStore(user, db.customers).filter((c) => q.includes(c.name.split(" ")[0]) && c.name.split(" ")[0].length >= 2);
  if (custHit.length > 0 && has("顧客", "様", "さん", "履歴", "電話", "住所")) {
    return custHit.slice(0, 3).map((c) => {
      const orders = db.orders.filter((o) => o.customerId === c.id);
      const last = orders.sort((a, b) => b.contractDate.localeCompare(a.contractDate))[0];
      const open = db.inquiries.filter((i) => i.customerId === c.id && ["new", "in_progress", "quoted"].includes(i.status));
      return `**${c.name}** 様 (${c.code}, ${sname(db, c.storeId)})\n・電話: ${c.phone} / 希望連絡手段: ${CHANNEL_LABEL[c.preferredChannel]}\n・住所: ${c.address}\n・案件数: ${orders.length} 件、累計売上 ${yen(orders.filter((o) => o.salesDate).reduce((a, o) => a + o.total, 0))}\n・最新の受注: ${last ? `${last.title} (${fmtDate(last.contractDate)}, ${ORDER_STATUS[last.status].label})` : "なし"}\n・進行中の問い合わせ: ${open.length} 件\n・担当: ${name(db, c.assignedUserId)}`;
    }).join("\n\n");
  }
  if (has("店舗", "比較", "成績", "どの店")) {
    const best = [...ctx.kpis].sort((a, b) => b.salesThisMonth - a.salesThisMonth)[0];
    return `店舗別の今月の状況:\n\n${ctx.kpis.map((k) => `・${sname(db, k.storeId)}: 売上 ${yen(k.salesThisMonth)} / 受注 ${k.orderCount} 件 / 成約率 ${Math.round(k.quoteWinRate * 100)}% / 未対応 ${k.openInquiries} 件 / 売掛 ${yen(k.receivables)}`).join("\n")}\n\n今月の売上トップは ${best ? sname(db, best.storeId) : "-"} です。`;
  }
  return `ご質問の意図を特定できませんでした。次のような質問に答えられます:\n\n・「田中様の履歴」「O-2026-0012 の状況」「090-1234-5678 のお客様」(顧客・案件の検索)\n・社内資料 (ナレッジ) に登録した内容 (支払方法・商品の価格の目安・作業手順など)\n・「今月の売上は？」「店舗ごとの比較」\n・「未入金の請求は？」「期日超過の督促対象」\n・「承認待ちの案件」\n・「今日の予定」「明日の予定」「今週の予定」「予定の重複」\n・「未対応の問い合わせ」「進行中の施工」\n・「今月の経費」「未払の仕入」\n・「○○様の履歴」(顧客名で検索)\n・「見積送付の文面を作って」\n\n${aiEnabled() ? "" : "※ 本番環境では Claude が自然文で回答し、データ検索・集計・資料作成を行います。"}`;
}

/* ------------------------------------------------------------------ */

function knowledgeAnswer(hits: KnowledgeHit[]): string {
  return `社内資料から関係しそうな内容です。\n\n${hits.map((h) => `**${h.entry.title}** (${h.entry.category})\n${h.snippet}`).join("\n\n")}\n\n詳しくは「社内資料 (ナレッジ)」の画面で確認してください。`;
}
