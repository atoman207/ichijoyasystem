import type { Database } from "@/lib/db/types";
import { goLiveChecks, migrationChecks, type CheckStatus } from "@/lib/golive";
import Link from "@/components/ui/Link";
import { Badge, Card, CardHeader, Note } from "@/components/ui";

const STATUS: Record<CheckStatus, { label: string; tone: "good" | "warn" | "critical" | "neutral" }> = {
  ok: { label: "OK", tone: "good" },
  warn: { label: "要確認", tone: "warn" },
  ng: { label: "要対応", tone: "critical" },
  info: { label: "参考", tone: "neutral" },
};

/** 設定 → 本番運用の準備: 自動の確認結果と、移行データの確認 */
export function GoLivePanel({ db }: { db: Database }) {
  const groups = goLiveChecks(db);
  const data = migrationChecks(db);
  const all = groups.flatMap((g) => g.items);
  const ng = all.filter((i) => i.status === "ng").length;
  const warn = all.filter((i) => i.status === "warn").length;
  return (
    <div className="space-y-4">
      <Note tone={ng ? "warn" : "neutral"}>
        本番運用の前に確かめる項目を、この画面を開いたときに自動で確認しています (秘密の値は表示しません)。要対応 {ng} 件・要確認 {warn} 件。サーバーの作業手順は deploy/README.md にまとめています。
      </Note>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        {groups.map((g) => (
          <Card key={g.title}>
            <CardHeader title={g.title} />
            <ul className="space-y-2">
              {g.items.map((i) => (
                <li key={i.label} className="text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-ink">{i.label}</span>
                    <Badge tone={STATUS[i.status].tone} dot={false}>{STATUS[i.status].label}</Badge>
                  </div>
                  <div className="text-xs text-ink-2">{i.detail}</div>
                  {i.fix && i.status !== "ok" && i.status !== "info" && <div className="mt-0.5 text-xs text-warn-ink">対応: {i.fix}</div>}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      <Card padded={false}>
        <div className="px-5 pt-5"><CardHeader title="移行データの確認" description={`顧客 ${db.customers.length.toLocaleString("ja-JP")} 件・問い合わせ ${db.inquiries.length.toLocaleString("ja-JP")} 件・受注 ${db.orders.length.toLocaleString("ja-JP")} 件・請求 ${db.invoices.length.toLocaleString("ja-JP")} 件・社員 ${db.users.length} 人`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-5 py-2 text-left font-medium">確認</th><th className="px-3 py-2 text-right font-medium">件数</th><th className="px-3 py-2 text-left font-medium">状態</th><th className="px-5 py-2 text-left font-medium">説明</th></tr></thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label} className="border-t border-line align-top">
                  <td className="px-5 py-2">{d.href ? <Link href={d.href} className="text-accent hover:underline">{d.label}</Link> : d.label}</td>
                  <td className="px-3 py-2 text-right tnum">{d.count.toLocaleString("ja-JP")} <span className="text-[11px] text-ink-3">/ {d.total.toLocaleString("ja-JP")}</span></td>
                  <td className="px-3 py-2"><Badge tone={STATUS[d.status].tone} dot={false}>{STATUS[d.status].label}</Badge></td>
                  <td className="px-5 py-2 text-xs text-ink-2">{d.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
