import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { customerOptions } from "@/lib/db/queries";
import { CHANNEL_LABEL } from "@/lib/constants";
import type { Channel, CommLog } from "@/lib/db/types";
import { Button, Card, CardHeader, Flash, Input, LinkTabs, Note, PageHeader, Pager, Select, Stat, paginate } from "@/components/ui";
import { ContactList, ContactLogForm } from "@/components/features/Contacts";

/** やりとりの記録の閲覧範囲: 記録の店舗 (なければお客様の店舗、どちらもなければ本部) にアクセスできる人 */
function storeOf(db: ReturnType<typeof getDb>, c: CommLog) {
  return c.storeId ?? db.customers.find((x) => x.id === c.customerId)?.storeId ?? "hq";
}

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const visible = db.commLogs.filter((c) => canAccessStore(user, storeOf(db, c)));
  const party = sp.party === "customer" || sp.party === "partner" ? sp.party : "all";
  let rows = visible;
  if (party === "customer") rows = rows.filter((c) => c.customerId && !c.supplierId);
  if (party === "partner") rows = rows.filter((c) => c.supplierId);
  if (sp.channel && CHANNEL_LABEL[sp.channel as Channel]) rows = rows.filter((c) => c.channel === sp.channel);
  if (sp.direction === "inbound" || sp.direction === "outbound") rows = rows.filter((c) => c.direction === sp.direction);
  if (sp.linked === "no") rows = rows.filter((c) => !c.relatedId);
  if (sp.linked === "yes") rows = rows.filter((c) => c.relatedId);
  if (sp.from) rows = rows.filter((c) => c.at.slice(0, 10) >= sp.from!);
  if (sp.to) rows = rows.filter((c) => c.at.slice(0, 10) <= sp.to!);
  if (canSeeAllStores(user) && sp.store) rows = rows.filter((c) => storeOf(db, c) === sp.store);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) {
    const names = new Map([...db.customers.map((c) => [c.id, c.name] as [string, string]), ...db.suppliers.map((s) => [s.id, s.name] as [string, string])]);
    rows = rows.filter((c) => [c.subject, c.body, c.contactName ?? "", names.get(c.customerId ?? "") ?? "", names.get(c.supplierId ?? "") ?? ""].join(" ").toLowerCase().includes(q));
  }
  rows = [...rows].sort((a, b) => b.at.localeCompare(a.at));
  const paged = paginate(rows, sp.page, 50);
  const opts = customerOptions(scopeByStore(user, db.customers), sp.cq, sp.customerId);
  const suppliers = db.suppliers.filter((s) => s.active !== false).sort((a, b) => Number(b.kind === "partner") - Number(a.kind === "partner") || a.name.localeCompare(b.name, "ja")).map((s) => ({ id: s.id, label: `${s.kind === "partner" ? "[協力業者] " : "[仕入先] "}${s.name}` }));
  const month = new Date().toISOString().slice(0, 7);
  const base = "/contacts";
  const returnTo = `${base}?party=${party}`;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="連絡履歴" description="お客様・協力業者・仕入先との電話・メール・LINE・Chatwork・Web・対面のやりとりを一か所で記録・検索し、案件 (問い合わせ・見積・受注・請求・仕入) に紐付けます" />
      <div className="mb-4 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="今月の記録" value={`${visible.filter((c) => c.at.startsWith(month)).length} 件`} />
        <Stat label="お客様とのやりとり" value={`${visible.filter((c) => c.customerId && !c.supplierId).length} 件`} href={`${base}?party=customer`} />
        <Stat label="協力業者・仕入先とのやりとり" value={`${visible.filter((c) => c.supplierId).length} 件`} href={`${base}?party=partner`} />
        <Stat label="案件に未紐付け" value={`${visible.filter((c) => !c.relatedId).length} 件`} href={`${base}?party=${party}&linked=no`} />
      </div>
      <LinkTabs
        current={`${base}?party=${party}`}
        items={[
          { href: `${base}?party=all`, label: "すべて" },
          { href: `${base}?party=customer`, label: "お客様" },
          { href: `${base}?party=partner`, label: "協力業者・仕入先" },
        ]}
      />
      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-3">
        <div className="@5xl:col-span-2">
          <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="party" value={party} />
            <div className="w-full @xl:w-56"><Input name="q" defaultValue={sp.q} placeholder="件名・内容・相手で検索" /></div>
            <Select name="channel" defaultValue={sp.channel ?? ""} className="w-auto" aria-label="手段">
              <option value="">すべての手段</option>
              {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
            </Select>
            <Select name="direction" defaultValue={sp.direction ?? ""} className="w-auto" aria-label="向き">
              <option value="">受信・発信</option>
              <option value="inbound">受信</option>
              <option value="outbound">発信</option>
            </Select>
            <Select name="linked" defaultValue={sp.linked ?? ""} className="w-auto" aria-label="案件の紐付け">
              <option value="">案件の紐付け: すべて</option>
              <option value="yes">紐付けあり</option>
              <option value="no">紐付けなし</option>
            </Select>
            {canSeeAllStores(user) && (
              <Select name="store" defaultValue={sp.store ?? ""} className="w-auto" aria-label="店舗">
                <option value="">全店舗</option>
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
            <Input type="date" name="from" defaultValue={sp.from} className="w-auto" aria-label="日付 (から)" />
            <Input type="date" name="to" defaultValue={sp.to} className="w-auto" aria-label="日付 (まで)" />
            <Button type="submit" variant="secondary">絞り込む</Button>
            <span className="text-xs text-ink-3">{rows.length} 件</span>
          </form>
          <Card>
            <ContactList db={db} logs={paged.items} returnTo={returnTo} linkable />
          </Card>
          <Pager paged={paged} path={base} sp={sp} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="やりとりを記録" description="相手 (お客様・協力業者) を選び、案件番号を入れると案件に紐付きます。メール・LINE・Chatwork は「相手に送信する」で実際に送れます" />
            {opts.searchable && (
              <form method="get" className="mb-3 flex items-end gap-2">
                <input type="hidden" name="party" value={party} />
                <div className="flex-1"><Input name="cq" defaultValue={sp.cq} placeholder="お客様を検索 (氏名・フリガナ・電話)" /></div>
                <Button type="submit" variant="secondary" size="sm">検索</Button>
              </form>
            )}
            <ContactLogForm returnTo={returnTo} customers={opts.options.map((c) => ({ id: c.id, label: `${c.name} (${c.code})` }))} suppliers={suppliers} canSend />
            {opts.searchable && !sp.cq && <p className="mt-2 text-[11px] text-ink-3">お客様が {opts.total.toLocaleString("ja-JP")} 件あるため、上で検索してから選びます。案件番号を入れると、その案件のお客様が自動で選ばれます。</p>}
          </Card>
          <Note>受信の自動登録: LINE 公式アカウント・Chatwork・Web サイトのフォームの受信は、設定 → 外部連携・AI で接続すると、ここと問い合わせに自動で記録されます。</Note>
        </div>
      </div>
    </div>
  );
}
