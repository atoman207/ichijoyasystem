import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canImportData, canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDate, fmtDateTime, toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS } from "@/lib/constants";
import type { InquiryStatus } from "@/lib/db/types";
import { Button, ChannelTag, EmptyRow, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Select, StatusBadge, StoreTag, Table, Td, Th, Tr, Pager, paginate } from "@/components/ui";
import { isDateKey } from "@/lib/calendar";
import { MEDIA_KEYS, MEDIA_LABEL, MEDIA_NONE, UNCLASSIFIED, isMediaKey } from "@/lib/media";
import { filterInquiries, inquiryMediaMap } from "@/lib/ops-reports/promo-analysis";
import { MediaTag } from "@/components/ops-reports/MediaFields";
import { pendingReceptionCount } from "@/lib/reception";
import { inquiryContact } from "@/lib/link-search";
import { isPlaceholderCustomer } from "@/lib/customer-link";
import { FLOW_STATE, FLOW_TABS, dueLabel, flowIndex, inquiryFlow, type FlowState } from "@/lib/inquiry-flow";
import { Badge } from "@/components/ui";

export default async function InquiriesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const today = toDateKey(new Date());
  const scoped = scopeByStore(user, db.inquiries);
  const status = sp.status as InquiryStatus | "open" | undefined;
  // 対応状況 (担当者への依頼待ち・日程調整中・期限超過・お客様都合で日程未定・日程確定…。お客様のご要望 2026-11-24「業務フロー ⑥」。src/lib/inquiry-flow.ts)
  const now = new Date();
  const fix = flowIndex(db);
  const flowOf = new Map(scoped.map((i) => [i.id, inquiryFlow(i, fix, now)]));
  const flowParam = FLOW_TABS.includes(sp.flow as FlowState) ? (sp.flow as FlowState) : undefined;
  let rows = scoped;
  if (flowParam) rows = rows.filter((i) => flowOf.get(i.id)?.state === flowParam);
  if (status === "open") rows = rows.filter((i) => i.status === "new" || i.status === "in_progress" || i.status === "quoted");
  else if (status && INQUIRY_STATUS[status as InquiryStatus]) rows = rows.filter((i) => i.status === status);
  if (sp.channel) rows = rows.filter((i) => i.channel === sp.channel);
  if (allStores && sp.store) rows = rows.filter((i) => i.storeId === sp.store);
  // お客様の電話・住所 (顧客にひも付いていれば顧客の情報、なければ受付で聞いた情報。お客様のご要望 2026-11-24「■5」)
  const customerMap = new Map(db.customers.map((c) => [c.id, c]));
  const contactOf = (i: (typeof rows)[number]) => inquiryContact(i, i.customerId ? customerMap.get(i.customerId) : undefined);
  const q = (sp.q ?? "").trim().toLowerCase();
  const qDigits = q.replace(/[^0-9]/g, "");
  if (q)
    rows = rows.filter((i) => {
      const c = i.customerId ? customerMap.get(i.customerId) : undefined;
      const ct = contactOf(i);
      if ([i.number, i.contactName, c?.name, c?.kana, i.summary, i.detail, ct.address].join(" ").toLowerCase().includes(q)) return true;
      return qDigits.length >= 3 && ct.phone.replace(/[^0-9]/g, "").includes(qDigits);
    });
  // 媒体 (入力 + 過去の記録からの推定)・受付日の絞り込み (販促と媒体の分析と同じ判定。件数が一致する)
  const mediaParam = sp.media === MEDIA_NONE || isMediaKey(sp.media) ? sp.media : "";
  const fromParam = isDateKey(sp.from) ? sp.from : "";
  const toParam = isDateKey(sp.to) ? sp.to : "";
  if (mediaParam || fromParam || toParam) rows = filterInquiries(db, rows, { media: mediaParam, from: fromParam, to: toParam });
  rows = [...rows].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const paged = paginate(rows, sp.page);
  const mediaOf = inquiryMediaMap(db, paged.items);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const base = "/inquiries";
  const pendingReceptions = pendingReceptionCount(db, user);
  const current = flowParam ? `${base}?flow=${flowParam}` : status ? `${base}?status=${status}` : base;
  const flowCount = (f: FlowState) => scoped.filter((i) => flowOf.get(i.id)?.state === f).length;
  const overdueCount = flowCount("overdue");
  const waitingCount = flowCount("request_waiting");

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="問い合わせ" actions={<>{canImportData(user) && <LinkButton href="/data" variant="secondary">CSV 取込・書き出し</LinkButton>}<LinkButton href="/inquiries/new" variant="secondary">+ 手入力で登録</LinkButton><LinkButton href="/inquiries/reception">+ 問合せ登録 (メモを撮影)</LinkButton></>} />
      {pendingReceptions > 0 && (
        <div className="mb-4">
          <Note tone="warn">
            確認待ちの受付が {pendingReceptions} 件あります (メモの写真・電話の内容などを AI が読み取ったもの)。<Link href="/inquiries/reception" className="font-medium underline">受付の一覧で確かめて登録する</Link>
          </Note>
        </div>
      )}
      {(overdueCount > 0 || waitingCount > 0) && (
        <div className="mb-3 flex flex-wrap gap-2 text-sm" data-testid="inquiry-flow-alert">
          {overdueCount > 0 && (
            <Link href={`${base}?flow=overdue`} className="rounded-lg bg-critical-soft px-3 py-1.5 font-medium text-critical-ink hover:underline">
              期限超過 {overdueCount} 件 (日程の登録・返答がないまま期限を過ぎた問い合わせ)
            </Link>
          )}
          {waitingCount > 0 && (
            <Link href={`${base}?flow=request_waiting`} className="rounded-lg bg-warn-soft px-3 py-1.5 font-medium text-warn-ink hover:underline">
              担当者への依頼待ち {waitingCount} 件
            </Link>
          )}
        </div>
      )}
      <LinkTabs
        current={current}
        items={[
          { href: base, label: "すべて", count: scoped.length },
          ...FLOW_TABS.map((f) => ({ href: `${base}?flow=${f}`, label: f === "visited" ? "訪問済み" : FLOW_STATE[f].label, count: flowCount(f) })),
        ]}
      />
      {status && <p className="mb-2 text-xs text-ink-3">状態「{status === "open" ? "対応中のすべて" : INQUIRY_STATUS[status as InquiryStatus]?.label}」で絞り込んでいます。<Link href={base} className="text-accent hover:underline">解除</Link></p>}
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        {status && <input type="hidden" name="status" value={status} />}
        {flowParam && <input type="hidden" name="flow" value={flowParam} />}
        <div className="w-full @xl:w-72"><Input name="q" defaultValue={sp.q} placeholder="番号・お客様名・電話・住所・内容で検索" /></div>
        <Select name="channel" defaultValue={sp.channel ?? ""} className="w-auto">
          <option value="">すべての入口</option>
          {(Object.keys(CHANNEL_LABEL) as (keyof typeof CHANNEL_LABEL)[]).map((c) => (
            <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
          ))}
        </Select>
        <Select name="media" defaultValue={mediaParam} className="w-auto" aria-label="媒体">
          <option value="">すべての媒体</option>
          {MEDIA_KEYS.map((k) => <option key={k} value={k}>{MEDIA_LABEL[k]}</option>)}
          <option value={MEDIA_NONE}>{UNCLASSIFIED}</option>
        </Select>
        <label className="flex items-center gap-1 text-xs text-ink-3">受付日<Input type="date" name="from" defaultValue={fromParam} className="w-auto" aria-label="受付日 (から)" />〜<Input type="date" name="to" defaultValue={toParam} className="w-auto" aria-label="受付日 (まで)" /></label>
        {allStores && (
          <Select name="store" defaultValue={sp.store ?? ""} className="w-auto">
            <option value="">全店舗</option>
            {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Button type="submit" variant="secondary">絞り込む</Button>
      </form>
      <Table>
        <thead>
          <tr>
            <Th>受付日時</Th>
            <Th>入口</Th>
            <Th>媒体</Th>
            <Th>お客様</Th>
            <Th>電話</Th>
            <Th>住所</Th>
            <Th>内容</Th>
            <Th>種別</Th>
            <Th>店舗</Th>
            <Th>担当</Th>
            <Th>対応状況</Th>
            <Th>次のアクション</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={12} />}
          {paged.items.map((i) => {
            const customer = i.customerId ? customerMap.get(i.customerId) : undefined;
            const ct = contactOf(i);
            const overdue = i.nextActionDue && i.nextActionDue < today && ["new", "in_progress"].includes(i.status);
            return (
              <Tr key={i.id}>
                <Td className="text-xs text-ink-2 tnum">{fmtDateTime(i.receivedAt)}<div className="font-mono text-[10px] text-ink-3">{i.number}</div></Td>
                <Td><ChannelTag channel={i.channel} /></Td>
                <Td>{mediaOf.get(i.id) && <MediaTag {...mediaOf.get(i.id)!} />}</Td>
                <Td>
                  {customer ? (
                    <span>
                      <Link href={`/customers/${customer.id}`} className="hover:text-accent">{customer.name}</Link>
                      {isPlaceholderCustomer(customer) && (
                        <Link href={`/inquiries/${i.id}#link-customer`} className="ml-1 text-[10px] text-warn-ink hover:underline">(仮・紐づける)</Link>
                      )}
                    </span>
                  ) : (
                    <span>
                      {i.contactName}{" "}
                      <Link href={`/inquiries/${i.id}#link-customer`} className="text-[10px] text-accent hover:underline">(未登録・紐づける)</Link>
                    </span>
                  )}
                </Td>
                <Td className="text-xs whitespace-nowrap text-ink-2 tnum">{ct.phone ? <a href={`tel:${ct.phone.replace(/[^0-9+]/g, "")}`} className="hover:text-accent">{ct.phone}</a> : <span className="text-ink-3">-</span>}</Td>
                <Td className="max-w-[14rem] text-xs text-ink-2">{ct.address ? <span className="line-clamp-2">{ct.address}</span> : <span className="text-ink-3">-</span>}</Td>
                <Td><Link href={`/inquiries/${i.id}`} className="font-medium text-ink hover:text-accent">{i.summary}</Link></Td>
                <Td className="text-xs text-ink-2">{CATEGORY_LABEL[i.category]}</Td>
                <Td><StoreTag store={storeMap.get(i.storeId)} short /></Td>
                <Td className="text-xs text-ink-2">{userName(i.assignedUserId)}</Td>
                <Td className="min-w-[10rem]">
                  {(() => {
                    const f = flowOf.get(i.id);
                    if (!f) return <StatusBadge value={i.status} map={INQUIRY_STATUS} />;
                    return (
                      <div className="space-y-0.5">
                        <Link href={`/inquiries/${i.id}#actions`}><Badge tone={f.tone}>{f.label}</Badge></Link>
                        {f.next && f.state !== "closed" && <div className="text-[11px] leading-snug text-ink-2">{f.next}</div>}
                        {(f.who.length > 0 || f.dueAt) && (
                          <div className={`text-[11px] ${f.overdue ? "font-medium text-critical-ink" : "text-ink-3"}`}>
                            {f.who.join("・")}
                            {f.dueAt ? `${f.who.length ? " · " : ""}期限 ${dueLabel(f.dueAt, now)}` : ""}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </Td>
                <Td className="text-xs">
                  {i.nextAction ? (
                    <span className={overdue ? "text-critical" : "text-ink-2"}>{i.nextAction}{i.nextActionDue && <span className="ml-1 tnum">({fmtDate(i.nextActionDue)}{overdue ? " 期限超過" : ""})</span>}</span>
                  ) : (
                    <span className="text-ink-3">-</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <Pager paged={paged} path="/inquiries" sp={sp} />
    </div>
  );
}
