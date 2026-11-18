import "server-only";
import type { Database, FaxEvent, FaxMessage, StoreId } from "@/lib/db/types";
import { addAudit, getDb, mutate, newId, nextNumber, nowIso, syncDb } from "@/lib/db/store";
import { putObject, readObject, removeObjects } from "@/lib/storage";
import { toDateKey } from "@/lib/format";
import { analyzeFax } from "./ai";
import { fmtFax, matchSender, normFax, normRef } from "./numbers";
import { faxLocalDigits } from "./adapter";

/**
 * 受信 FAX の取り込み
 * ------------------------------------------------------------
 * 1. 保存: PDF を VPS のディスクへ (fax/in/年/月/ID.pdf)。同じ FAX サービスの ID (providerRef) は 1 回だけ登録する
 * 2. 仕分け: 送信元の番号で判別 (numbers.ts の matchSender)
 *    - 不要な番号の台帳にある → 不要 (junk。通常の一覧から外す。削除はしない)
 *    - 仕入先・顧客の番号 → 登録済みの番号 (auto。業務の一覧に入る)
 *    - それ以外 → 要確認 (review。担当者が「取り込む」「不要」を選ぶ)
 * 3. AI 判定と番号の読み取り (保存のあと。analyzeAndLink)
 *    - 発注番号が 1 件だけ一致 → その発注書・案件・仕入先・担当者 (発注した人) にひも付け
 *    - 複数一致・送信元の仕入先と違う → ひも付けず、画面で候補から選ぶ
 *    - 案件番号が一致 → 案件にひも付け
 *    AI の判定 (広告など) だけで仕分けを変えない
 */

export const MAX_FAX_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

export class FaxError extends Error {}

export function faxEvent(kind: FaxEvent["kind"], note: string, extra: Partial<FaxEvent> = {}): FaxEvent {
  return { at: nowIso(), kind, note, ...extra };
}

/** 中身から種類を確かめる (拡張子・申告の種類は信用しない) */
export function sniffType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
}

export interface IncomingFax {
  /** mock・upload・FAX サービスの名前 */
  provider: string;
  providerId?: string;
  from: string;
  to?: string;
  receivedAt: string;
  pages?: number;
  bytes: Buffer;
  fileName?: string;
  /** 模擬の受信だけ: 書類の文字 */
  text?: string;
  /** 登録した人 (FAX サービスからは system) */
  userId: string;
  /** 画面から登録したときの担当者・店舗 */
  assignedUserId?: string;
  storeId?: StoreId;
  note?: string;
}

/** 受信 FAX を登録する。同じ FAX サービスの ID は 2 回目以降、最初の登録を返す (created = false) */
export async function receiveFax(input: IncomingFax): Promise<{ fax: FaxMessage; created: boolean }> {
  const providerRef = input.providerId ? `${input.provider}:${input.providerId}` : undefined;
  await syncDb();
  const existing = providerRef ? getDb().faxMessages.find((f) => f.providerRef === providerRef) : undefined;
  if (existing) return { fax: existing, created: false };
  if (!input.bytes.length) throw new FaxError("FAX のファイルが空です。");
  if (input.bytes.length > MAX_FAX_BYTES) throw new FaxError("FAX のファイルが大きすぎます (20 MB まで)。");
  const contentType = sniffType(input.bytes);
  if (!contentType) throw new FaxError("PDF・JPEG・PNG のファイルを登録してください。");
  const id = newId("fax");
  const at = Number.isNaN(Date.parse(input.receivedAt)) ? nowIso() : new Date(input.receivedAt).toISOString();
  const day = toDateKey(new Date(at));
  const fileKey = `fax/in/${day.slice(0, 4)}/${day.slice(5, 7)}/${id}.${TYPES[contentType]}`;
  await putObject(fileKey, input.bytes);
  try {
    const r = await mutate((db) => {
      const dup = providerRef ? db.faxMessages.find((f) => f.providerRef === providerRef) : undefined;
      if (dup) return { fax: dup, created: false };
      const remote = normFax(input.from);
      const m = matchSender(db, remote);
      const triage = m.kind === "blocked" ? "junk" : m.kind === "supplier" || m.kind === "customer" ? "auto" : "review";
      const customer = m.kind === "customer" ? db.customers.find((c) => c.id === m.customerId) : undefined;
      const note =
        m.kind === "blocked" ? `不要な番号 (${m.label}) からの FAX のため「不要」に仕分けました`
        : m.kind === "supplier" ? `仕入先「${m.label}」の番号からの FAX です`
        : m.kind === "customer" ? `顧客「${m.label}」の番号からの FAX です`
        : m.kind === "ambiguous" ? `${m.label}があるため、要確認にしました`
        : remote ? "未登録の番号からの FAX のため、要確認にしました" : "送信元の番号が分からないため、要確認にしました";
      const fax: FaxMessage = {
        id,
        number: nextNumber(db, "FX", db.faxMessages, toDateKey(new Date())),
        direction: "inbound",
        status: "received",
        triage,
        remoteNumber: remote,
        remoteName: m.kind === "supplier" || m.kind === "customer" ? m.label : undefined,
        localNumber: normFax(input.to) || faxLocalDigits() || undefined,
        at,
        pages: input.pages,
        fileKey,
        fileName: input.fileName?.slice(0, 120) || `受信FAX_${day}.${TYPES[contentType]}`,
        size: input.bytes.length,
        contentType,
        provider: input.provider,
        providerId: input.providerId,
        providerRef,
        supplierId: m.kind === "supplier" ? m.supplierId : undefined,
        customerId: customer?.id,
        orderIds: [],
        storeId: input.storeId ?? customer?.storeId ?? "hq",
        assignedUserId: input.assignedUserId,
        userId: input.userId,
        aiPending: triage !== "junk",
        attempts: 0,
        events: [faxEvent("received", input.note ? `${note} (${input.note})` : note, { status: "received", userId: input.userId })],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      // 模擬の受信の文字は AI の判定まで控えておく (保存はしない)
      db.faxMessages.push(fax);
      addAudit(db, { userId: input.userId, action: "create", entity: "fax", entityId: fax.id, entityLabel: fax.number, summary: `FAX を受信 (${fmtFax(remote) || "番号不明"}・${triageLabel(triage)})`, storeId: fax.storeId });
      return { fax, created: true };
    });
    if (!r.created) await removeObjects([fileKey]);
    else if (input.text) pendingText.set(r.fax.id, input.text);
    return r;
  } catch (err) {
    await removeObjects([fileKey]).catch(() => undefined);
    throw err;
  }
}

/** 模擬の受信の文字 (AI のキーがない検証環境で、番号の読み取りに使う。サーバーのメモリにだけ持つ) */
const g = globalThis as unknown as { __ichijoyaFaxText?: Map<string, string> };
const pendingText = (g.__ichijoyaFaxText ??= new Map());

function triageLabel(t: FaxMessage["triage"]): string {
  return t === "junk" ? "不要" : t === "auto" ? "登録済みの番号" : t === "accepted" ? "取り込み済み" : "要確認";
}

/** AI の判定の失敗を何回まで定期実行で読み直すか */
const MAX_AI_TRIES = 3;

/**
 * AI で判定し、読み取った番号で発注書・案件にひも付ける。
 * 受信の直後 (Webhook の応答のあと・画面からの登録) と、定期実行 (判定待ちの読み直し)、画面の「AI で読み直す」から呼ぶ
 */
export async function analyzeAndLink(faxId: string, userId = "system"): Promise<FaxMessage | undefined> {
  await syncDb();
  const f = getDb().faxMessages.find((x) => x.id === faxId);
  if (!f || f.direction !== "inbound" || !f.fileKey) return f;
  const bytes = await readObject(f.fileKey);
  if (!bytes) {
    return mutate((db) => {
      const x = db.faxMessages.find((y) => y.id === faxId);
      if (!x) return undefined;
      x.aiPending = false;
      x.events.push(faxEvent("error", "FAX のファイルが見つからないため、AI で判定できませんでした"));
      x.updatedAt = nowIso();
      return x;
    });
  }
  const ai = await analyzeFax({ bytes, contentType: f.contentType, fileName: f.fileName, text: pendingText.get(faxId), sender: fmtFax(f.remoteNumber) || undefined });
  pendingText.delete(faxId);
  return mutate((db) => {
    const x = db.faxMessages.find((y) => y.id === faxId);
    if (!x) return undefined;
    x.ai = ai;
    const tries = x.events.filter((e) => e.kind === "ai").length + 1;
    x.aiPending = Boolean(ai.error) && tries < MAX_AI_TRIES;
    x.events.push(
      faxEvent(
        "ai",
        ai.error
          ? `AI の判定に失敗しました (${ai.error})${x.aiPending ? "。時間をおいて読み直します" : ""}`
          : `AI の判定: ${ai.label === "business" ? "業務関連" : ai.label === "ad" ? "広告・営業" : "判定不能"} (信頼度 ${Math.round(ai.confidence * 100)}%)${ai.poNumbers.length ? ` · 発注番号 ${ai.poNumbers.join("・")}` : ""}${ai.orderNumbers.length ? ` · 案件番号 ${ai.orderNumbers.join("・")}` : ""}`,
        { userId },
      ),
    );
    // 画面から登録して番号がない FAX は、書類に書かれた FAX 番号で送信元を判別する (不要の番号でも自動では不要にしない)
    if (!x.remoteNumber && ai.senderFax) {
      x.remoteNumber = ai.senderFax;
      const m = matchSender(db, ai.senderFax);
      if (m.kind === "supplier" && !x.supplierId) {
        x.supplierId = m.supplierId;
        x.remoteName = m.label;
        if (x.triage === "review") x.triage = "auto";
        x.events.push(faxEvent("link", `書類の FAX 番号 ${fmtFax(ai.senderFax)} から、仕入先「${m.label}」と判別しました`));
      }
    }
    if (!x.remoteName && ai.senderName) x.remoteName = ai.senderName;
    autoLink(db, x);
    x.updatedAt = nowIso();
    addAudit(db, { userId, action: "update", entity: "fax", entityId: x.id, entityLabel: x.number, summary: `FAX を AI で判定 (${ai.error ? "失敗" : ai.label})`, storeId: x.storeId });
    return x;
  });
}

/** 読み取った発注番号・案件番号でひも付ける (すでに発注書にひも付いた FAX は変えない) */
export function autoLink(db: Database, x: FaxMessage): void {
  if (x.purchaseOrderId || !x.ai) return;
  const wanted = new Set(x.ai.poNumbers.map(normRef));
  const pos = db.purchaseOrders.filter((p) => wanted.has(p.number) && p.status !== "cancelled");
  if (pos.length === 1) {
    const po = pos[0];
    if (x.supplierId && x.supplierId !== po.supplierId) {
      x.events.push(faxEvent("link", `発注番号 ${po.number} を読み取りましたが、送信元の仕入先と発注書の仕入先が違うため、ひも付けていません (候補から選んでください)`));
    } else {
      x.purchaseOrderId = po.id;
      x.supplierId = po.supplierId;
      x.remoteName ??= db.suppliers.find((s) => s.id === po.supplierId)?.name;
      x.orderIds = [...new Set([...x.orderIds, ...po.orderIds])];
      x.storeId = po.storeId;
      x.assignedUserId ??= po.createdBy;
      x.events.push(faxEvent("link", `発注番号 ${po.number} を読み取り、発注書にひも付けました`));
    }
  } else if (pos.length > 1) {
    x.events.push(faxEvent("link", `一致する発注書が ${pos.length} 件あるため、ひも付けていません (候補から選んでください)`));
  }
  const nums = new Set(x.ai.orderNumbers.map(normRef));
  if (nums.size) {
    const orders = db.orders.filter((o) => nums.has(normRef(o.number)));
    const added = orders.filter((o) => !x.orderIds.includes(o.id));
    if (added.length) {
      x.orderIds = [...x.orderIds, ...added.map((o) => o.id)];
      if (!x.purchaseOrderId && !x.customerId && x.storeId === "hq") x.storeId = added[0].storeId;
      x.events.push(faxEvent("link", `案件番号 ${added.map((o) => o.number).join("・")} を読み取り、案件にひも付けました`));
    }
  }
}
