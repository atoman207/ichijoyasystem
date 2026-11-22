import type { ReactNode } from "react";
import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canSeeAllStores } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { attachmentsOf } from "@/lib/attachments";
import { registerReception, rereadReception } from "@/lib/actions/reception";
import { fmtDateTime } from "@/lib/format";
import { CHANNEL_LABEL } from "@/lib/constants";
import { isMediaKey, mapMediaText, readMediaRules } from "@/lib/media";
import type { MediaKey } from "@/lib/db/types";
import {
  RECEPTION_ACTION_LABEL,
  RECEPTION_SOURCE_LABEL,
  RECEPTION_TYPE_LABEL,
  RECEPTION_TYPE_TONE,
  caseKey,
  customerCases,
  isPendingReception,
  matchReception,
  receptionFieldsOf,
  receptionMetaOf,
  receptionTitle,
  type CaseCandidate,
} from "@/lib/reception";
import { providerLabel } from "@/lib/reception-docs";
import { ReceptionReview, type ReviewCase, type ReviewCustomer } from "@/components/reception/ReceptionReview";
import { Badge, Card, CardHeader, Dl, Flash, Note, PageHeader } from "@/components/ui";

const KIND_LABEL: Record<CaseCandidate["type"], string> = { inquiry: "問い合わせ", quote: "見積", order: "受注" };

export default async function ReceptionDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const doc = db.documents.find((d) => d.id === id && d.kind === "reception");
  if (!doc) notFound();
  if (!canAccessStore(user, doc.storeId)) redirect("/inquiries/reception?err=" + encodeURIComponent("この受付を閲覧する権限がありません。"));
  const f = receptionFieldsOf(doc);
  const meta = receptionMetaOf(doc);
  const ex = (doc.extracted ?? {}) as Record<string, unknown>;
  const pending = isPendingReception(doc);
  const photo = attachmentsOf(db, "document", doc.id)[0];
  const aiWarnings = Array.isArray(ex._warnings) ? (ex._warnings as string[]) : [];
  const allStores = canSeeAllStores(user);
  const storeName = (sid: string) => db.stores.find((s) => s.id === sid)?.shortName ?? db.stores.find((s) => s.id === sid)?.name ?? sid;

  let review: ReactNode = null;
  let matchWarnings: string[] = [];
  if (pending) {
    const m = matchReception(db, user, f);
    matchWarnings = m.warnings;
    const customers: ReviewCustomer[] = m.customers.slice(0, 8).map((c) => ({ id: c.customer.id, label: `${c.customer.name} (${c.customer.code} · ${storeName(c.customer.storeId)})${c.customer.address ? ` ${c.customer.address.slice(0, 20)}` : ""}`, level: c.level, reason: c.reason }));
    // 案件: 電話で一致したお客様の案件 + お名前で一致したお客様の案件 (選んだときに出す)
    const list: CaseCandidate[] = [...m.cases];
    for (const c of m.customers.filter((x) => x.level === "name").slice(0, 3)) for (const k of customerCases(db, c.customer.id)) if (!list.some((x) => caseKey(x) === caseKey(k)) && canAccessStore(user, k.storeId)) list.push(k);
    const custName = (cid?: string) => (cid ? db.customers.find((c) => c.id === cid)?.name : undefined);
    const cases: ReviewCase[] = list.slice(0, 20).map((c) => ({ key: caseKey(c), number: c.number, kindLabel: KIND_LABEL[c.type], title: c.title, statusLabel: c.statusLabel, date: c.date, href: c.href, open: c.open, reason: c.reason, customerId: c.customerId, customerName: custName(c.customerId), ownerId: c.ownerId }));
    const matchedSuppliers = new Set(m.suppliers.map((s) => s.id));
    const suppliers = [...m.suppliers, ...db.suppliers.filter((s) => !matchedSuppliers.has(s.id))].slice(0, 400).map((s) => ({ id: s.id, name: s.name, matched: matchedSuppliers.has(s.id) }));
    const users = db.users
      .filter((u) => u.active && (allStores || u.storeId === user.storeId || u.role === "admin" || u.role === "hq_staff"))
      .map((u) => ({ id: u.id, label: `${u.name} (${storeName(u.storeId)}${u.title ? `・${u.title}` : ""})` }));
    // 担当者の初期値: 自分の店舗の受付は自分。本部などがほかの店舗の受付を登録するときは、その店舗の店長
    const custStore = m.customers.find((c) => c.customer.id === m.suggestion.customerId)?.customer.storeId;
    const target = custStore ?? doc.storeId;
    const manager = db.stores.find((s) => s.id === target)?.managerUserId;
    const defaultAssigneeId = target !== user.storeId && manager && db.users.some((u) => u.id === manager && u.active) ? manager : user.id;
    const mapped = mapMediaText(readMediaRules(db).rules, f.mediaText);
    const byChannel: Partial<Record<string, MediaKey>> = { referral: "referral", event: "event" };
    const mediaDefault = mapped ?? (isMediaKey(byChannel[meta.channel]) ? byChannel[meta.channel] : undefined);
    review = (
      <ReceptionReview
        key={`${doc.id}_${String(ex._readAt ?? "")}_${String((ex._edited as { at?: string } | undefined)?.at ?? "")}`}
        action={registerReception}
        id={doc.id}
        fields={f}
        channel={meta.channel}
        suggestion={m.suggestion}
        customers={customers}
        cases={cases}
        suppliers={suppliers}
        users={users}
        stores={db.stores.map((s) => ({ id: s.id, name: s.name }))}
        storeId={target}
        canChooseStore={allStores}
        currentUserId={user.id}
        defaultAssigneeId={defaultAssigneeId}
        mediaDefault={mediaDefault}
      />
    );
  }

  const raw = meta.text || f.memoText;
  const call = meta.call;
  const t = f.callType || undefined;

  return (
    <div className="max-w-6xl">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={receptionTitle(f) || "受付"}
        back={{ href: "/inquiries/reception", label: "受付の一覧" }}
        badge={t ? <Badge tone={RECEPTION_TYPE_TONE[t]}>{RECEPTION_TYPE_LABEL[t]}</Badge> : undefined}
        description={`${RECEPTION_SOURCE_LABEL[meta.source]} · ${CHANNEL_LABEL[meta.channel] ?? meta.channel} · ${fmtDateTime(call?.startedAt ?? doc.uploadedAt)} · 取り込み: ${userName(doc.uploadedBy)} · 読み取り: ${providerLabel(ex._provider)}${ex._model ? ` (${String(ex._model)})` : ""}`}
      />
      <div className="grid grid-cols-1 gap-5 @4xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader title={meta.source === "photo" ? "元のメモ" : meta.source === "audio" || meta.source === "phone_api" ? "通話の文字起こし" : "入力した内容"} />
            {photo &&
              (photo.kind === "photo" ? (
                <a href={`/api/attachments/${photo.id}`} target="_blank" rel="noopener" className="mb-3 block overflow-hidden rounded-lg border border-line bg-subtle">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/attachments/${photo.id}${photo.thumbKey ? "?size=thumb" : ""}`} alt="受付メモの写真" className="max-h-80 w-full object-contain" />
                </a>
              ) : (
                <a href={`/api/attachments/${photo.id}`} target="_blank" rel="noopener" className="mb-3 flex h-20 items-center justify-center rounded-lg border border-line bg-subtle text-sm text-accent hover:underline">元のメモ (PDF) を開く</a>
              ))}
            {!photo && meta.source === "photo" && <p className="mb-3 text-xs text-ink-3">{doc.status === "confirmed" ? "元の写真は登録先の「資料・写真」にあります。" : "元の写真は保存されていません。"}</p>}
            {raw ? <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-subtle px-3 py-2 text-xs leading-relaxed text-ink-2">{raw}</pre> : <p className="text-xs text-ink-3">(文字はありません)</p>}
            {call && (
              <div className="mt-3">
                <Dl
                  columns={1}
                  items={[
                    ["発信元", call.from ?? "番号非通知"],
                    ["着信先", call.to ?? "-"],
                    ["向き", call.direction === "outbound" ? "発信" : "着信"],
                    ["通話時間", call.durationSec ? `${Math.floor(call.durationSec / 60)} 分 ${call.durationSec % 60} 秒` : "-"],
                    ["内線・受けた人", [call.extension, call.staff].filter(Boolean).join(" / ") || "-"],
                    ["録音", call.recordingUrl ? <a key="r" href={call.recordingUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">開く</a> : "-"],
                  ]}
                />
              </div>
            )}
          </Card>
          {pending && (
            <form action={rereadReception}>
              <input type="hidden" name="id" value={doc.id} />
              <button type="submit" className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-xs text-ink-2 hover:bg-subtle">もう一度 AI で読み取る (直した内容は消えます)</button>
            </form>
          )}
        </div>
        <Card className="min-w-0">
          {pending ? (
            <>
              <CardHeader title="内容を確かめて登録する" description="AI の読み取り・判定は提案です。違っていれば直してから登録してください" />
              {f.callTypeReason && <p className="mb-3 text-xs text-ink-2">判定の理由: {f.callTypeReason}</p>}
              {doc.status === "failed" && <Note tone="warn">AI で読み取れませんでした: {String(ex._error ?? "原因不明")} — 下の欄に入力して登録できます。</Note>}
              {(aiWarnings.length > 0 || matchWarnings.length > 0) && doc.status !== "failed" && (
                <div className="mb-4">
                  <Note tone="warn">
                    {[...matchWarnings, ...aiWarnings].map((w, i) => (
                      <div key={i}>⚠ {w}</div>
                    ))}
                  </Note>
                </div>
              )}
              {review}
            </>
          ) : (
            <>
              <CardHeader title={doc.status === "confirmed" ? "登録済み" : "閉じた受付"} />
              {meta.decision ? (
                <div className="space-y-2 text-sm">
                  <p>
                    {RECEPTION_ACTION_LABEL[meta.decision.action]}
                    {meta.decision.href && meta.decision.label && (
                      <>
                        {" → "}
                        <Link href={meta.decision.href} className="font-medium text-accent hover:underline">{meta.decision.label}</Link>
                      </>
                    )}
                  </p>
                  {meta.decision.note && <p className="text-xs text-ink-2">理由: {meta.decision.note}</p>}
                  <p className="text-xs text-ink-3">{userName(meta.decision.by)} · {fmtDateTime(meta.decision.at)}</p>
                </div>
              ) : (
                <p className="text-sm text-ink-2">この受付は処理済みです。</p>
              )}
              <div className="mt-4">
                <Dl
                  items={[
                    ["お名前", f.customerName || "-"],
                    ["電話番号", f.phone || "-"],
                    ["住所", f.address || "-"],
                    ["用件", f.summary || "-"],
                  ]}
                />
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
