"use client";

import { useMemo, useState } from "react";
import type { Channel, MediaKey, StoreId } from "@/lib/db/types";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { MEDIA, MEDIA_KEYS } from "@/lib/media";
import type { CaseOption } from "@/lib/case-choice";
import type { AreaStore } from "@/lib/store-area";
import { ReceptionCustomerSearch } from "@/components/features/LinkSearch";
import { AutoStoreSelect } from "@/components/features/AutoStoreSelect";
import { CaseChoice } from "@/components/inquiries/CaseChoice";
import { MemoPhoto } from "./MemoPhoto";
import {
  APPOINTMENT_KINDS,
  type ReceptionAppointment,
  RECEPTION_ACTION_LABEL,
  RECEPTION_CHANNELS,
  RECEPTION_FIELD_LABEL,
  RECEPTION_TYPE_LABEL,
  RECEPTION_TYPES,
  type ReceptionAction,
  type ReceptionFields,
} from "@/lib/reception";

export interface ReviewCustomer {
  id: string;
  label: string;
  /** preset = 顧客の画面から取り込んだ受付のお客様 (決まっている) */
  level: "preset" | "phone" | "address" | "name";
  reason: string;
  /** 候補のカードに出すお名前・住所・電話・顧客コード・店舗 (正しいお客様かその場で確かめる) */
  name: string;
  address: string;
  phone: string;
  code: string;
  storeName: string;
  /** 予定表 (スプレッドシート) から移行した予定の仮のお客様 (名字と地区だけの登録。お客様のご連絡 2026-11-27) */
  placeholder?: boolean;
}

export interface ChosenCustomer {
  id: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  storeName: string;
  /** この画面で新規顧客として登録した */
  created: boolean;
  /** 顧客の画面から取り込んだ受付 */
  fromCustomer: boolean;
}

/** 「登録先 (詳しく選ぶ)」の「既存の案件に問い合わせを追加する」の候補 (お客様を決める前。記録ごと) */
export interface ReviewCase {
  key: string;
  number: string;
  kindLabel: string;
  title: string;
  statusLabel: string;
  date: string;
  href: string;
  open: boolean;
  reason: string;
  customerId?: string;
  customerName?: string;
  ownerId?: string;
  /** 案件の店舗・媒体 (担当店舗・媒体の初期値) */
  storeId?: StoreId;
  storeName?: string;
  media?: MediaKey;
}

/** 担当店舗の欄の初期値 (src/components/features/AutoStoreSelect.tsx) */
export interface ReviewStore {
  /** 住所で決まらないときの店舗 (お客様の店舗・受付の店舗) */
  fallbackStoreId: StoreId;
  /** 全店舗から選べない人が選べる店舗 */
  choices: StoreId[];
  /** 開いたときの住所 (施工現場 → 住所) と、その担当エリア */
  initialAddress: string;
  initialArea: AreaStore | null;
  /** 住所の欄が空のときのお客様の住所 */
  fallbackAddress: string;
  /** 前に手で選んだ店舗 */
  pickedStoreId?: StoreId;
}

const ACTION_NOTE: Record<ReceptionAction, string> = {
  inquiry: "問い合わせを登録し、店舗・担当者に知らせます (お客様を決めてから。新規案件か既存の案件かは「② 案件」で選びます)",
  case: "すでにある案件 (問い合わせ・見積・受注) に問い合わせを追加します (日程の変更・確認・手直しの連絡など)。問い合わせ一覧と案件の画面の両方に出ます",
  record: "仕入先・協力業者、またはお客様とのやりとりとして残します (問い合わせにはしません)",
  dismiss: "営業電話・間違い電話など、記録しなくてよいもの",
};

const URGENCY: Record<string, string> = { "": "-", high: "高 (至急)", normal: "普通", low: "低" };

export function ReceptionReview({
  action,
  id,
  fields,
  channel,
  suggestion,
  customers,
  cases,
  suppliers,
  users,
  stores,
  canChooseStore,
  store,
  currentUserId,
  userStoreId,
  managers = {},
  defaultAssigneeId,
  assigneeChosen,
  mediaDefault,
  mediaChosen,
  canCreateCustomer = true,
  photo,
  chosen,
  caseOptions,
  caseChoice: initialChoice = "new",
  suggestedCaseId,
  handoffDefault = true,
}: {
  action: (formData: FormData) => Promise<void>;
  id: string;
  fields: ReceptionFields;
  channel: Channel;
  suggestion: { action: ReceptionAction; customerId?: string; caseKey?: string; supplierId?: string; reason: string };
  customers: ReviewCustomer[];
  cases: ReviewCase[];
  suppliers: { id: string; name: string; matched: boolean }[];
  users: { id: string; label: string }[];
  stores: { id: StoreId; name: string }[];
  canChooseStore: boolean;
  /** 担当店舗の欄 (住所の担当エリア・お客様の店舗・前に選んだ店舗) */
  store: ReviewStore;
  currentUserId: string;
  /** 登録する人の店舗と、店舗ごとの店長 (担当店舗をほかの店舗にしたときの担当者の初期値) */
  userStoreId?: StoreId;
  managers?: Partial<Record<string, string>>;
  defaultAssigneeId: string;
  /** 前に選んだ担当者 (紐付け・保存のあとも選び直さない) */
  assigneeChosen?: string;
  /** 媒体の初期値 (メモの言葉・入口から。案件に追加するときは案件の媒体が先) */
  mediaDefault?: MediaKey;
  /** 前に選んだ媒体 (紐付け・保存のあとも選び直さない) */
  mediaChosen?: MediaKey;
  /** 顧客の新規登録ができる (「新しいお客様として登録」で顧客も登録する) */
  canCreateCustomer?: boolean;
  /** 受付メモの写真 (狭い画面では欄の上に出し、見比べながら直す。お客様のご要望 2026-11-25「⑧」) */
  photo?: { src: string; fullSrc: string };
  /** 紐付けたお客様・この画面で登録した新規顧客 (選んだあとは選び直さない。お客様のご要望 2026-11-25「問い合わせ登録時の顧客登録・紐付け」) */
  chosen?: ChosenCustomer;
  /** 紐付けたお客様の案件 (進行中・最近の完了。src/lib/case-choice.ts) */
  caseOptions?: { open: CaseOption[]; past: CaseOption[]; pastTotal: number };
  /** 初めに選んでおく案件 ("new" = 新規案件) */
  caseChoice?: string;
  suggestedCaseId?: string;
  handoffDefault?: boolean;
}) {
  // お客様を決めたあとは「問い合わせとして登録」(新規案件か既存の案件かは ② 案件で選ぶ)
  const [act, setAct] = useState<ReceptionAction>(chosen ? "inquiry" : suggestion.action);
  const [customerId, setCustomerId] = useState(suggestion.customerId ?? "");
  const [caseKey, setCaseKey] = useState(suggestion.caseKey ?? "");
  const [caseChoice, setCaseChoice] = useState(initialChoice);
  const [assigneePicked, setAssigneePicked] = useState<string | null>(assigneeChosen ?? null);
  const [media, setMedia] = useState<string | null>(mediaChosen ?? null);
  const uncertain = new Set(fields.uncertainFields);
  const shownCases = useMemo(() => (customerId ? cases.filter((c) => c.customerId === customerId || c.key === suggestion.caseKey) : cases), [cases, customerId, suggestion.caseKey]);
  const actions: ReceptionAction[] = chosen ? ["inquiry", "record", "dismiss"] : ["inquiry", "case", "record", "dismiss"];

  // 追加する案件 (② 案件で選んだ案件 / 「登録先 (詳しく選ぶ)」で選んだ案件)
  const option = chosen && act === "inquiry" && caseChoice !== "new" ? [...(caseOptions?.open ?? []), ...(caseOptions?.past ?? [])].find((c) => c.id === caseChoice) : undefined;
  const legacyCase = !chosen && act === "case" ? cases.find((c) => c.key === caseKey) : undefined;
  const caseStore = option
    ? { id: option.storeId, name: option.storeName, number: option.number }
    : legacyCase?.storeId
      ? { id: legacyCase.storeId, name: legacyCase.storeName ?? legacyCase.storeId, number: legacyCase.number }
      : undefined;
  const ownerOf = option?.ownerId ?? legacyCase?.ownerId;
  // 担当者の初期値: 案件の担当 → (担当店舗をほかの店舗にしたとき) その店舗の店長 → 既定 (自分・受付の店舗の店長)
  const [storeValue, setStoreValue] = useState<StoreId | undefined>(undefined);
  const storeManager = storeValue && userStoreId && storeValue !== userStoreId ? managers[storeValue] : undefined;
  const assignee = assigneePicked ?? (ownerOf && users.some((u) => u.id === ownerOf) ? ownerOf : storeManager && users.some((u) => u.id === storeManager) ? storeManager : defaultAssigneeId);
  const mediaValue = media ?? option?.media ?? legacyCase?.media ?? mediaDefault ?? "";
  const registering = act === "inquiry" || act === "case";

  const field = (k: keyof ReceptionFields, opts: { wide?: boolean; textarea?: boolean; placeholder?: string; type?: string } = {}) => (
    <label className={`block ${opts.wide ? "@xl:col-span-2" : ""}`}>
      <span className="label">
        {RECEPTION_FIELD_LABEL[k]}
        {uncertain.has(k) && <span className="ml-1 rounded bg-warn-soft px-1 text-[10px] text-warn-ink">要確認</span>}
      </span>
      {opts.textarea ? (
        <textarea name={k} defaultValue={String(fields[k] ?? "")} rows={5} placeholder={opts.placeholder} className={`field ${uncertain.has(k) ? "border-warn bg-warn-soft/40" : ""}`} />
      ) : (
        <input name={k} type={opts.type ?? "text"} defaultValue={String(fields[k] ?? "")} placeholder={opts.placeholder} className={`field ${uncertain.has(k) ? "border-warn bg-warn-soft/40" : ""}`} />
      )}
    </label>
  );

  const registerLabel = option ? `案件 ${option.number} に問い合わせを追加して登録する` : act === "case" ? "案件に問い合わせを追加して登録する" : chosen ? "新しい案件として問い合わせを登録する" : "問い合わせとして登録する";
  const btn = "inline-flex min-h-10 items-center justify-center rounded-lg px-3 py-2 text-sm font-medium";

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="id" value={id} />
      {photo && (
        <details open className="rounded-xl border border-line bg-panel p-2 @4xl:hidden" data-testid="reception-photo-inline">
          <summary className="cursor-pointer text-xs font-semibold text-ink">メモの写真を見ながら直す</summary>
          <div className="mt-2">
            <MemoPhoto src={photo.src} fullSrc={photo.fullSrc} compact />
          </div>
        </details>
      )}
      <MatchPanel customers={customers} canCreateCustomer={canCreateCustomer} fields={fields} chosen={chosen} />
      {chosen && act === "inquiry" && caseOptions && (
        <CaseChoice value={caseChoice} onChange={setCaseChoice} open={caseOptions.open} past={caseOptions.past} pastTotal={caseOptions.pastTotal} customerName={chosen.name} suggestedId={suggestedCaseId} step="②" />
      )}

      {/* 受付の情報: 入口・媒体・担当店舗・担当者は、この画面で 1 回だけ選ぶ (お客様のご要望 2026-11-26「■2」)。問い合わせ・引き継ぎ・見積に引き継ぐ */}
      <section className="space-y-3 rounded-xl border border-line bg-panel p-4" data-testid="reception-basics">
        <div>
          <h3 className="text-sm font-semibold text-ink">{chosen ? "③" : "②"} 受付の情報 (ここで 1 回だけ選びます)</h3>
          <p className="text-[11px] text-ink-3">選んだ媒体・担当店舗・担当者は、登録する問い合わせと、そのあとの依頼・見積にそのまま引き継ぎます。お客様の紐付け・「修正を保存」のあとも選び直す必要はありません。</p>
        </div>
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          <label className="block">
            <span className="label">入口 (どこで受けたか)</span>
            <select name="channel" defaultValue={channel} className="field" data-testid="reception-channel">
              {[...new Set([...RECEPTION_CHANNELS, channel])].map((c) => <option key={c} value={c}>{c === "phone" ? "電話 (会社・店舗の電話)" : c === "referral" ? "紹介 (現場・知人など)" : CHANNEL_LABEL[c]}</option>)}
            </select>
          </label>
          {registering && (
            <label className="block">
              <span className="label">媒体 (当社を知ったきっかけ) <span className="text-critical">*</span></span>
              {/* mediaPicked = 手で選んだ (画面を読み直しても選び直さない。選んでいなければ案件の媒体・メモの言葉から) */}
              <input type="hidden" name="mediaPicked" value={media !== null ? "1" : ""} />
              <select name="media" value={mediaValue} onChange={(e) => setMedia(e.target.value)} required className="field" data-testid="reception-media">
                <option value="">選んでください</option>
                {MEDIA_KEYS.map((k) => (
                  <option key={k} value={k} title={MEDIA[k].hint}>
                    {MEDIA[k].label}
                  </option>
                ))}
              </select>
              <input type="hidden" name="mediaText" value={fields.mediaText} />
              <span className="mt-1 block text-[11px] text-ink-3">
                {fields.mediaText ? `メモ・会話の言葉: 「${fields.mediaText}」から選びました。` : "お客様に聞けなかったときは「不明」を選びます。"}
                {media === null && (option?.media || legacyCase?.media) ? " 追加する案件の媒体にしています。" : ""}
              </span>
            </label>
          )}
          {registering && (
            <AutoStoreSelect
              stores={stores}
              canChooseAny={canChooseStore}
              fallbackStoreId={store.fallbackStoreId}
              choices={store.choices}
              watch={["siteAddress", "address"]}
              initialAddress={store.initialAddress}
              fallbackAddress={store.fallbackAddress}
              initialArea={store.initialArea}
              caseStore={caseStore}
              initialStoreId={store.pickedStoreId}
              initialManual={Boolean(store.pickedStoreId)}
              testId="reception-store"
              onValue={setStoreValue}
            />
          )}
          {registering && (
            <label className="block">
              <span className="label">担当者</span>
              <input type="hidden" name="assigneePicked" value={assigneePicked !== null ? "1" : ""} />
              <select name="assignedUserId" value={assignee} onChange={(e) => setAssigneePicked(e.target.value)} className="field" data-testid="reception-assignee">
                {users.map((u) => <option key={u.id} value={u.id}>{u.label}{u.id === ownerOf ? " (案件の担当)" : ""}</option>)}
              </select>
            </label>
          )}
          {registering && assignee !== currentUserId && (
            <label className="flex items-start gap-2 text-sm @xl:col-span-2">
              <input type="hidden" name="handoffSent" value="1" />
              <input type="checkbox" name="handoff" defaultChecked={handoffDefault} className="mt-1" />
              <span>担当者に引き継ぐ (業務依頼を作って知らせる。確認・報告の状況が問い合わせに出ます)</span>
            </label>
          )}
          {fields.uncertainFields.length > 0 && (
            <label className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink @xl:col-span-2">
              <input type="checkbox" name="confirmedUncertain" className="mt-0.5" />
              <span>黄色の項目 ({fields.uncertainFields.map((k) => RECEPTION_FIELD_LABEL[k as keyof ReceptionFields] ?? k).join("・")}) を下の欄でメモと見比べて確認しました</span>
            </label>
          )}
        </div>
        {chosen && act === "inquiry" && (
          <>
            <p className="text-[11px] text-ink-3">下の内容 (お名前・住所・用件・日程) を確かめてから押してください。問い合わせは {chosen.name} 様の履歴として残ります (見積・受注に進まなくても残ります)。</p>
            <button type="submit" name="intent" value="inquiry" className={`${btn} w-full bg-accent text-white hover:bg-accent-hover`} data-testid="reception-register-chosen">
              {registerLabel}
            </button>
          </>
        )}
      </section>

      <section className="space-y-3">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          <label className="block">
            <span className="label">内容の種類 (AI の判定)</span>
            <select name="callType" defaultValue={fields.callType} className="field">
              <option value="">(未判定)</option>
              {RECEPTION_TYPES.map((t) => <option key={t} value={t}>{RECEPTION_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="label">{RECEPTION_FIELD_LABEL.category}</span>
            <select name="category" defaultValue={fields.category} className="field">
              <option value="">(未選択)</option>
              {Object.values(CATEGORY_LABEL).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {field("customerName", { placeholder: "例: 山田 花子" })}
          {field("kana")}
          {field("phone", { placeholder: "090-0000-0000" })}
          {field("otherPhone")}
          {field("postalCode")}
          {field("address")}
          {field("siteAddress", { placeholder: "依頼主の住所と違うとき (業者の現場・ご実家など)" })}
          {field("email")}
          {field("summary", { wide: true, placeholder: "例: 和室6畳の表替えの見積依頼" })}
          {field("detail", { wide: true, textarea: true })}
          <AppointmentsEditor initial={fields.appointments} users={users} defaultAssigneeId={assignee} uncertain={uncertain.has("appointments")} />
          {field("desiredDate", { placeholder: "例: 来週土曜の午前 (まだ決まっていない希望)" })}
          <label className="block">
            <span className="label">{RECEPTION_FIELD_LABEL.urgency}</span>
            <select name="urgency" defaultValue={fields.urgency} className="field">
              {Object.entries(URGENCY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="label">{RECEPTION_FIELD_LABEL.callback}</span>
            <select name="callback" defaultValue={fields.callback} className="field">
              <option value="">-</option>
              <option value="要">要</option>
              <option value="不要">不要</option>
            </select>
          </label>
          {field("caseHint", { placeholder: "例: 来週の引取の件 / O-2026-0123" })}
          {field("companyName")}
          {field("staffName")}
          {field("receivedAt", { type: "datetime-local" })}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-line bg-subtle/60 p-4">
        <h3 className="text-sm font-semibold text-ink">登録先 (詳しく選ぶ)</h3>
        <p className="text-xs text-ink-2">提案: {suggestion.reason}</p>
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
          {actions.map((a) => (
            <label key={a} className={`flex cursor-pointer gap-2 rounded-lg border px-3 py-2 text-sm ${act === a ? "border-accent bg-accent-soft" : "border-line bg-panel"}`}>
              <input type="radio" name="_action" checked={act === a} onChange={() => setAct(a)} className="mt-1" />
              <span>
                <span className="font-medium text-ink">{RECEPTION_ACTION_LABEL[a]}</span>
                {(suggestion.action === a || (chosen && a === "inquiry" && suggestion.action === "case")) && <span className="ml-1 rounded bg-accent px-1.5 text-[10px] text-white">提案</span>}
                <span className="block text-[11px] text-ink-3">{ACTION_NOTE[a]}</span>
              </span>
            </label>
          ))}
        </div>

        {act === "inquiry" &&
          (chosen ? (
            <p className="rounded-lg bg-good-soft px-3 py-2 text-sm text-good-ink" data-testid="reception-chosen-inline">
              お客様: <span className="font-semibold">{chosen.name} 様</span> ({chosen.code}){chosen.created ? " · この画面で新規顧客として登録済み" : " · 紐付け済み"}。{option ? `案件 ${option.number} に問い合わせを追加します。` : "新しい案件として登録します。"}
            </p>
          ) : (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-ink" data-testid="reception-no-customer">
              お客様がまだ決まっていません。上の「お客様・案件の確認」で既存のお客様に紐付けるか、「新規顧客として登録」を押してください (問い合わせは必ずお客様に紐付けて保存します)。
            </p>
          ))}
        {act === "case" && customers.length > 0 && (
          <label className="block">
            <span className="label">お客様 (案件の候補を絞る)</span>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="field">
              <option value="">(すべての候補の案件を表示)</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.placeholder ? "【予定表】" : c.level === "address" ? "【住所】" : c.level === "phone" ? "【電話】" : "【名前】"} {c.label} — {c.reason}</option>)}
            </select>
          </label>
        )}

        {act === "case" && (
          <div className="space-y-2">
            {shownCases.length > 0 ? (
              <div className="space-y-1.5">
                {shownCases.map((c) => (
                  <label key={c.key} className={`flex cursor-pointer gap-2 rounded-lg border px-3 py-2 text-sm ${caseKey === c.key ? "border-accent bg-accent-soft" : "border-line bg-panel"}`}>
                    <input type="radio" name="caseKey" value={c.key} checked={caseKey === c.key} onChange={() => setCaseKey(c.key)} className="mt-1" />
                    <span className="min-w-0">
                      <span className="font-medium text-ink">{c.kindLabel} {c.number}</span> <span className="text-ink-2">{c.title}</span>
                      <span className="block text-[11px] text-ink-3">{c.customerName ? `${c.customerName} 様 · ` : ""}{c.statusLabel}{c.open ? "" : " (完了)"} · {c.date} · {c.reason}{c.storeName ? ` · ${c.storeName}` : ""} · <a href={c.href} target="_blank" rel="noreferrer" className="text-accent hover:underline">開く</a></span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-ink-3">候補の案件がありません。案件番号を入力してください。</p>
            )}
            <label className="block">
              <span className="label">または案件番号 (INQ-・Q-・O- など。入力するとこちらを使います)</span>
              <input name="caseRef" placeholder="例: O-2026-0123" className="field" />
            </label>
            <p className="text-[11px] text-ink-3">選んだ案件のお客様の問い合わせとして登録し、案件の担当者を上の「担当者」にします (引き継ぐと業務依頼で知らせます)。</p>
          </div>
        )}

        {act === "record" && (
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            <label className="block">
              <span className="label">仕入先・協力業者</span>
              <select name="supplierId" defaultValue={suggestion.supplierId ?? ""} className="field">
                <option value="">(選ばない)</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.matched ? " (電話番号・名前が一致)" : ""}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">または、お客様</span>
              <select name="recordCustomerId" defaultValue={suggestion.action === "record" ? (suggestion.customerId ?? "") : ""} className="field">
                <option value="">(選ばない)</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
          </div>
        )}

        {act === "dismiss" && (
          <label className="block">
            <span className="label">理由 (任意)</span>
            <input name="dismissNote" placeholder="例: 回線の営業電話 / 間違い電話" className="field" />
          </label>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="submit" name="intent" value="save" formNoValidate className="inline-flex h-10 items-center rounded-lg border border-line bg-panel px-4 text-sm text-ink-2 hover:bg-subtle">修正を保存</button>
          <button type="submit" name="intent" value={act} formNoValidate={!registering} disabled={act === "inquiry" && !chosen} className={`inline-flex h-10 items-center rounded-lg px-5 text-sm font-medium text-white disabled:opacity-40 ${act === "dismiss" ? "bg-ink-2 hover:bg-ink" : "bg-accent hover:bg-accent-hover"}`}>
            {registering ? registerLabel : act === "record" ? "やりとりとして記録する" : "記録せずに閉じる"}
          </button>
        </div>
      </section>
    </form>
  );
}

/**
 * ① お客様の確認 (お客様のご要望 2026-11-24「追加 ③」、2026-11-25「問い合わせ登録時の顧客登録・紐付け」①②)。
 * 最初にお客様を決める: 候補・検索のお客様の「このお客様に紐付ける」(quick = link:<顧客>) か「新規顧客として登録」(quick = new。その場で顧客を保存)。
 * 決めたお客様は受付に残り、そのあとは選び直さない (「別のお客様にする」= unlink で外す)。
 * お客様を決めたら、そのお客様の案件から「新規案件 / この案件に問い合わせを追加」を選ぶ (CaseChoice。お客様のご要望 2026-11-26「■5」)。
 * 問い合わせの登録は、お客様が決まってから (actions/reception.ts の registerReception)
 */
function MatchPanel({ customers, fields, chosen }: { customers: ReviewCustomer[]; canCreateCustomer: boolean; fields: ReceptionFields; chosen?: ChosenCustomer }) {
  // 候補の順 (お客様のご要望 2026-11-24): ① 住所の一致 → ② 電話番号の一致 → ③ 名字の一致。
  // 予定表 (スプレッドシート) から移行した予定の仮のお客様は、いちばん上に分けて出す (お客様のご連絡 2026-11-27)
  const fromSheet = customers.filter((c) => c.placeholder);
  const byAddress = customers.filter((c) => c.level === "address" && !c.placeholder);
  const byPhone = customers.filter((c) => c.level === "phone" && !c.placeholder);
  const byName = customers.filter((c) => c.level === "name" && !c.placeholder);
  const strong = [...byAddress, ...byPhone];
  const btn = "inline-flex min-h-10 items-center justify-center rounded-lg px-3 py-2 text-sm font-medium";
  const LEVEL: Record<ReviewCustomer["level"], { label: string; cls: string }> = {
    preset: { label: "このお客様", cls: "bg-accent text-white" },
    address: { label: "住所が一致", cls: "bg-good-soft text-good-ink" },
    phone: { label: "電話番号が一致", cls: "bg-info-soft text-info-ink" },
    name: { label: "名字が一致", cls: "bg-subtle text-ink-2" },
  };
  const card = (c: ReviewCustomer, primary: boolean) => (
    <li key={c.id} className={`rounded-lg border bg-panel p-3 ${primary ? "border-accent/60 ring-1 ring-accent/30" : "border-line"}`} data-testid="reception-candidate">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${c.placeholder ? "bg-warn-soft text-warn-ink" : LEVEL[c.level].cls}`}>{c.placeholder ? "予定表から移行 (仮の登録)" : LEVEL[c.level].label}</span>
        <span className="text-base font-semibold text-ink">{c.name} 様</span>
        <span className="text-[11px] text-ink-3">{c.code} · {c.storeName}</span>
      </div>
      <div className="mt-1 text-sm text-ink">{c.address || <span className="text-ink-3">住所未登録</span>}</div>
      {c.phone && <div className="text-xs text-ink-2 tnum">{c.phone}</div>}
      <div className="mt-0.5 text-[11px] text-ink-3">{c.reason}</div>
      <button type="submit" name="quick" value={`link:${c.id}`} formNoValidate className={`${btn} mt-2 w-full ${primary ? "bg-accent text-white hover:bg-accent-hover" : "border border-accent/50 bg-panel text-accent-ink hover:bg-accent-soft"}`}>
        {c.placeholder ? "このお客様に紐付ける (メモの電話・住所で正式に登録)" : "このお客様に紐付ける"}
      </button>
    </li>
  );

  // お客様が決まったあと: 選び直さない (変えるときだけ「別のお客様にする」)
  if (chosen) {
    return (
      <section className="space-y-3 rounded-xl border-2 border-good/50 bg-good-soft/30 p-4" data-testid="reception-match">
        <h3 className="text-sm font-semibold text-ink">① お客様 {chosen.created ? "(新規顧客として登録しました)" : "(紐付けました)"}</h3>
        <div className="rounded-lg border border-good/40 bg-panel p-3" data-testid="reception-chosen">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-good-soft px-1.5 py-0.5 text-[10px] font-semibold text-good-ink">{chosen.created ? "新規顧客" : chosen.fromCustomer ? "顧客の画面から" : "紐付け済み"}</span>
            <span className="text-base font-semibold text-ink">{chosen.name} 様</span>
            <span className="text-[11px] text-ink-3">{chosen.code} · {chosen.storeName}</span>
          </div>
          <div className="mt-1 text-sm text-ink">{chosen.address || <span className="text-ink-3">住所未登録</span>}</div>
          {chosen.phone && <div className="text-xs text-ink-2 tnum">{chosen.phone}</div>}
          <button type="submit" name="quick" value="unlink" formNoValidate className="mt-2 text-xs text-ink-2 hover:underline">
            別のお客様にする (紐付けをやめる)
          </button>
        </div>
      </section>
    );
  }

  const memoName = fields.customerName.split(/[\s　]/)[0]?.replace(/(様|さま|さん)$/, "") ?? "";
  return (
    <section className="space-y-3 rounded-xl border-2 border-accent/40 bg-accent-soft/25 p-4" data-testid="reception-match">
      <h3 className="text-sm font-semibold text-ink">① お客様の確認 (最初にお客様を決めてください)</h3>
      {byAddress.length ? (
        <p className="text-sm font-medium text-ink">住所が一致するお客様がいます。このお客様に紐付けますか？ (お名前と住所を確かめてください)</p>
      ) : byPhone.length ? (
        <p className="text-sm font-medium text-ink">電話番号が一致するお客様がいます。このお客様に紐付けますか？ (住所を確かめてください)</p>
      ) : byName.length ? (
        <p className="text-sm text-ink">住所・電話番号が一致するお客様は見つかりませんでした。名字が同じお客様がいます (住所を確かめて、同じお客様なら紐付けてください){fields.address ? "" : "。住所が読み取れていません。住所を直して「修正を保存」すると探し直します"}。</p>
      ) : fromSheet.length ? (
        <p className="text-sm font-medium text-ink">予定表 (スプレッドシート) から移行した予定のお客様が見つかりました。同じお客様なら紐付けてください (新規顧客として登録すると、同じお客様が二重になります)。</p>
      ) : (
        <p className="text-sm text-ink">既存のお客様は見つかりませんでした{fields.address ? "" : " (住所が読み取れていません。住所を直して「修正を保存」すると探し直します)"}。新しいお客様なら「新規顧客として登録」を押してください。</p>
      )}
      <p className="text-[11px] text-ink-3">お客様を決めると、そのお客様の進行中の案件・完了した案件が出ます。新しいご依頼か、すでにある案件のご連絡 (日程の変更・クレーム・手直しなど) かを、そこで選びます。</p>
      {fromSheet.length > 0 && (
        <div className="rounded-lg border border-warn/50 bg-warn-soft/30 p-3" data-testid="reception-sheet-candidates">
          <p className="text-xs font-semibold text-warn-ink">予定表 (スプレッドシート) から移行した予定のお客様</p>
          <p className="mb-2 mt-0.5 text-[11px] text-ink-2">
            予定表には名字と地区しかないため、仮に登録したお客様です (予定と案件はこのお客様についています)。同じお客様なら「このお客様に紐付ける」を押してください。メモの電話番号・住所を足して正式なお客様にし、予定表の案件をそのまま選べます。名字は手書きの読み違いのことがあるので、町名と予定の日で確かめてください。
          </p>
          <ul className="grid grid-cols-1 gap-2 @xl:grid-cols-2">{fromSheet.slice(0, 4).map((c, i) => card(c, !byAddress.length && !byPhone.length && i === 0))}</ul>
        </div>
      )}
      {byAddress.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-good-ink">① 住所が一致</p>
          <ul className="grid grid-cols-1 gap-2 @xl:grid-cols-2">{byAddress.slice(0, 6).map((c, i) => card(c, i === 0))}</ul>
        </div>
      )}
      {byPhone.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-info-ink">② 電話番号が一致</p>
          <ul className="grid grid-cols-1 gap-2 @xl:grid-cols-2">{byPhone.slice(0, 4).map((c, i) => card(c, !byAddress.length && i === 0))}</ul>
        </div>
      )}
      {byName.length > 0 &&
        (strong.length ? (
          <details>
            <summary className="cursor-pointer text-xs font-semibold text-ink-2">③ 名字が一致するお客様 {byName.length} 件 (住所が違う可能性があります)</summary>
            <ul className="mt-2 grid grid-cols-1 gap-2 @xl:grid-cols-2">{byName.slice(0, 8).map((c) => card(c, false))}</ul>
          </details>
        ) : (
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-2">③ 名字が一致 (同じ町名・最近の取引の順)</p>
            <ul className="grid grid-cols-1 gap-2 @xl:grid-cols-2">{byName.slice(0, 4).map((c) => card(c, false))}</ul>
            {byName.length > 4 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-ink-2">ほか {byName.length - 4} 件</summary>
                <ul className="mt-2 grid grid-cols-1 gap-2 @xl:grid-cols-2">{byName.slice(4, 8).map((c) => card(c, false))}</ul>
              </details>
            )}
          </div>
        ))}
      <details className="rounded-lg border border-line bg-panel/70 p-3" open={!strong.length}>
        <summary className="cursor-pointer text-sm font-medium text-ink">候補にないときは: 既存のお客様を検索して紐付ける</summary>
        <div className="mt-2">
          <ReceptionCustomerSearch initialQuery={strong.length ? "" : memoName} />
        </div>
      </details>
      <div className="rounded-lg border border-dashed border-line-strong bg-panel/70 p-3">
        {customers.length > 0 && (
          <label className="mb-2 flex items-start gap-2 text-xs text-ink">
            <input type="checkbox" name="confirmDuplicate" className="mt-0.5 h-4 w-4" />
            上の候補・検索のお客様とは別のお客様です
          </label>
        )}
        <button type="submit" name="quick" value="new" formNoValidate className={`${btn} w-full ${strong.length || fromSheet.length ? "border border-line bg-panel text-ink hover:bg-subtle" : "bg-accent text-white hover:bg-accent-hover"}`} data-testid="reception-new-customer">
          新規顧客として登録 (顧客情報を保存)
        </button>
        <p className="mt-1 text-[11px] text-ink-3">下の欄のお名前・ふりがな・電話・住所で、この時点で顧客を登録します。登録したあとは、続けて問い合わせを登録します (お客様を選び直す必要はありません)。</p>
      </div>
    </section>
  );
}

const APPT_LABEL: Record<(typeof APPOINTMENT_KINDS)[number], string> = { survey: "見積り", site_survey: "現地調査 (現調)", onsite_quote: "現場見積 (現見)", measure: "採寸", pickup: "引取", delivery: "納品", install: "施工", visit: "訪問・打合せ" };

/**
 * メモ・会話で決まっている日程 (訪問・引取など) を、予定の登録の初期値として直す (お客様のご要望 2026-11-25「⑦」)。
 * 「予定表に登録」にチェックした行は、問い合わせとして登録するときに予定表にも登録する。登録したあとも予定表で変えられる
 */
function AppointmentsEditor({ initial, users, defaultAssigneeId, uncertain }: { initial: ReceptionAppointment[]; users: { id: string; label: string }[]; defaultAssigneeId: string; uncertain: boolean }) {
  const [rows, setRows] = useState<ReceptionAppointment[]>(() => initial.map((a) => ({ ...a, register: a.register ?? Boolean(a.date) })));
  const set = (k: number, patch: Partial<ReceptionAppointment>) => setRows((rs) => rs.map((r, i) => (i === k ? { ...r, ...patch } : r)));
  const mode = (r: ReceptionAppointment) => (r.time ? "time" : r.slot || "allday");
  return (
    <div className={`@xl:col-span-2 rounded-xl border p-3 ${uncertain ? "border-warn bg-warn-soft/30" : "border-line bg-subtle/40"}`} data-testid="reception-appointments">
      <input type="hidden" name="appointments" value={JSON.stringify(rows)} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">決まっている日程 (予定表に登録)</span>
        {uncertain && <span className="rounded bg-warn-soft px-1 text-[10px] text-warn-ink">要確認</span>}
        <span className="text-[11px] text-ink-3">メモの日付を AI が読み取りました。違っていれば直してください。問い合わせとして登録するときに予定表にも入ります (あとからでも変えられます)</span>
      </div>
      {rows.length === 0 && <p className="mt-1 text-xs text-ink-3">メモに決まった日程は見つかりませんでした。決まっていれば「日程を追加」で入れられます。</p>}
      <ul className="mt-2 space-y-2">
        {rows.map((r, k) => (
          <li key={k} className="rounded-lg border border-line bg-panel p-2">
            {r.text && <p className="mb-1 text-[11px] text-ink-3">メモの文字: 「{r.text}」</p>}
            <div className="grid grid-cols-1 gap-2 @xl:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
              <label className="flex items-center gap-1.5 text-xs font-medium text-ink">
                <input type="checkbox" checked={Boolean(r.register)} onChange={(e) => set(k, { register: e.target.checked })} className="h-4 w-4" />
                予定表に登録
              </label>
              <select value={r.kind} onChange={(e) => set(k, { kind: e.target.value as ReceptionAppointment["kind"] })} className="field" aria-label="予定の種類">
                {APPOINTMENT_KINDS.map((kk) => (
                  <option key={kk} value={kk}>
                    {APPT_LABEL[kk]}
                  </option>
                ))}
              </select>
              <input type="date" value={r.date} onChange={(e) => set(k, { date: e.target.value })} className="field" aria-label="日付" />
              <div className="flex gap-1">
                <select value={mode(r)} onChange={(e) => set(k, e.target.value === "time" ? { time: r.time || "10:00", slot: "" } : { time: "", slot: e.target.value === "allday" ? "" : (e.target.value as "am" | "pm") })} className="field" aria-label="時間">
                  <option value="allday">終日</option>
                  <option value="am">午前</option>
                  <option value="pm">午後</option>
                  <option value="time">時刻</option>
                </select>
                {r.time && <input type="time" value={r.time} onChange={(e) => set(k, { time: e.target.value })} className="field w-28" aria-label="時刻" />}
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <select value={r.assigneeId ?? defaultAssigneeId} onChange={(e) => set(k, { assigneeId: e.target.value })} className="field w-auto" aria-label="予定の担当者">
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    担当: {u.label}
                  </option>
                ))}
              </select>
              {r.register && !r.date && <span className="text-[11px] text-critical-ink">日付を入れてください (日付がないと登録しません)</span>}
              <button type="button" onClick={() => setRows((rs) => rs.filter((_, i) => i !== k))} className="ml-auto text-[11px] text-ink-2 hover:underline">
                この日程を消す
              </button>
            </div>
          </li>
        ))}
      </ul>
      {rows.length < 6 && (
        <button type="button" onClick={() => setRows((rs) => [...rs, { kind: "survey", date: "", time: "", slot: "", text: "", register: true }])} className="mt-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-xs text-ink-2 hover:border-accent/50">
          + 日程を追加
        </button>
      )}
    </div>
  );
}
