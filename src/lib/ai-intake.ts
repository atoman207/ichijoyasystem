import type { Channel, CommLog, Database, Inquiry, ServiceCategory, StoreId, Thread, User } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { SYSTEM_USER, buildInquiry } from "@/lib/notify/inbound";

/**
 * 既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) からの受付情報の取込
 * ------------------------------------------------------------
 * 既存の AI システムは作り直さず、それぞれの「受付が終わったときの送信 (Webhook)」をこのシステムの
 * POST /api/integrations/ai-intake に向ける。項目名はシステムごとに違うため、よく使われる名前を広く受け付ける。
 * 1. 同じ受付 ID は 1 件だけ登録する (再送されても重複しない)
 * 2. 電話番号・メールが一致するお客様にひも付ける (候補が複数なら最近更新したお客様。内容に候補の件数を書く)
 * 3. 問い合わせ (入口: AI テキスト相談 / AI 音声相談 / AI 電話受付) と、会話の記録 (やりとり履歴) を登録する
 * 4. 引き継ぎ: 担当者 (指定 → 店舗ごとの既定 → 店長) に「業務依頼」を作る。依頼 → 確認 → 報告 → 完了で進める
 */

export type IntakeSource = "ai_chat" | "ai_voice" | "ai_phone";
export const INTAKE_SOURCES: IntakeSource[] = ["ai_chat", "ai_voice", "ai_phone"];

export interface IntakeInput {
  source: IntakeSource;
  externalId?: string;
  receivedAt?: string;
  name?: string;
  kana?: string;
  phone?: string;
  email?: string;
  postalCode?: string;
  address?: string;
  summary?: string;
  purpose?: string;
  detail?: string;
  transcript?: string;
  category?: string;
  store?: string;
  callbackPhone?: string;
  desiredDate?: string;
  urgency?: "high" | "normal" | "low";
  handoff?: boolean;
  handoffReason?: string;
  assignee?: string;
  recordingUrl?: string;
}

/* ================================================================== */
/* 設定                                                                 */
/* ================================================================== */

export const AI_INTAKE_SETTINGS_ID = "ai_intake";

export type HandoffMode = "always" | "requested" | "never";

export const HANDOFF_MODE_LABEL: Record<HandoffMode, string> = {
  always: "すべての受付を担当者に引き継ぐ (業務依頼を作る)",
  requested: "AI が「引き継ぎが必要」とした受付と、緊急度が高い受付だけ引き継ぐ",
  never: "引き継がない (問い合わせの登録だけ)",
};

export interface AiIntakeSettings {
  /** 店舗が分からないときに登録する店舗 */
  defaultStore: StoreId;
  handoff: HandoffMode;
  /** 店舗ごとの引き継ぎ先 (未設定は店長) */
  assignees: Partial<Record<StoreId, string>>;
}

export const DEFAULT_AI_INTAKE: AiIntakeSettings = { defaultStore: "hq", handoff: "always", assignees: {} };

export function aiIntakeSettings(db: Pick<Database, "settings">): AiIntakeSettings {
  const v = (db.settings.find((s) => s.id === AI_INTAKE_SETTINGS_ID)?.value ?? {}) as Partial<AiIntakeSettings>;
  return {
    defaultStore: (v.defaultStore as StoreId) ?? DEFAULT_AI_INTAKE.defaultStore,
    handoff: v.handoff === "requested" || v.handoff === "never" ? v.handoff : "always",
    assignees: v.assignees && typeof v.assignees === "object" ? v.assignees : {},
  };
}

/* ================================================================== */
/* 項目の読み取り (システムごとの名前の違いを吸収する)                     */
/* ================================================================== */

type Obj = Record<string, unknown>;
const NESTED = ["customer", "caller", "contact", "user", "call", "conversation", "session", "data", "payload", "result", "summary_data", "inquiry", "reception"];

function isObj(v: unknown): v is Obj {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** 上の階層から順に、候補の名前で値を探す (customer.phone のような入れ子も見る) */
function pick(p: Obj, keys: string[]): unknown {
  const lower = new Map(Object.keys(p).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real !== undefined && p[real] !== undefined && p[real] !== null && p[real] !== "") return p[real];
  }
  for (const n of NESTED) {
    const real = lower.get(n);
    const child = real !== undefined ? p[real] : undefined;
    if (isObj(child)) {
      const v = pick(child, keys);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

const text = (v: unknown, max = 500): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    const t = String(v).trim();
    return t ? t.slice(0, max) : undefined;
  }
  return undefined;
};

const truthy = (v: unknown): boolean | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  return /^(1|true|yes|y|on|要|必要|あり|はい)$/i.test(String(v).trim());
};

function toIso(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const s = String(v).trim().replace(/\//g, "-");
  const d = new Date(/T|\d{1,2}:\d{2}/.test(s) ? s.replace(" ", "T") : `${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** 会話の記録: 文字列 / [{role, content|text}] / [{speaker, message}] */
function transcriptOf(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim().slice(0, 20000) || undefined;
  if (!Array.isArray(v)) return undefined;
  const lines = v
    .map((m) => {
      if (typeof m === "string") return m;
      if (!isObj(m)) return "";
      const who = String(m.role ?? m.speaker ?? m.from ?? m.sender ?? "").toLowerCase();
      const body = text(m.content ?? m.text ?? m.message ?? m.body ?? m.utterance, 4000) ?? "";
      const label = /user|customer|caller|client|human|お客/.test(who) ? "お客様" : /assistant|ai|bot|agent|system|operator/.test(who) ? "AI" : who || "";
      return body ? `${label ? `${label}: ` : ""}${body}` : "";
    })
    .filter(Boolean);
  return lines.length ? lines.join("\n").slice(0, 20000) : undefined;
}

export function intakeSourceOf(v: unknown): IntakeSource | undefined {
  const s = String(v ?? "").toLowerCase();
  if (!s) return undefined;
  if (/^ai_(chat|voice|phone)$/.test(s)) return s as IntakeSource;
  if (/voice|speech|音声/.test(s)) return "ai_voice";
  if (/phone|call|tel|ivr|電話/.test(s)) return "ai_phone";
  if (/chat|text|web|line|message|テキスト|チャット/.test(s)) return "ai_chat";
  return undefined;
}

/** 受け取った JSON を共通の形にする。source はクエリ (?source=phone) が優先 */
export function normalizeIntake(payload: Obj, sourceHint?: string): { input?: IntakeInput; error?: string } {
  const source = intakeSourceOf(sourceHint) ?? intakeSourceOf(pick(payload, ["source", "channel", "type", "kind", "system"]));
  if (!source) return { error: "source (chat / voice / phone) を指定してください (URL の ?source=phone でも指定できます)" };
  const urgencyRaw = String(pick(payload, ["urgency", "priority", "緊急度", "importance"]) ?? "").toLowerCase();
  const input: IntakeInput = {
    source,
    externalId: text(pick(payload, ["externalId", "external_id", "id", "callId", "call_id", "callSid", "sessionId", "session_id", "conversationId", "conversation_id", "ticketId", "ticket_id", "uuid", "受付ID", "受付番号"]), 120),
    receivedAt: toIso(pick(payload, ["receivedAt", "received_at", "startedAt", "started_at", "startTime", "start_time", "timestamp", "createdAt", "created_at", "datetime", "time", "受付日時"])),
    name: text(pick(payload, ["name", "customerName", "customer_name", "callerName", "caller_name", "fullName", "full_name", "contactName", "氏名", "お名前", "名前"]), 60),
    kana: text(pick(payload, ["kana", "furigana", "nameKana", "name_kana", "ふりがな", "フリガナ"]), 60),
    phone: text(pick(payload, ["phone", "tel", "phoneNumber", "phone_number", "callerNumber", "caller_number", "callerId", "caller_id", "from", "電話番号", "電話"]), 30),
    email: text(pick(payload, ["email", "mail", "emailAddress", "email_address", "メール", "メールアドレス"]), 120),
    postalCode: text(pick(payload, ["postalCode", "postal_code", "zip", "zipCode", "zip_code", "郵便番号"]), 10),
    address: text(pick(payload, ["address", "住所", "所在地", "siteAddress", "site_address"]), 200),
    summary: text(pick(payload, ["summary", "要約", "title", "subject", "件名", "headline"]), 2000),
    purpose: text(pick(payload, ["purpose", "intent", "用件", "requirement", "topic", "inquiryType", "inquiry_type", "相談内容"]), 500),
    detail: text(pick(payload, ["detail", "details", "message", "body", "content", "note", "notes", "memo", "詳細", "内容", "備考"]), 8000),
    transcript: transcriptOf(pick(payload, ["transcript", "transcription", "conversation", "messages", "log", "dialog", "会話", "会話記録", "通話記録"])),
    category: text(pick(payload, ["category", "service", "種別", "item", "product"]), 40),
    store: text(pick(payload, ["store", "storeId", "store_id", "storeName", "store_name", "branch", "shop", "店舗"]), 40),
    callbackPhone: text(pick(payload, ["callbackPhone", "callback_phone", "callbackNumber", "callback_number", "callback", "折返し先", "折り返し先"]), 30),
    desiredDate: text(pick(payload, ["desiredDate", "desired_date", "preferredDate", "preferred_date", "visitDate", "visit_date", "希望日", "希望日時"]), 60),
    urgency: /high|urgent|緊急|高|至急|^3$/.test(urgencyRaw) ? "high" : /low|低|^1$/.test(urgencyRaw) ? "low" : urgencyRaw ? "normal" : undefined,
    handoff: truthy(pick(payload, ["handoff", "needsHandoff", "needs_handoff", "handoffRequired", "handoff_required", "escalate", "escalation", "humanRequired", "human_required", "引き継ぎ", "要対応"])),
    handoffReason: text(pick(payload, ["handoffReason", "handoff_reason", "escalationReason", "escalation_reason", "reason", "引き継ぎ理由"]), 500),
    assignee: text(pick(payload, ["assignee", "assignTo", "assign_to", "staff", "staffEmail", "staff_email", "担当者"]), 120),
    recordingUrl: text(pick(payload, ["recordingUrl", "recording_url", "audioUrl", "audio_url", "recording", "録音"]), 500),
  };
  if (input.recordingUrl && !/^https:\/\//.test(input.recordingUrl)) input.recordingUrl = undefined;
  if (!input.summary && !input.purpose && !input.detail && !input.transcript) return { error: "summary・purpose・detail・transcript のいずれかが必要です" };
  return { input };
}

/* ================================================================== */
/* 登録                                                                 */
/* ================================================================== */

const digits = (v?: string) => (v ?? "").normalize("NFKC").replace(/[^0-9]/g, "");
const safeId = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

const CATEGORY_WORDS: [ServiceCategory, RegExp][] = [
  ["tatami", /畳|たたみ|タタミ|表替|裏返|新調/],
  ["fusuma", /襖|ふすま|フスマ/],
  ["shoji", /障子|しょうじ/],
  ["amido", /網戸|あみど|アミド/],
  ["curtain", /カーテン|ブラインド/],
  ["cloth", /クロス|壁紙/],
];

function categoryOf(input: IntakeInput): ServiceCategory {
  const raw = input.category ?? "";
  const direct = (Object.keys(CATEGORY_LABEL) as ServiceCategory[]).find((k) => k === raw || CATEGORY_LABEL[k] === raw);
  if (direct) return direct;
  const words = [raw, input.purpose, input.summary, input.detail].filter(Boolean).join(" ");
  return CATEGORY_WORDS.find(([, re]) => re.test(words))?.[0] ?? "other";
}

function findAssignee(db: Database, key: string | undefined): User | undefined {
  if (!key) return undefined;
  const k = key.trim().toLowerCase();
  return db.users.find((u) => u.active && (u.id === key || u.email.toLowerCase() === k || u.notifyEmail?.toLowerCase() === k || u.name.replace(/\s/g, "") === key.replace(/\s/g, "")));
}

/** 引き継ぎ先: 指定 → 設定 (店舗ごと) → 店長 */
export function handoffTarget(db: Database, storeId: StoreId, settings: AiIntakeSettings, requested?: string): User | undefined {
  const active = (id?: string) => db.users.find((u) => u.id === id && u.active);
  return findAssignee(db, requested) ?? active(settings.assignees[storeId]) ?? active(db.stores.find((s) => s.id === storeId)?.managerUserId) ?? active(settings.assignees[settings.defaultStore]) ?? active(db.stores.find((s) => s.id === settings.defaultStore)?.managerUserId);
}

export interface IntakeResult {
  created: boolean;
  duplicate?: boolean;
  inquiry: Inquiry;
  customerMatched: boolean;
  candidates: number;
  thread?: Thread;
}

/** 引き継ぎの業務依頼 (問い合わせにひも付く)。依頼者は店長 (引き継ぎ先が店長のときはシステム) */
export function createHandoffTask(db: Database, p: { inquiry: Inquiry; assignee: User; requestedBy: string; note: string; dueDate?: string; storeId: StoreId }): Thread {
  const now = nowIso();
  const id = newId("th");
  const t: Thread = {
    id,
    title: `引き継ぎ: ${p.inquiry.number} ${p.inquiry.summary}`.slice(0, 120),
    kind: "request",
    storeId: p.storeId,
    createdBy: p.requestedBy,
    participants: [...new Set([p.requestedBy, p.assignee.id].filter((x) => x !== SYSTEM_USER))],
    relatedType: "inquiry",
    relatedId: p.inquiry.id,
    relatedLabel: p.inquiry.number,
    status: "open",
    createdAt: now,
    updatedAt: now,
    assigneeIds: [p.assignee.id],
    dueDate: p.dueDate,
    taskStatus: "requested",
  };
  db.threads.push(t);
  db.messages.push({ id: newId("msg"), threadId: id, userId: p.requestedBy, body: p.note, at: now, mentions: [p.assignee.id] });
  addAudit(db, { userId: p.requestedBy, action: "create", entity: "thread", entityId: id, entityLabel: t.title, summary: `問い合わせ ${p.inquiry.number} を引き継ぎ (依頼先: ${p.assignee.name}${p.dueDate ? ` / 期限 ${p.dueDate}` : ""})`, storeId: p.storeId });
  return t;
}

export function recordAiIntake(db: Database, input: IntakeInput, settings = aiIntakeSettings(db)): IntakeResult {
  const label = CHANNEL_LABEL[input.source as Channel];
  const extId = input.externalId ? safeId(input.externalId) : "";
  const ref = `ai:${input.source}:${extId}`;
  if (extId) {
    const dup = db.inquiries.find((i) => i.sourceRef === ref);
    if (dup) return { created: false, duplicate: true, inquiry: dup, customerMatched: Boolean(dup.customerId), candidates: 0 };
  }
  // お客様の照合 (電話番号 9 桁以上・メール)
  const phone = digits(input.phone || input.callbackPhone);
  const email = input.email?.toLowerCase();
  const matches = db.customers.filter((c) => (phone.length >= 9 && digits(c.phone) === phone) || (email && c.email?.toLowerCase() === email));
  const customer = [...matches].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  const store = db.stores.find((s) => s.id === input.store || s.name === input.store || s.shortName === input.store || (input.store && s.name.includes(input.store)));
  const storeId: StoreId = store?.id ?? customer?.storeId ?? settings.defaultStore;
  const receivedAt = input.receivedAt ?? nowIso();
  const summary = (input.purpose || input.summary || input.detail || input.transcript || label).split(/\r?\n/)[0].slice(0, 60);
  const detail = [
    `[${label} から自動登録]`,
    input.purpose ? `用件: ${input.purpose}` : "",
    input.summary && input.summary !== input.purpose ? `要約: ${input.summary}` : "",
    input.detail ? `内容: ${input.detail}` : "",
    input.desiredDate ? `希望日: ${input.desiredDate}` : "",
    input.callbackPhone || input.phone ? `折返し先: ${input.callbackPhone || input.phone}` : "",
    input.email ? `メール: ${input.email}` : "",
    input.postalCode || input.address ? `住所: ${input.postalCode ? `〒${input.postalCode} ` : ""}${input.address ?? ""}` : "",
    input.urgency === "high" ? "緊急度: 高" : "",
    input.handoffReason ? `引き継ぎの理由: ${input.handoffReason}` : "",
    input.recordingUrl ? `録音: ${input.recordingUrl}` : "",
    matches.length > 1 ? `※ 電話番号・メールが一致するお客様が ${matches.length} 件あります。最近更新したお客様にひも付けました。違う場合は付け替えてください。` : "",
    extId ? `受付 ID: ${extId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const id = extId ? `inq_${input.source}_${extId}`.slice(0, 80) : newId("inq");
  const inquiry = buildInquiry(db, { id, channel: input.source, storeId, contactName: customer?.name ?? input.name ?? `${label}のお客様 (お名前未確認)`, contactPhone: input.callbackPhone || input.phone, customerId: customer?.id, category: categoryOf(input), summary, detail, receivedAt, sourceRef: extId ? ref : `ai:${input.source}` });
  // 期限は日本時間の受付日 (UTC の日付だと朝 9 時前の受付が前日になる)
  const dateKey = toDateKey(new Date(receivedAt));
  inquiry.nextAction = input.source === "ai_chat" ? "お客様へ返信・連絡" : "折返しの電話";
  inquiry.nextActionDue = dateKey;
  // 引き継ぎ
  const wantHandoff = settings.handoff === "always" || (settings.handoff === "requested" && (input.handoff === true || input.urgency === "high"));
  const assignee = wantHandoff ? handoffTarget(db, storeId, settings, input.assignee) : findAssignee(db, input.assignee);
  if (assignee) inquiry.assignedUserId = assignee.id;
  db.inquiries.push(inquiry);
  addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "inquiry", entityId: inquiry.id, entityLabel: inquiry.number, summary: `${label}から受付を登録 (${summary}${customer ? ` / 既存のお客様 ${customer.code}` : ""})`, storeId });
  // 会話の記録 (やりとり履歴)。お客様が分かっていればお客様の履歴にも出る
  const log: CommLog = {
    id: `cl_${inquiry.id}`.slice(0, 90),
    customerId: customer?.id,
    storeId,
    channel: input.source,
    direction: "inbound",
    subject: `${label}: ${summary}`.slice(0, 120),
    body: (input.transcript || [input.summary, input.detail].filter(Boolean).join("\n\n") || summary).slice(0, 20000),
    at: receivedAt,
    userId: SYSTEM_USER,
    relatedType: "inquiry",
    relatedId: inquiry.id,
    contactName: inquiry.contactName,
  };
  db.commLogs.push(log);
  let thread: Thread | undefined;
  if (wantHandoff && assignee) {
    const manager = db.users.find((u) => u.id === db.stores.find((s) => s.id === storeId)?.managerUserId && u.active);
    const requestedBy = manager && manager.id !== assignee.id ? manager.id : SYSTEM_USER;
    const note = [
      `${label}からの受付を引き継ぎます。内容を確認して、お客様へ${input.source === "ai_chat" ? "連絡" : "折返し"}してください。対応したら「報告」で結果を書いてください。`,
      "",
      detail,
      "",
      `問い合わせ: /inquiries/${inquiry.id}`,
    ].join("\n");
    thread = createHandoffTask(db, { inquiry, assignee, requestedBy, note: note.slice(0, 4000), dueDate: dateKey, storeId });
  }
  return { created: true, inquiry, customerMatched: Boolean(customer), candidates: matches.length, thread };
}
