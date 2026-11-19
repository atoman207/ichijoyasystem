import "server-only";
import type { Database } from "@/lib/db/types";
import { migrationChecks, type DataCheck } from "@/lib/golive";
import { normName, normText } from "@/lib/duplicates";

/**
 * AI アシスタントの回答に影響するデータの品質 (元のデータが誤っていれば、AI も誤った結果を返す)
 * ------------------------------------------------------------
 * 移行データの確認 (golive.ts の migrationChecks) に、AI の検索・集計で困る点を足したもの。読むだけで、データは変えない。
 * 件数と、直す画面へのリンクを出す (直すのは人。顧客の統合は顧客の画面の「重複の候補」から)
 */

export interface QualityCheck extends DataCheck {
  /** 何に影響するか */
  impact: string;
  /** 例 (最大 5 件。名前・番号とリンク) */
  examples?: { label: string; href?: string }[];
}

const DONE_STATUSES = new Set(["completed", "invoiced", "paid"]);

function normAddr(s: string | undefined): string {
  return normText(s)
    .replace(/[‐‑‒–—―ー−－]/g, "-")
    .replace(/^熊本県/u, "")
    .replace(/(丁目|番地|番|号)/gu, "-")
    .replace(/-+$/u, "");
}

export function dataQualityChecks(db: Database, now = new Date()): QualityCheck[] {
  const IMPACT: Record<string, string> = {
    "電話番号のない顧客": "電話番号での顧客の検索・AI 電話受付の照合",
    "住所のない顧客": "地区別の集計・現場の検索",
    "電話番号が同じ顧客": "顧客の件数・累計売上・前回の担当者が分かれて出る",
    "顧客が見つからない受注": "顧客ごとの売上・施工履歴から漏れる",
    "受注が見つからない請求": "案件の流れ (受注 → 請求 → 入金) が途切れる",
    "担当者が退職・未登録の対応中の問い合わせ": "担当者ごとの件数・予定の提案",
    "担当者のいない未対応の問い合わせ": "担当者ごとの件数",
  };
  const base: QualityCheck[] = migrationChecks(db).map((c) => ({ ...c, impact: IMPACT[c.label] ?? "検索・集計" }));

  // 名前と住所が同じ顧客 (重複の疑い)
  const byNameAddr = new Map<string, { id: string; name: string }[]>();
  for (const c of db.customers) {
    const a = normAddr(c.address);
    if (!a || a.length < 6) continue;
    const k = `${normName(c.name)}|${a}`;
    const list = byNameAddr.get(k) ?? [];
    list.push({ id: c.id, name: c.name });
    byNameAddr.set(k, list);
  }
  const dupNameAddr = [...byNameAddr.values()].filter((l) => l.length > 1);
  base.push({
    label: "名前と住所が同じ顧客",
    count: dupNameAddr.reduce((a, l) => a + l.length, 0),
    total: db.customers.length,
    status: dupNameAddr.length ? "warn" : "ok",
    note: "同じお客様が重複して登録されている疑い。顧客の画面の「重複の候補」から統合してください",
    href: "/customers",
    impact: "顧客の件数・累計売上・施工履歴が分かれて出る",
    examples: dupNameAddr.slice(0, 5).map((l) => ({ label: `${l[0].name} (${l.length} 件)`, href: `/customers/${l[0].id}` })),
  });

  // 電話番号の書き方 (全角の数字・ハイフンの有無が混在)
  const phones = db.customers.map((c) => c.phone ?? "").filter((p) => p.replace(/\D/g, "").length >= 9 || /[０-９]/.test(p));
  const full = phones.filter((p) => /[０-９－ー]/.test(p)).length;
  const hyphen = phones.filter((p) => /[-‐－ー−]/.test(p)).length;
  const noHyphen = phones.length - hyphen;
  const minority = Math.min(hyphen, noHyphen) + full;
  base.push({
    label: "電話番号の書き方の揺れ (全角・ハイフンの有無)",
    count: minority,
    total: phones.length,
    status: minority ? "info" : "ok",
    note: `ハイフンあり ${hyphen} 件・なし ${noHyphen} 件・全角 ${full} 件。照合は数字だけで行うので検索はできますが、画面の表示がそろいません`,
    href: "/customers",
    impact: "表示の統一 (検索は数字だけで照合するため影響は小さい)",
  });

  // 施工が終わったのに売上計上日がない受注 (売上の集計から漏れる)
  const noSalesDate = db.orders.filter((o) => DONE_STATUSES.has(o.status) && !o.salesDate);
  base.push({
    label: "施工完了なのに売上計上日がない受注",
    count: noSalesDate.length,
    total: db.orders.filter((o) => DONE_STATUSES.has(o.status)).length,
    status: noSalesDate.length ? "warn" : "ok",
    note: "売上 (売上計上日で数える) の集計に入りません",
    href: "/orders",
    impact: "売上・店舗別・担当者別の集計",
    examples: noSalesDate.slice(0, 5).map((o) => ({ label: `${o.number} ${o.title}`.slice(0, 40), href: `/orders/${o.id}` })),
  });

  // 入金が見つからない請求の入金 (請求のない入金)
  const invoiceIds = new Set(db.invoices.map((i) => i.id));
  const orphanPayments = db.payments.filter((p) => !invoiceIds.has(p.invoiceId));
  base.push({ label: "請求が見つからない入金", count: orphanPayments.length, total: db.payments.length, status: orphanPayments.length ? "warn" : "ok", note: "未入金の残高・入金の集計が合わなくなります", impact: "未入金・入金の集計" });

  // 入金済みの金額と請求の状態の食い違い (全額入金なのに未入金のまま など)
  const paidSum = new Map<string, number>();
  for (const p of db.payments) paidSum.set(p.invoiceId, (paidSum.get(p.invoiceId) ?? 0) + p.amount);
  const mismatch = db.invoices.filter((i) => i.status !== "void" && Math.abs((paidSum.get(i.id) ?? 0) - i.paidAmount) >= 1);
  base.push({
    label: "入金の記録と請求の入金済み額が合わない請求",
    count: mismatch.length,
    total: db.invoices.length,
    status: mismatch.length ? "warn" : "ok",
    note: "請求の「入金済み」と、入金の記録の合計が違います (移行時の入金・手で直した請求など)",
    href: "/invoices",
    impact: "未入金の残高・入金の集計",
    examples: mismatch.slice(0, 5).map((i) => ({ label: i.number, href: `/invoices/${i.id}` })),
  });

  // 担当者 (作成者) が社員にいない受注
  const userIds = new Set(db.users.map((u) => u.id));
  const unknownStaff = db.orders.filter((o) => o.createdBy && !userIds.has(o.createdBy));
  base.push({ label: "担当者が社員の一覧にいない受注", count: unknownStaff.length, total: db.orders.length, status: unknownStaff.length ? "info" : "ok", note: "移行した過去の受注の担当者 (退職者など)。担当者別の集計で名前が出ません", impact: "担当者別の売上・前回の担当者" });

  // 商品マスタの品名の表記ゆれ (空白・全角半角だけ違う)
  const byName = new Map<string, Set<string>>();
  for (const p of db.products) {
    const k = `${normText(p.name)}|${p.sizeLabel ?? ""}|${p.grade ?? ""}`;
    const s = byName.get(k) ?? new Set<string>();
    s.add(p.name);
    byName.set(k, s);
  }
  const variants = [...byName.values()].filter((s) => s.size > 1);
  base.push({ label: "商品マスタの品名の表記ゆれ", count: variants.length, total: db.products.length, status: variants.length ? "warn" : "ok", note: "空白・全角半角だけが違う品名。商品別の集計が分かれます", href: "/materials", impact: "商品別の売上・数量・単価", examples: variants.slice(0, 5).map((s) => ({ label: [...s].join(" / ").slice(0, 60) })) });

  // 社内資料: 1 年以上更新されていない・同じタイトルが複数 (古い版が残っている)
  const yearAgo = new Date(now.getTime() - 365 * 86400_000).toISOString();
  const activeKnow = db.knowledge.filter((k) => k.active);
  const stale = activeKnow.filter((k) => (k.updatedAt ?? k.createdAt) < yearAgo);
  base.push({ label: "1 年以上更新されていない社内資料", count: stale.length, total: activeKnow.length, status: stale.length ? "info" : "ok", note: "内容が今も正しいか確かめ、古い版は「AI に使わない」にしてください", href: "/knowledge", impact: "社内資料にもとづく回答", examples: stale.slice(0, 5).map((k) => ({ label: k.title.slice(0, 40), href: `/knowledge/${k.id}` })) });
  const titles = new Map<string, typeof activeKnow>();
  for (const k of activeKnow) {
    const t = normText(k.title);
    titles.set(t, [...(titles.get(t) ?? []), k]);
  }
  const dupTitles = [...titles.values()].filter((l) => l.length > 1);
  base.push({ label: "同じタイトルの社内資料が複数", count: dupTitles.reduce((a, l) => a + l.length, 0), total: activeKnow.length, status: dupTitles.length ? "warn" : "ok", note: "古い版が残っていると、AI が古い内容で答えることがあります", href: "/knowledge", impact: "社内資料にもとづく回答", examples: dupTitles.slice(0, 5).map((l) => ({ label: `${l[0].title.slice(0, 30)} (${l.length} 件)`, href: `/knowledge/${l[0].id}` })) });

  // 無効なアカウントのまま残っている社員 (担当者の候補に出ない)
  const inactive = db.users.filter((u) => !u.active);
  base.push({ label: "無効になっている社員のアカウント", count: inactive.length, total: db.users.length, status: "info", note: "退職者などは無効のままで構いません (過去の担当者として名前は残ります)", href: "/staff", impact: "担当者の名前の照合" });

  return base.map((r) => ({ ...r, status: r.count === 0 ? "ok" : r.status }));
}
