import "server-only";
import type { CapturedDocument, Channel, Database, StoreId } from "@/lib/db/types";
import { addAudit, nowIso } from "@/lib/db/store";
import { phoneDigits } from "@/lib/customer-contacts";
import { aiIntakeSettings } from "@/lib/ai-intake";
import { RECEPTION_SOURCE_LABEL, receptionTitle, type ReceptionMeta, type ReceptionSource } from "@/lib/reception";
import type { ReceptionRead } from "@/lib/ai/reception";

/**
 * 受付 (documents。kind = reception) を作る。画面の取込 (src/lib/actions/reception.ts)・通話の録音 (/api/reception/audio)・
 * 電話のシステムからの受信 (/api/integrations/phone-call) で共通
 */

const PROVIDER_LABEL: Record<ReceptionRead["provider"], string> = { claude: "Claude", openai: "OpenAI", rules: "AI なし (言葉の規則)", error: "読取失敗" };

export function providerLabel(p: unknown): string {
  return PROVIDER_LABEL[p as ReceptionRead["provider"]] ?? "読取";
}

/** 受付の読み取りの結果を書類の extracted にする (_ で始まる項目は受付の記録) */
export function receptionExtracted(read: ReceptionRead, meta: Pick<ReceptionMeta, "source" | "channel" | "text" | "call">): Record<string, unknown> {
  return {
    ...read.fields,
    _source: meta.source,
    _channel: meta.channel,
    ...(meta.text ? { _text: meta.text.slice(0, 30_000) } : {}),
    ...(meta.call ? { _call: meta.call } : {}),
    _provider: read.provider,
    _model: read.model,
    _warnings: read.warnings,
    _aiWarnings: read.warnings,
    _error: read.error,
    _ms: read.ms,
    _readAt: nowIso(),
    // AI が読み取ったままの値 (担当者の修正と比べて、読取の正確さを集計する)
    ...(read.ai ? { _ai: read.ai } : {}),
  };
}

export function newReceptionDoc(p: { id: string; uploadedBy: string; storeId: StoreId; source: ReceptionSource; channel: Channel; fileName?: string; text?: string; call?: ReceptionMeta["call"]; read: ReceptionRead }): CapturedDocument {
  const at = nowIso();
  const stamp = new Date(at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return {
    id: p.id,
    kind: "reception",
    fileName: (p.fileName || `受付 (${RECEPTION_SOURCE_LABEL[p.source]}) ${stamp}`).slice(0, 200),
    uploadedBy: p.uploadedBy,
    storeId: p.storeId,
    uploadedAt: at,
    status: p.read.provider === "error" && !p.text ? "failed" : "extracted",
    extracted: receptionExtracted(p.read, { source: p.source, channel: p.channel, text: p.text, call: p.call }),
    confidence: p.read.confidence,
  };
}

/** 受付を登録して変更履歴に書く (mutate の中で呼ぶ) */
export function pushReceptionDoc(db: Database, doc: CapturedDocument, userId: string) {
  db.documents.push(doc);
  const fields = doc.extracted ?? {};
  addAudit(db, { userId, action: "create", entity: "document", entityId: doc.id, entityLabel: doc.fileName, summary: `受付を取込 (${RECEPTION_SOURCE_LABEL[(fields._source as ReceptionSource) ?? "text"]} / ${providerLabel(fields._provider)}${fields._error ? `: ${fields._error}` : ""} / ${receptionTitle(fields as never)})`, storeId: doc.storeId });
}

/**
 * 電話のシステムから届いた通話の店舗: 指定 (店舗 ID・店舗名) → かかってきた番号 (店舗の電話番号と一致) → 内線・担当者の所属 → AI 受付の既定の店舗
 */
export function storeOfCall(db: Pick<Database, "stores" | "users" | "settings">, p: { store?: string; to?: string; staff?: string }): StoreId {
  const byStore = p.store ? db.stores.find((s) => s.id === p.store || s.name === p.store || s.shortName === p.store || s.name.includes(p.store!)) : undefined;
  if (byStore) return byStore.id;
  const to = phoneDigits(p.to);
  const byPhone = to.length >= 9 ? db.stores.find((s) => phoneDigits(s.phone) === to) : undefined;
  if (byPhone) return byPhone.id;
  const k = p.staff?.trim().toLowerCase();
  const staff = k ? db.users.find((u) => u.active && (u.id === p.staff || u.email.toLowerCase() === k || u.name.replace(/\s/g, "") === p.staff!.replace(/\s/g, ""))) : undefined;
  if (staff) return staff.storeId;
  return aiIntakeSettings(db).defaultStore;
}
