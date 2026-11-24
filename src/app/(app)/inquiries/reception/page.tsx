import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canEditCaseStore, canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { aiStatus, voiceEnabled } from "@/lib/ai/provider";
import { createReception } from "@/lib/actions/reception";
import { fmtDateTime } from "@/lib/format";
import { CHANNEL_LABEL } from "@/lib/constants";
import { RECEPTION_SOURCE_LABEL, RECEPTION_TYPE_SHORT, RECEPTION_TYPE_TONE, RECEPTION_ACTION_LABEL, isPendingReception, receptionFieldsOf, receptionHref, receptionMetaOf, receptionTitle } from "@/lib/reception";
import { ReceptionInput } from "@/components/reception/ReceptionInput";
import { Badge, Card, CardHeader, ChannelTag, EmptyRow, Flash, LinkButton, LinkTabs, Note, PageHeader, StoreTag, Table, Td, Th, Tr } from "@/components/ui";

export const maxDuration = 60;

/**
 * 受付 (すべての問い合わせの共通の入口): 手書きメモの写真・話して入力・通話の録音 → AI の読み取り → 確認待ち → 問い合わせ・案件へ
 * 電話のシステムからの通話 (/api/integrations/phone-call) もここの確認待ちに入る
 */
export default async function ReceptionPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string; tab?: string; customer?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const ai = aiStatus();
  const allStores = canSeeAllStores(user);
  const all = scopeByStore(user, db.documents).filter((d) => d.kind === "reception").sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const pending = all.filter(isPendingReception);
  const done = all.filter((d) => !isPendingReception(d)).slice(0, 30);
  const tab = sp.tab === "done" ? "done" : "pending";
  const rows = tab === "done" ? done : pending;
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  // 顧客の画面の「メモを撮影して問い合わせ」から開いたとき: お客様が決まっている (お客様のご要望 2026-11-24「■6」)
  const preset = sp.customer ? db.customers.find((c) => c.id === sp.customer && canEditCaseStore(user, c.storeId)) : undefined;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="問合せ登録"
        description={preset ? `${preset.name} 様の新しい問い合わせを、手書きのメモの写真・話した内容から登録します。お客様は決まっているので、AI が読み取った内容を確かめて直すだけで登録できます` : "手書きのメモを撮影すると、AI がお名前・住所・電話・用件を読み取ります (話して入力・通話の録音もここから)"}
        back={preset ? { href: `/customers/${preset.id}`, label: `${preset.name} 様` } : { href: "/inquiries", label: "問い合わせ一覧" }}
        actions={<LinkButton href={preset ? `/inquiries/new?customerId=${preset.id}` : "/inquiries/new"} variant="secondary" size="sm">手入力で登録</LinkButton>}
      />
      <div className="grid grid-cols-1 gap-5 @4xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card>
          {preset && <CardHeader title={`${preset.name} 様の問合せ`} />}
          {preset && (
            <div className="mb-3 rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent-ink" data-testid="reception-preset">
              お客様: <span className="font-semibold">{preset.name} 様</span> ({preset.code}{preset.address ? ` · ${preset.address}` : ""})。この画面から登録する受付は、このお客様の問い合わせになります。
            </div>
          )}
          <ReceptionInput
            action={createReception}
            stores={db.stores.map((s) => ({ id: s.id, name: s.name }))}
            defaultStoreId={preset && canAccessStore(user, preset.storeId) ? preset.storeId : user.storeId}
            canChooseStore={allStores}
            aiEnabled={ai.enabled}
            voice={voiceEnabled()}
            customer={preset ? { id: preset.id, name: preset.name } : undefined}
          />
        </Card>
        <div className="min-w-0">
          <LinkTabs
            current={tab === "done" ? "/inquiries/reception?tab=done" : "/inquiries/reception"}
            items={[
              { href: "/inquiries/reception", label: "確認待ち", count: pending.length },
              { href: "/inquiries/reception?tab=done", label: "処理済み (最近 30 件)", count: done.length },
            ]}
          />
          {tab === "pending" && pending.length === 0 && <Note tone="accent">確認待ちの受付はありません。電話のシステムから届いた通話も、ここに入ります。</Note>}
          <Table>
            <thead>
              <tr>
                <Th>受付</Th>
                <Th>種類</Th>
                <Th>お客様・相手 / 用件</Th>
                <Th>入口</Th>
                <Th>店舗</Th>
                <Th>{tab === "done" ? "登録先" : "取り込んだ人"}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={6} />}
              {rows.map((d) => {
                const f = receptionFieldsOf(d);
                const meta = receptionMetaOf(d);
                const t = f.callType || undefined;
                return (
                  <Tr key={d.id}>
                    <Td className="text-xs text-ink-2 tnum">
                      {fmtDateTime(meta.call?.startedAt ?? d.uploadedAt)}
                      <div className="text-[10px] text-ink-3">{RECEPTION_SOURCE_LABEL[meta.source]}</div>
                    </Td>
                    <Td>{t ? <Badge tone={RECEPTION_TYPE_TONE[t]}>{RECEPTION_TYPE_SHORT[t]}</Badge> : <span className="text-xs text-ink-3">未判定</span>}{f.urgency === "high" && <Badge tone="critical" className="ml-1">至急</Badge>}</Td>
                    <Td>
                      <Link href={receptionHref(d.id)} className="font-medium text-ink hover:text-accent">{receptionTitle(f)}</Link>
                      {d.status === "failed" && <div className="text-[11px] text-critical">読み取りに失敗 (手入力できます)</div>}
                    </Td>
                    <Td>{CHANNEL_LABEL[meta.channel] ? <ChannelTag channel={meta.channel} /> : "-"}</Td>
                    <Td><StoreTag store={storeMap.get(d.storeId)} short /></Td>
                    <Td className="text-xs text-ink-2">
                      {tab === "done" ? (
                        meta.decision?.href ? <Link href={meta.decision.href} className="text-accent hover:underline">{meta.decision.label ?? RECEPTION_ACTION_LABEL[meta.decision.action]}</Link> : meta.decision ? `${RECEPTION_ACTION_LABEL[meta.decision.action]}${meta.decision.note ? ` (${meta.decision.note})` : ""}` : d.status === "discarded" ? "閉じた" : "-"
                      ) : (
                        userName(d.uploadedBy)
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      </div>
    </div>
  );
}
