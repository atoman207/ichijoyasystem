import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, canTriageFax, canViewFax } from "@/lib/auth/permissions";
import { FAX_NUMBER_KIND_LABEL, FAX_STATUS } from "@/lib/constants";
import { addBlockedNumber, mockReceiveAd, removeFaxNumber, uploadFax } from "@/lib/actions/fax";
import { faxConnection } from "@/lib/fax/adapter";
import { fmtFax, normFax, normRef } from "@/lib/fax/numbers";
import { fmtDateTime } from "@/lib/format";
import type { FaxMessage, FaxStatus } from "@/lib/db/types";
import { Button, Card, CardHeader, EmptyRow, Flash, Input, LinkButton, LinkTabs, PageHeader, Pager, Select, Stat, Table, Td, Th, Tr, paginate } from "@/components/ui";
import { FaxConnectionNote, FaxTable } from "@/components/fax/FaxParts";

export const metadata: Metadata = { title: "FAX 送受信" };

type SP = Record<string, string | undefined>;
type Tab = "inbox" | "review" | "outbox" | "junk" | "numbers";

export default async function FaxPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const triage = canTriageFax(user);
  const all = canSeeAllStores(user);
  const visible = db.faxMessages.filter((f) => canViewFax(user, f));
  const inbox = visible.filter((f) => f.direction === "inbound" && (f.triage === "auto" || f.triage === "accepted"));
  const review = visible.filter((f) => f.direction === "inbound" && f.triage === "review");
  const junk = visible.filter((f) => f.direction === "inbound" && f.triage === "junk");
  const outbox = visible.filter((f) => f.direction === "outbound");
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "inbox", label: "受信", count: inbox.length },
    ...(triage ? [{ key: "review" as Tab, label: "要確認", count: review.length }] : []),
    { key: "outbox", label: "送信", count: outbox.length },
    ...(triage ? [{ key: "junk" as Tab, label: "不要", count: junk.length }, { key: "numbers" as Tab, label: "番号の台帳", count: db.faxNumbers.length }] : []),
  ];
  const tab: Tab = tabs.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : triage && review.length ? "review" : "inbox";
  let rows: FaxMessage[] = tab === "inbox" ? inbox : tab === "review" ? review : tab === "junk" ? junk : tab === "outbox" ? outbox : [];
  if (all && sp.store) rows = rows.filter((f) => f.storeId === sp.store);
  if (sp.user) rows = rows.filter((f) => f.assignedUserId === sp.user || (f.direction === "outbound" && f.userId === sp.user));
  if (sp.supplier) rows = rows.filter((f) => f.supplierId === sp.supplier);
  if (sp.status && FAX_STATUS[sp.status as FaxStatus]) rows = rows.filter((f) => f.status === sp.status);
  if (sp.unchecked === "1") rows = rows.filter((f) => f.purchaseOrderId && !f.checkedAt);
  if (sp.from) rows = rows.filter((f) => f.at.slice(0, 10) >= sp.from!);
  if (sp.to) rows = rows.filter((f) => f.at.slice(0, 10) <= sp.to!);
  const q = (sp.q ?? "").trim();
  if (q) {
    const n = normRef(q);
    const digits = normFax(q);
    const pos = new Map(db.purchaseOrders.map((p) => [p.id, p.number]));
    const orders = new Map(db.orders.map((o) => [o.id, o.number]));
    rows = rows.filter((f) =>
      normRef(f.number).includes(n) ||
      (digits.length >= 3 && f.remoteNumber.includes(digits)) ||
      (f.remoteName ?? "").includes(q) ||
      (f.ai?.senderName ?? "").includes(q) ||
      (f.purchaseOrderId && normRef(pos.get(f.purchaseOrderId) ?? "").includes(n)) ||
      f.orderIds.some((id) => normRef(orders.get(id) ?? "").includes(n)),
    );
  }
  rows = [...rows].sort((a, b) => b.at.localeCompare(a.at));
  const paged = paginate(rows, sp.page, 50);
  const conn = faxConnection();
  const canUpload = user.active;
  const unchecked = inbox.filter((f) => f.purchaseOrderId && !f.checkedAt).length;
  const failed = outbox.filter((f) => f.status === "failed" || f.status === "unknown").length;
  const people = db.users.filter((u) => u.active && (all || u.storeId === user.storeId));

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="FAX 送受信"
        description="会社の FAX (全店舗で 1 つの番号) の送受信を記録し、発注書・仕入先・案件にひも付けます。登録済みの仕入先・お客様からの FAX は自動で取り込み、未登録の番号の FAX は「要確認」で仕分けます"
        actions={
          <>
            <LinkButton href="/purchase-orders" variant="ghost">発注書</LinkButton>
            <LinkButton href="/purchase-orders/new" variant="secondary">+ 発注書を作成</LinkButton>
          </>
        }
      />
      <div className="mb-4"><FaxConnectionNote /></div>
      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="要確認の受信 FAX" value={triage ? review.length : "-"} tone={triage && review.length ? "warn" : undefined} href={triage ? "/fax?tab=review" : undefined} />
        <Stat label="未確認の返信 FAX" value={unchecked} tone={unchecked ? "warn" : undefined} href="/fax?tab=inbox&unchecked=1" />
        <Stat label="送信の失敗・要確認" value={failed} tone={failed ? "critical" : undefined} href="/fax?tab=outbox&status=failed" />
        <Stat label="処理中の送信" value={outbox.filter((f) => f.status === "queued" || f.status === "sending").length} />
      </div>
      <LinkTabs current={`/fax?tab=${tab}`} items={tabs.map((t) => ({ href: `/fax?tab=${t.key}`, label: t.label, count: t.count }))} />

      {tab === "numbers" ? (
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
          <div className="@4xl:col-span-2">
            <Table minWidth="min-w-[620px]">
              <thead><tr><Th>FAX 番号</Th><Th>種類</Th><Th>名前</Th><Th>登録</Th><Th></Th></tr></thead>
              <tbody>
                {db.faxNumbers.length === 0 && <EmptyRow colSpan={5}>登録はありません</EmptyRow>}
                {[...db.faxNumbers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((n) => (
                  <Tr key={n.id}>
                    <Td className="font-mono text-xs tnum">{fmtFax(n.number)}</Td>
                    <Td className="text-xs">{FAX_NUMBER_KIND_LABEL[n.kind]}</Td>
                    <Td className="text-sm">{n.label}<div className="text-xs text-ink-3">{n.note ?? ""}</div></Td>
                    <Td className="text-xs">{db.users.find((u) => u.id === n.createdBy)?.name ?? "-"}<div className="text-ink-3">{fmtDateTime(n.createdAt)}</div></Td>
                    <Td><form action={removeFaxNumber.bind(null, n.id)}><Button type="submit" variant="ghost" size="sm">外す</Button></form></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
          <Card>
            <CardHeader title="不要な番号を登録" description="この番号から届く FAX は自動で「不要」に入ります (削除はしません。「不要」タブから戻せます)" />
            <form action={addBlockedNumber} className="space-y-2">
              <Input name="number" placeholder="FAX 番号 (例: 096-123-4567)" inputMode="tel" required aria-label="FAX 番号" />
              <Input name="label" placeholder="名前 (例: ○○回線の営業)" maxLength={60} aria-label="名前" />
              <Input name="note" placeholder="メモ" maxLength={200} aria-label="メモ" />
              <Button type="submit" size="sm">登録する</Button>
            </form>
            <p className="mt-3 text-[11px] text-ink-3">仕入先の FAX 番号は「仕入先・協力業者」の台帳で、顧客の FAX 番号は受信 FAX の画面の「送信元をひも付ける」で登録します。</p>
          </Card>
        </div>
      ) : (
        <>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value={tab} />
            <div className="w-full @xl:w-64"><Input name="q" defaultValue={sp.q} placeholder="FAX 番号・相手・発注番号・受注番号" aria-label="検索" /></div>
            {all && (
              <Select name="store" defaultValue={sp.store ?? ""} className="w-auto" aria-label="店舗">
                <option value="">全店舗</option>
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
            <Select name="user" defaultValue={sp.user ?? ""} className="w-auto" aria-label="担当者">
              <option value="">担当者 (全員)</option>
              {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
            <Select name="supplier" defaultValue={sp.supplier ?? ""} className="w-auto" aria-label="仕入先">
              <option value="">すべての仕入先</option>
              {db.suppliers.filter((s) => visible.some((f) => f.supplierId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            {tab === "outbox" && (
              <Select name="status" defaultValue={sp.status ?? ""} className="w-auto" aria-label="状態">
                <option value="">すべての状態</option>
                {(["queued", "sending", "sent", "failed", "unknown", "manual"] as FaxStatus[]).map((s) => <option key={s} value={s}>{FAX_STATUS[s].label}</option>)}
              </Select>
            )}
            <Input type="date" name="from" defaultValue={sp.from} className="w-auto" aria-label="日付 (から)" />
            <Input type="date" name="to" defaultValue={sp.to} className="w-auto" aria-label="日付 (まで)" />
            <Button type="submit" variant="secondary">絞り込む</Button>
            {sp.unchecked === "1" && <Link href={`/fax?tab=${tab}`} className="text-xs text-accent hover:underline">未確認の絞り込みを外す</Link>}
          </form>
          <FaxTable db={db} rows={paged.items} empty={tab === "review" ? "要確認の FAX はありません" : "条件に合う FAX はありません"} />
          <Pager paged={paged} path="/fax" sp={sp} />
        </>
      )}

      {canUpload && tab !== "numbers" && (
        <div className="mt-6 grid grid-cols-1 gap-4 @4xl:grid-cols-2">
          <Card>
            <CardHeader title="受信した FAX を登録" description="FAX 機で受けた FAX をスキャンした PDF・写真を登録すると、AI が判定し、発注番号・案件番号でひも付けます (FAX サービスにつながるまでの運用・紙で届いた FAX 用)" />
            <form action={uploadFax} className="space-y-2">
              <input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required className="block w-full text-sm" aria-label="FAX の PDF・画像" />
              <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
                <Input name="from" placeholder="送信元の FAX 番号 (分かれば)" inputMode="tel" aria-label="送信元の FAX 番号" />
                <Input type="datetime-local" name="receivedAt" aria-label="受信日時" />
              </div>
              <Button type="submit" size="sm">登録して AI で判定</Button>
            </form>
          </Card>
          {conn.mode === "mock" && (
            <Card>
              <CardHeader title="模擬の受信 (検証環境)" description="未登録の番号から広告の FAX が届いた想定で、要確認の仕分けを試せます。仕入先からの返信は発注書の画面から試せます" />
              <form action={mockReceiveAd}><Button type="submit" variant="soft" size="sm">広告の FAX を受信する (模擬)</Button></form>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
