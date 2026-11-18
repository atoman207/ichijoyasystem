import Link from "@/components/ui/Link";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import type { Database, FaxMessage, PurchaseOrder, User } from "@/lib/db/types";
import { canViewFax, canViewPurchaseOrder } from "@/lib/auth/permissions";
import { FAX_AI_LABEL, FAX_STATUS, FAX_TRIAGE, PURCHASE_ORDER_STATUS } from "@/lib/constants";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fmtFax } from "@/lib/fax/numbers";
import { faxConnection, faxLocalNumber } from "@/lib/fax/adapter";
import { Badge, Card, CardHeader, EmptyRow, Note, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";

/** FAX の状態のバッジ (受信は仕分け、送信は送信の状態) */
export function FaxBadge({ f }: { f: FaxMessage }) {
  if (f.direction === "inbound") {
    return (
      <span className="inline-flex flex-wrap gap-1">
        <StatusBadge value={f.triage ?? "review"} map={FAX_TRIAGE} />
        {f.ai && f.triage === "review" && <Badge tone={FAX_AI_LABEL[f.ai.label].tone} dot={false}>AI: {FAX_AI_LABEL[f.ai.label].label}</Badge>}
        {f.aiPending && <Badge tone="neutral" dot={false}>AI 判定待ち</Badge>}
      </span>
    );
  }
  return <StatusBadge value={f.status} map={FAX_STATUS} />;
}

/** FAX の一覧の表 */
export function FaxTable({ db, rows, empty = "FAX はありません" }: { db: Database; rows: FaxMessage[]; empty?: string }) {
  const pos = new Map(db.purchaseOrders.map((p) => [p.id, p]));
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  return (
    <Table minWidth="min-w-[820px]">
      <thead>
        <tr>
          <Th>番号</Th>
          <Th>日時</Th>
          <Th>相手</Th>
          <Th>状態</Th>
          <Th>発注書・案件</Th>
          <Th>担当</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <EmptyRow colSpan={6}>{empty}</EmptyRow>}
        {rows.map((f) => {
          const po = f.purchaseOrderId ? pos.get(f.purchaseOrderId) : undefined;
          const Icon = f.direction === "inbound" ? ArrowDownLeft : ArrowUpRight;
          return (
            <Tr key={f.id}>
              <Td className="whitespace-nowrap font-mono text-xs">
                <Link href={`/fax/${f.id}`} className="inline-flex items-center gap-1 text-accent hover:underline">
                  <Icon className={`h-3.5 w-3.5 ${f.direction === "inbound" ? "text-good-ink" : "text-accent"}`} aria-label={f.direction === "inbound" ? "受信" : "送信"} />
                  {f.number}
                </Link>
                {f.direction === "inbound" && f.purchaseOrderId && !f.checkedAt && <div className="font-sans text-[11px] text-warn-ink">未確認</div>}
              </Td>
              <Td className="whitespace-nowrap text-xs tnum">{fmtDateTime(f.at)}</Td>
              <Td>
                <div className="text-sm">{f.remoteName ?? f.ai?.senderName ?? (f.direction === "inbound" ? "(未登録の番号)" : "-")}</div>
                <div className="text-xs text-ink-3 tnum">{fmtFax(f.remoteNumber) || "番号不明"}</div>
              </Td>
              <Td><FaxBadge f={f} /></Td>
              <Td className="text-xs">
                {po ? <Link href={`/purchase-orders/${po.id}`} className="font-mono text-accent hover:underline">{po.number}</Link> : <span className="text-ink-3">-</span>}
                {f.orderIds.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-1 font-mono">
                    {f.orderIds.slice(0, 4).map((id) => <Link key={id} href={`/orders/${id}`} className="text-ink-2 hover:text-accent">{orders.get(id)?.number ?? "-"}</Link>)}
                    {f.orderIds.length > 4 && <span className="text-ink-3">ほか {f.orderIds.length - 4} 件</span>}
                  </div>
                )}
              </Td>
              <Td className="text-xs">{users.get(f.assignedUserId ?? (f.direction === "outbound" ? f.userId : "")) ?? "-"}</Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** 案件・仕入先・発注書の画面に出す FAX の履歴 */
export function FaxHistoryCard({ db, user, faxes, title = "FAX の送受信", description, action }: { db: Database; user: User; faxes: FaxMessage[]; title?: string; description?: string; action?: React.ReactNode }) {
  const rows = faxes.filter((f) => canViewFax(user, f)).sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Card padded={false}>
      <div className="p-5 pb-0">
        <CardHeader title={title} description={description ?? `送信 ${rows.filter((f) => f.direction === "outbound").length} 件 · 受信 ${rows.filter((f) => f.direction === "inbound").length} 件`} action={action} />
      </div>
      <div className="px-2 pb-2">
        <FaxTable db={db} rows={rows.slice(0, 30)} empty="FAX の記録はまだありません" />
      </div>
    </Card>
  );
}

/** 発注書の一覧の表 (案件・仕入先の画面) */
export function PurchaseOrderTable({ db, user, rows, empty = "発注書はまだありません" }: { db: Database; user: User; rows: PurchaseOrder[]; empty?: string }) {
  const suppliers = new Map(db.suppliers.map((s) => [s.id, s.name]));
  const orders = new Map(db.orders.map((o) => [o.id, o.number]));
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const visible = rows.filter((p) => canViewPurchaseOrder(user, p));
  return (
    <Table minWidth="min-w-[720px]">
      <thead>
        <tr>
          <Th>発注番号</Th>
          <Th>仕入先</Th>
          <Th>案件</Th>
          <Th>発注日 / 希望納期</Th>
          <Th>状態</Th>
          <Th>作成</Th>
        </tr>
      </thead>
      <tbody>
        {visible.length === 0 && <EmptyRow colSpan={6}>{empty}</EmptyRow>}
        {visible.map((p) => (
          <Tr key={p.id}>
            <Td className="whitespace-nowrap font-mono text-xs">
              <Link href={`/purchase-orders/${p.id}`} className="text-accent hover:underline">{p.number}</Link>
              {p.version > 1 && <div className="font-sans text-[11px] text-ink-3">第{p.version}版</div>}
            </Td>
            <Td className="text-sm">{suppliers.get(p.supplierId) ?? "-"}<div className="text-xs text-ink-3">明細 {p.lines.length} 行</div></Td>
            <Td className="font-mono text-xs">
              {p.orderIds.slice(0, 3).map((id) => <div key={id}><Link href={`/orders/${id}`} className="text-ink-2 hover:text-accent">{orders.get(id) ?? "-"}</Link></div>)}
              {p.orderIds.length > 3 && <div className="font-sans text-ink-3">ほか {p.orderIds.length - 3} 件</div>}
              {p.orderIds.length === 0 && <span className="text-ink-3">-</span>}
            </Td>
            <Td className="whitespace-nowrap text-xs tnum">{fmtDate(p.issuedOn)}<div className="text-ink-3">{p.desiredDate ? `納期 ${fmtDate(p.desiredDate)}` : "納期 指定なし"}</div></Td>
            <Td><StatusBadge value={p.status} map={PURCHASE_ORDER_STATUS} /></Td>
            <Td className="text-xs">{users.get(p.createdBy) ?? "-"}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

/** FAX サービスの接続の状態 */
export function FaxConnectionNote() {
  const c = faxConnection();
  const local = faxLocalNumber();
  const tone = c.mode === "live" ? "neutral" : c.mode === "mock" ? "accent" : "warn";
  return (
    <Note tone={tone}>
      <span className="font-semibold">FAX サービス: {c.label}</span>
      {local ? ` · 自社の FAX 番号 ${local}` : " · 自社の FAX 番号は未設定 (FAX_NUMBER)"}
      <br />
      {c.detail}
    </Note>
  );
}
