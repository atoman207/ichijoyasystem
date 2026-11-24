"use client";

import { useMemo, useState } from "react";
import type { Channel, MediaKey, StoreId } from "@/lib/db/types";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { MediaSelect } from "@/components/ops-reports/MediaFields";
import {
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
}

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
}

const ACTIONS: ReceptionAction[] = ["inquiry", "case", "record", "dismiss"];

const ACTION_NOTE: Record<ReceptionAction, string> = {
  inquiry: "受付一覧 (問い合わせ) に新しい問い合わせを登録し、店舗・担当者に知らせます",
  case: "進行中の見積・受注のやりとりに追加し、案件の担当者に知らせます (日程の変更・確認・手直しの連絡など)",
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
  storeId,
  canChooseStore,
  currentUserId,
  defaultAssigneeId,
  mediaDefault,
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
  storeId: StoreId;
  canChooseStore: boolean;
  currentUserId: string;
  defaultAssigneeId: string;
  mediaDefault?: MediaKey;
}) {
  const [act, setAct] = useState<ReceptionAction>(suggestion.action);
  const [customerId, setCustomerId] = useState(suggestion.customerId ?? "");
  const [caseKey, setCaseKey] = useState(suggestion.caseKey ?? "");
  const [assignee, setAssignee] = useState(defaultAssigneeId);
  const [notifyUser, setNotifyUser] = useState("");
  const uncertain = new Set(fields.uncertainFields);
  const shownCases = useMemo(() => (customerId ? cases.filter((c) => c.customerId === customerId || c.key === suggestion.caseKey) : cases), [cases, customerId, suggestion.caseKey]);
  const selectedCase = cases.find((c) => c.key === caseKey);
  const owner = notifyUser || selectedCase?.ownerId || "";

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

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="id" value={id} />
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
            <span className="label">入口</span>
            <select name="channel" defaultValue={channel} className="field">
              {[...new Set([...RECEPTION_CHANNELS, channel])].map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
            </select>
          </label>
          {field("customerName", { placeholder: "例: 山田 花子" })}
          {field("kana")}
          {field("phone", { placeholder: "090-0000-0000" })}
          {field("otherPhone")}
          {field("postalCode")}
          {field("address")}
          {field("email")}
          <label className="block">
            <span className="label">{RECEPTION_FIELD_LABEL.category}</span>
            <select name="category" defaultValue={fields.category} className="field">
              <option value="">(未選択)</option>
              {Object.values(CATEGORY_LABEL).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {field("summary", { wide: true, placeholder: "例: 和室6畳の表替えの見積依頼" })}
          {field("detail", { wide: true, textarea: true })}
          {field("desiredDate", { placeholder: "例: 来週土曜の午前" })}
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
          {field("mediaText", { placeholder: "例: チラシ・紹介・ホームページ" })}
          {field("caseHint", { placeholder: "例: 来週の引取の件 / O-2026-0123" })}
          {field("companyName")}
          {field("staffName")}
          {field("receivedAt", { type: "datetime-local" })}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-line bg-subtle/60 p-4">
        <h3 className="text-sm font-semibold text-ink">登録先</h3>
        <p className="text-xs text-ink-2">提案: {suggestion.reason}</p>
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
          {ACTIONS.map((a) => (
            <label key={a} className={`flex cursor-pointer gap-2 rounded-lg border px-3 py-2 text-sm ${act === a ? "border-accent bg-accent-soft" : "border-line bg-panel"}`}>
              <input type="radio" name="_action" checked={act === a} onChange={() => setAct(a)} className="mt-1" />
              <span>
                <span className="font-medium text-ink">{RECEPTION_ACTION_LABEL[a]}</span>
                {suggestion.action === a && <span className="ml-1 rounded bg-accent px-1.5 text-[10px] text-white">提案</span>}
                <span className="block text-[11px] text-ink-3">{ACTION_NOTE[a]}</span>
              </span>
            </label>
          ))}
        </div>

        {(act === "inquiry" || act === "case") && customers.length > 0 && (
          <label className="block">
            <span className="label">お客様 (住所がいちばんの目印。電話・氏名だけでは別住所と取り違えることがあります)</span>
            <select name="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="field">
              <option value="">{act === "inquiry" ? "(新しいお客様。あとで「顧客として登録する」)" : "(すべての候補の案件を表示)"}</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.level === "preset" ? "【このお客様】" : c.level === "address" ? "【住所】" : c.level === "phone" ? "【電話】" : "【名前】"} {c.label} — {c.reason}</option>)}
            </select>
          </label>
        )}
        {act === "inquiry" && customers.length === 0 && <input type="hidden" name="customerId" value="" />}

        {act === "inquiry" && (
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            <label className="block">
              <span className="label">受付店舗</span>
              <select name="storeId" defaultValue={storeId} disabled={!canChooseStore} className="field">
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {!canChooseStore && <input type="hidden" name="storeId" value={storeId} />}
            </label>
            <label className="block">
              <span className="label">媒体 (当社を知ったきっかけ) <span className="text-critical">*</span></span>
              <MediaSelect name="media" defaultValue={mediaDefault ?? ""} required />
            </label>
            <label className="block">
              <span className="label">担当者</span>
              <select name="assignedUserId" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="field">
                {users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </label>
            {assignee !== currentUserId && (
              <label className="flex items-start gap-2 pt-6 text-sm">
                <input type="checkbox" name="handoff" defaultChecked className="mt-1" />
                <span>担当者に引き継ぐ (業務依頼を作って知らせる。確認・報告の状況が問い合わせに出ます)</span>
              </label>
            )}
          </div>
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
                      <span className="block text-[11px] text-ink-3">{c.customerName ? `${c.customerName} 様 · ` : ""}{c.statusLabel}{c.open ? "" : " (完了)"} · {c.date} · {c.reason} · <a href={c.href} target="_blank" rel="noreferrer" className="text-accent hover:underline">開く</a></span>
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
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="notifyOwner" defaultChecked={Boolean(owner && owner !== currentUserId)} className="mt-1" />
              <span>案件の担当者に知らせる (業務依頼)</span>
            </label>
            <label className="block">
              <span className="label">知らせる担当者</span>
              <select name="notifyUserId" value={owner} onChange={(e) => setNotifyUser(e.target.value)} className="field">
                <option value="">(案件の担当者)</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </label>
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

        {fields.uncertainFields.length > 0 && act !== "dismiss" && (
          <label className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-ink">
            <input type="checkbox" name="confirmedUncertain" className="mt-1" />
            <span>黄色の項目 ({fields.uncertainFields.map((k) => RECEPTION_FIELD_LABEL[k as keyof ReceptionFields] ?? k).join("・")}) をメモ・会話と見比べて確認しました</span>
          </label>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="submit" name="intent" value="save" formNoValidate className="inline-flex h-10 items-center rounded-lg border border-line bg-panel px-4 text-sm text-ink-2 hover:bg-subtle">修正を保存</button>
          <button type="submit" name="intent" value={act} formNoValidate={act !== "inquiry"} className={`inline-flex h-10 items-center rounded-lg px-5 text-sm font-medium text-white ${act === "dismiss" ? "bg-ink-2 hover:bg-ink" : "bg-accent hover:bg-accent-hover"}`}>
            {act === "inquiry" ? "問い合わせとして登録する" : act === "case" ? "案件のやりとりに追加する" : act === "record" ? "やりとりとして記録する" : "記録せずに閉じる"}
          </button>
        </div>
      </section>
    </form>
  );
}
