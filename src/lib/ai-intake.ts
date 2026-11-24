import { createHash } from "node:crypto";
import type { Channel, CommLog, Database, Inquiry, InquiryIntake, ServiceCategory, StoreId, Thread, User } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { SYSTEM_USER, buildInquiry } from "@/lib/notify/inbound";
import { contactLabel, contactOfPhone, customerHasPhone } from "@/lib/customer-contacts";
import { mapMediaText, readMediaRules } from "@/lib/media";
import { areaStoreOf } from "@/lib/store-area";

/**
 * 既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) からの受付情報の取込
 * ------------------------------------------------------------
 * 既存の AI システムは作り直さず、それぞれの「受付が終わったときの送信 (Webhook)」をこのシステムの
 * POST /api/integrations/ai-intake に向ける。項目名はシステムごとに違うため、よく使われる名前を広く受け付ける。
 * 1. 同じ受付 ID は 1 件だけ登録する (再送されても重複しない)。受付 ID のないシステムは、同じ内容の再送 (6 時間以内) を 1 件にする
 * 2. 電話番号 (+81 の国際形式も国内の形にそろえる)・メールが一致するお客様にひも付ける
 *    (候補が複数なら最近更新したお客様。内容に候補の件数を書く。取引停止・名乗ったお名前の違い・家族の連絡先との一致も書く)
 * 3. 問い合わせ (入口: AI テキスト相談 / AI 音声相談 / AI 電話受付) と、会話の記録 (やりとり履歴) を登録する。
 *    受け取った項目 (お名前・ふりがな・メール・住所・希望日など) は Inquiry.intake に持ち、あとで「顧客として登録する」ときに使う。
 *    お客様があとで顧客にひも付いたら、会話の記録もそのお客様の履歴に移る (linkInquiryLogs)
 * 4. 引き継ぎ: 担当者 (指定 → 店舗ごとの既定 → 店長 → 既定の店舗 → 管理者) に「業務依頼」を作る。依頼 → 確認 → 報告 → 完了で進める。
 *    依頼の文はシステム (外部連携) の名前で書き、依頼者は店長 (店長が引き継ぎ先のときはシステム = 引き継ぎ先が自分で完了にできる)
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
  /** 当社を知ったきっかけ (対応表で媒体に読み替える) */
  mediaText?: string;
  /** 電話番号の項目に届いた、電話番号ではない値 (チャットの利用者 ID など) */
  senderId?: string;
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

/**
 * 電話番号を国内の形にそろえる: +81 90-1234-5678・0081…・819012345678 → 090-1234-5678。
 * 電話番号らしくない値 (英字を含むチャットの利用者 ID・桁数が合わない値) は undefined
 */
export function domesticPhone(v?: string): string | undefined {
  if (!v) return undefined;
  const raw = v.normalize("NFKC").trim().replace(/^tel:/i, "");
  if (!raw || /[A-Za-z@]/.test(raw.replace(/(ext|内線).*$/i, ""))) return undefined;
  let d = raw.replace(/[^0-9]/g, "");
  const intl = /^\s*(\+|00)\s*81/.test(raw) || (/^81[1-9]\d{8,9}$/.test(d) && !raw.trim().startsWith("0"));
  if (intl) {
    d = d.replace(/^(00)?81/, "");
    if (!d.startsWith("0")) d = `0${d}`;
  }
  if (d.length < 9 || d.length > 13) return undefined;
  if (!intl) return raw;
  return /^0[5789]0\d{8}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d;
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
  const phoneRaw = text(pick(payload, ["phone", "tel", "phoneNumber", "phone_number", "callerNumber", "caller_number", "callerId", "caller_id", "from", "電話番号", "電話"]), 60);
  const callbackRaw = text(pick(payload, ["callbackPhone", "callback_phone", "callbackNumber", "callback_number", "callback", "折返し先", "折り返し先"]), 60);
  const input: IntakeInput = {
    source,
    externalId: text(pick(payload, ["externalId", "external_id", "id", "callId", "call_id", "callSid", "sessionId", "session_id", "conversationId", "conversation_id", "ticketId", "ticket_id", "uuid", "受付ID", "受付番号"]), 120),
    receivedAt: toIso(pick(payload, ["receivedAt", "received_at", "startedAt", "started_at", "startTime", "start_time", "timestamp", "createdAt", "created_at", "datetime", "time", "受付日時"])),
    name: text(pick(payload, ["name", "customerName", "customer_name", "callerName", "caller_name", "fullName", "full_name", "contactName", "氏名", "お名前", "名前"]), 60),
    kana: text(pick(payload, ["kana", "furigana", "nameKana", "name_kana", "ふりがな", "フリガナ"]), 60),
    phone: domesticPhone(phoneRaw),
    email: text(pick(payload, ["email", "mail", "emailAddress", "email_address", "メール", "メールアドレス"]), 120),
    postalCode: text(pick(payload, ["postalCode", "postal_code", "zip", "zipCode", "zip_code", "郵便番号"]), 10),
    address: text(pick(payload, ["address", "住所", "所在地", "siteAddress", "site_address"]), 200),
    summary: text(pick(payload, ["summary", "要約", "title", "subject", "件名", "headline"]), 2000),
    purpose: text(pick(payload, ["purpose", "intent", "用件", "requirement", "topic", "inquiryType", "inquiry_type", "相談内容"]), 500),
    detail: text(pick(payload, ["detail", "details", "message", "body", "content", "note", "notes", "memo", "詳細", "内容", "備考"]), 8000),
    transcript: transcriptOf(pick(payload, ["transcript", "transcription", "conversation", "messages", "log", "dialog", "会話", "会話記録", "通話記録"])),
    category: text(pick(payload, ["category", "service", "種別", "item", "product"]), 40),
    store: text(pick(payload, ["store", "storeId", "store_id", "storeName", "store_name", "branch", "shop", "店舗"]), 40),
    callbackPhone: domesticPhone(callbackRaw),
    desiredDate: text(pick(payload, ["desiredDate", "desired_date", "preferredDate", "preferred_date", "visitDate", "visit_date", "希望日", "希望日時"]), 60),
    urgency: /high|urgent|緊急|高|至急|^3$/.test(urgencyRaw) ? "high" : /low|低|^1$/.test(urgencyRaw) ? "low" : urgencyRaw ? "normal" : undefined,
    handoff: truthy(pick(payload, ["handoff", "needsHandoff", "needs_handoff", "handoffRequired", "handoff_required", "escalate", "escalation", "humanRequired", "human_required", "引き継ぎ", "要対応"])),
    handoffReason: text(pick(payload, ["handoffReason", "handoff_reason", "escalationReason", "escalation_reason", "reason", "引き継ぎ理由"]), 500),
    assignee: text(pick(payload, ["assignee", "assignTo", "assign_to", "staff", "staffEmail", "staff_email", "担当者"]), 120),
    recordingUrl: text(pick(payload, ["recordingUrl", "recording_url", "audioUrl", "audio_url", "recording", "録音"]), 500),
    mediaText: text(pick(payload, ["media", "mediaSource", "media_source", "howDidYouHear", "how_did_you_hear", "howFound", "referralSource", "referral_source", "leadSource", "lead_source", "媒体", "きっかけ", "知ったきっかけ", "当社を知ったきっかけ"]), 60),
    senderId: phoneRaw && !domesticPhone(phoneRaw) ? phoneRaw.slice(0, 60) : undefined,
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

/** 引き継ぎ先: 指定 → 設定 (店舗ごと) → 店長 → 既定の店舗の設定・店長 → 管理者 (どこにも設定がないときに受付が埋もれないように) */
export function handoffTarget(db: Database, storeId: StoreId, settings: AiIntakeSettings, requested?: string): User | undefined {
  const active = (id?: string) => db.users.find((u) => u.id === id && u.active);
  return (
    findAssignee(db, requested) ??
    active(settings.assignees[storeId]) ??
    active(db.stores.find((s) => s.id === storeId)?.managerUserId) ??
    active(settings.assignees[settings.defaultStore]) ??
    active(db.stores.find((s) => s.id === settings.defaultStore)?.managerUserId) ??
    db.users.filter((u) => u.active && u.role === "admin").sort((a, b) => a.id.localeCompare(b.id))[0]
  );
}

export interface IntakeResult {
  created: boolean;
  duplicate?: boolean;
  inquiry: Inquiry;
  customerMatched: boolean;
  candidates: number;
  thread?: Thread;
}

/**
 * 引き継ぎの業務依頼 (問い合わせにひも付く)。依頼者 requestedBy が「報告の確認 (完了)」を行う。
 * authorId は依頼の文と変更履歴の記録者 (AI 受付はシステム。省略時は依頼者)
 */
export function createHandoffTask(db: Database, p: { inquiry: Inquiry; assignee: User; requestedBy: string; note: string; dueDate?: string; storeId: StoreId; authorId?: string; urgent?: boolean }): Thread {
  const now = nowIso();
  const id = newId("th");
  const author = p.authorId ?? p.requestedBy;
  const t: Thread = {
    id,
    title: `${p.urgent ? "【至急】" : ""}引き継ぎ: ${p.inquiry.number} ${p.inquiry.summary}`.slice(0, 120),
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
  db.messages.push({ id: newId("msg"), threadId: id, userId: author, body: p.note, at: now, mentions: [p.assignee.id] });
  addAudit(db, { userId: author, action: "create", entity: "thread", entityId: id, entityLabel: t.title, summary: `問い合わせ ${p.inquiry.number} を引き継ぎ (依頼先: ${p.assignee.name}${p.dueDate ? ` / 期限 ${p.dueDate}` : ""})`, storeId: p.storeId });
  return t;
}

/** 同じ受付の再送を見分ける印 (受付 ID のないシステム用): 入口・電話・メール・内容・受付日時 */
export function intakeFingerprint(input: IntakeInput): string {
  const parts = [input.source, digits(input.phone || input.callbackPhone), (input.email ?? "").toLowerCase(), input.summary, input.purpose, input.detail, input.transcript, input.receivedAt];
  return createHash("sha256").update(parts.map((x) => x ?? "").join("\u0001")).digest("hex").slice(0, 16);
}

/** 受付 ID のない再送を同じ受付とみなす時間 (受付日時が届くシステムは日時も印に入るため時間で区切らない) */
const RESEND_WINDOW_MS = 6 * 60 * 60 * 1000;

const normName = (v?: string) => (v ?? "").normalize("NFKC").replace(/[\s　]/g, "").replace(/様$/, "");

export function recordAiIntake(db: Database, input: IntakeInput, settings = aiIntakeSettings(db)): IntakeResult {
  const label = CHANNEL_LABEL[input.source as Channel];
  const extId = input.externalId ? safeId(input.externalId) : "";
  const ref = extId ? `ai:${input.source}:${extId}` : `ai:${input.source}:h${intakeFingerprint(input)}`;
  const dup = db.inquiries.find((i) => i.sourceRef === ref && (extId || input.receivedAt || Date.now() - Date.parse(i.receivedAt) < RESEND_WINDOW_MS));
  if (dup) return { created: false, duplicate: true, inquiry: dup, customerMatched: Boolean(dup.customerId), candidates: 0 };
  // お客様の照合 (電話番号 9 桁以上 (主の番号とご家族などの連絡先)・メール)
  const phones = [...new Set([digits(input.phone), digits(input.callbackPhone)].filter((d) => d.length >= 9))];
  const email = input.email?.toLowerCase();
  const matches = db.customers.filter((c) => phones.some((d) => customerHasPhone(c, d)) || (email && c.email?.toLowerCase() === email));
  const customer = [...matches].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  const store = db.stores.find((s) => s.id === input.store || s.name === input.store || s.shortName === input.store || (input.store && s.name.includes(input.store)));
  // 担当店舗: 指定の店舗 > 住所の担当エリア (お客様のご要望 2026-11-24「③」。src/lib/store-area.ts) > お客様の店舗 > 既定の店舗
  const storeId: StoreId = store?.id ?? areaStoreOf(db, input.address || customer?.address)?.storeId ?? customer?.storeId ?? settings.defaultStore;
  const receivedAt = input.receivedAt ?? nowIso();
  const summary = (input.purpose || input.summary || input.detail || input.transcript || label).split(/\r?\n/)[0].slice(0, 60);
  const media = input.mediaText ? mapMediaText(readMediaRules(db).rules, input.mediaText) : null;
  const viaContact = customer ? phones.map((d) => contactOfPhone(customer, d)).find(Boolean) : undefined;
  const otherName = customer && input.name && normName(input.name) !== normName(customer.name) ? input.name : undefined;
  // 引き継ぎ (先に決めて、見つからないときは内容に書く)
  const wantHandoff = settings.handoff === "always" || (settings.handoff === "requested" && (input.handoff === true || input.urgency === "high"));
  const assignee = wantHandoff ? handoffTarget(db, storeId, settings, input.assignee) : findAssignee(db, input.assignee);
  const detail = [
    `[${label} から自動登録]`,
    input.purpose ? `用件: ${input.purpose}` : "",
    input.summary && input.summary !== input.purpose ? `要約: ${input.summary}` : "",
    input.detail ? `内容: ${input.detail}` : "",
    input.desiredDate ? `希望日: ${input.desiredDate}` : "",
    input.callbackPhone || input.phone ? `折返し先: ${input.callbackPhone || input.phone}` : "",
    input.email ? `メール: ${input.email}` : "",
    input.postalCode || input.address ? `住所: ${input.postalCode ? `〒${input.postalCode} ` : ""}${input.address ?? ""}` : "",
    input.kana ? `ふりがな: ${input.kana}` : "",
    otherName ? `名乗ったお名前: ${otherName} (登録のお客様 ${customer!.name} 様にひも付けました)` : "",
    viaContact ? `※ 電話番号はお客様の連絡先「${contactLabel(viaContact) || viaContact.phone}」と一致しました。` : "",
    input.mediaText ? `当社を知ったきっかけ: ${input.mediaText}${media ? "" : " (媒体の分類に読み替えられませんでした。確かめて選んでください)"}` : "",
    input.urgency === "high" ? "緊急度: 高" : "",
    input.handoffReason ? `引き継ぎの理由: ${input.handoffReason}` : "",
    input.recordingUrl ? `録音: ${input.recordingUrl}` : "",
    input.senderId ? `送信元 ID: ${input.senderId}` : "",
    customer?.tradeStopped ? "※ 取引停止のお客様です。対応の前に店長に確かめてください。" : "",
    matches.length > 1 ? `※ 電話番号・メールが一致するお客様が ${matches.length} 件あります。最近更新したお客様にひも付けました。違う場合は付け替えてください。` : "",
    wantHandoff && !assignee ? "※ 引き継ぎ先の社員が見つかりませんでした (設定 → 外部連携・AI で引き継ぎ先を設定してください)。" : "",
    extId ? `受付 ID: ${extId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const id = extId ? `inq_${input.source}_${extId}`.slice(0, 80) : newId("inq");
  const inquiry = buildInquiry(db, { id, channel: input.source, storeId, contactName: customer?.name ?? input.name ?? `${label}のお客様 (お名前未確認)`, contactPhone: input.callbackPhone || input.phone, customerId: customer?.id, category: categoryOf(input), summary, detail, receivedAt, sourceRef: ref });
  const intake: InquiryIntake = {
    name: input.name,
    kana: input.kana,
    phone: input.phone,
    callbackPhone: input.callbackPhone,
    email: input.email,
    postalCode: input.postalCode,
    address: input.address,
    desiredDate: input.desiredDate,
    urgency: input.urgency,
    handoffRequested: input.handoff,
    handoffReason: input.handoffReason,
    recordingUrl: input.recordingUrl,
    externalId: extId || undefined,
    mediaText: input.mediaText,
    senderId: input.senderId,
    matchedCount: matches.length || undefined,
  };
  inquiry.intake = Object.fromEntries(Object.entries(intake).filter(([, v]) => v !== undefined && v !== "")) as InquiryIntake;
  if (media) inquiry.media = media;
  // 期限は日本時間の受付日 (UTC の日付だと朝 9 時前の受付が前日になる)
  const dateKey = toDateKey(new Date(receivedAt));
  inquiry.nextAction = `${input.urgency === "high" ? "至急: " : ""}${input.source === "ai_chat" ? "お客様へ返信・連絡" : "折返しの電話"}`;
  inquiry.nextActionDue = dateKey;
  if (assignee) inquiry.assignedUserId = assignee.id;
  db.inquiries.push(inquiry);
  addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "inquiry", entityId: inquiry.id, entityLabel: inquiry.number, summary: `${label}から受付を登録 (${summary}${customer ? ` / 既存のお客様 ${customer.code}` : ""})`, storeId });
  // 会話の記録 (やりとり履歴)。お客様が分かっていればお客様の履歴にも出る (あとでひも付けたときも移る)
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
    contactName: input.name ?? inquiry.contactName,
  };
  db.commLogs.push(log);
  let thread: Thread | undefined;
  if (wantHandoff && assignee) {
    // 依頼者 = 店長 (報告を確認して完了にする人)。店長が引き継ぎ先のときはシステム (引き継ぎ先が自分で完了にできる。permissions.ts の canConfirmTask)
    const manager = db.users.find((u) => u.id === db.stores.find((s) => s.id === storeId)?.managerUserId && u.active);
    const requestedBy = manager && manager.id !== assignee.id ? manager.id : SYSTEM_USER;
    const note = [
      `${input.urgency === "high" ? "【至急】" : ""}${label}からの受付を引き継ぎます (自動の依頼)。内容を確認して、お客様へ${input.source === "ai_chat" ? "連絡" : "折返し"}してください。対応したら「報告」で結果を書いてください。`,
      "",
      detail,
      "",
      `問い合わせ: /inquiries/${inquiry.id}`,
    ].join("\n");
    thread = createHandoffTask(db, { inquiry, assignee, requestedBy, note: note.slice(0, 4000), dueDate: dateKey, storeId, authorId: SYSTEM_USER, urgent: input.urgency === "high" });
  }
  return { created: true, inquiry, customerMatched: Boolean(customer), candidates: matches.length, thread };
}

/**
 * 問い合わせのやりとり履歴 (AI 受付の会話の記録・顧客の登録前に残した記録) を、ひも付けたお客様の履歴に移す
 * (問い合わせの「既存の顧客に紐づける」「顧客として登録する」)。
 * 問い合わせの記録が 1 件もなければ、問い合わせの内容を 1 件残す (AI 受付は会話の記録があるので重ねない)。移した件数を返す
 */
export function linkInquiryLogs(db: Database, inq: Inquiry, customerId: string): number {
  const logs = db.commLogs.filter((c) => c.relatedType === "inquiry" && c.relatedId === inq.id);
  let moved = 0;
  for (const c of logs) {
    if (c.customerId) continue;
    c.customerId = customerId;
    moved++;
  }
  if (!logs.length) db.commLogs.push({ id: newId("cl"), customerId, storeId: inq.storeId, channel: inq.channel, direction: "inbound", subject: inq.summary, body: inq.detail || inq.summary, at: inq.receivedAt, userId: inq.createdBy, relatedType: "inquiry", relatedId: inq.id, contactName: inq.contactName });
  return moved;
}
