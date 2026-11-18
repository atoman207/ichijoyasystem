import "server-only";
import type { Database, FaxMessage, PurchaseOrder, User } from "@/lib/db/types";
import { addAudit, getDb, mutate, newId, nextNumber, nowIso, syncDb } from "@/lib/db/store";
import { putObject, readObject, removeObjects } from "@/lib/storage";
import { toDateKey } from "@/lib/format";
import { canEditPurchaseOrder } from "@/lib/auth/permissions";
import { renderPurchaseOrderPdf } from "@/lib/pdf/render";
import { poFileName, purchaseOrderPdfData } from "@/lib/purchase-orders";
import { faxConnection, faxLocalDigits, type FaxSendOutcome } from "./adapter";
import { fmtFax, isValidFax, normFax } from "./numbers";
import { FaxError, faxEvent } from "./inbound";

/**
 * FAX の送信 (発注書)
 * ------------------------------------------------------------
 * 1. 送信の受付: 発注書の PDF をその時点の内容で作って保存し (fax/out/年/月/ID.pdf)、FAX の記録を「受付済み」で作る
 *    - 二重送信の防止: 画面の 1 回の操作ごとのキー (idempotencyKey) は 1 回だけ。同じ発注書の送信が処理中のときは断る。
 *      送信済みの版をもう一度送るのは「再送する」を選んだときだけ
 * 2. FAX サービスへ依頼 (adapter.send)
 *    - 受け付けた → 処理中 (状態は通知 (Webhook) か問い合わせ (定期実行・画面の「状態を更新」) で 成功 / 失敗 にする)
 *    - サービスに届く前の通信エラー → 失敗 + 自動の再送の予定 (1 分 → 5 分 → 15 分。3 回まで)
 *    - 依頼のあとに通信が切れた → 要確認 (二重に届くのを避けるため自動では再送しない。担当者が確かめて再送する)
 *    - 番号の誤りなど → 失敗 (再送しない。理由を表示)
 * 3. 成功したら発注書を「送信済み」にし、送信の記録を発注書・仕入先・明細の全案件にひも付ける (FaxMessage の各 ID)
 */

export const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAYS_MIN = [1, 5, 15];
/** 依頼を出したまま結果が分からない送信を「要確認」にするまでの時間 */
const STALE_SUBMIT_MS = 10 * 60 * 1000;
/** 処理中の送信の状態を問い合わせる間隔 */
const POLL_MS = 20 * 1000;

const IN_FLIGHT: FaxMessage["status"][] = ["queued", "sending"];

export interface SendInput {
  /** 送信先の FAX 番号 (画面で確認した番号) */
  to: string;
  /** 画面の 1 回の操作ごとのキー */
  key: string;
  /** 送信済みの版をもう一度送る */
  resend: boolean;
}

function checkSendable(db: Database, user: User, po: PurchaseOrder | undefined, input: SendInput): { po: PurchaseOrder; to: string; existing?: FaxMessage } {
  if (!po) throw new FaxError("発注書が見つかりません。");
  if (!canEditPurchaseOrder(user, po)) throw new FaxError("この発注書を送信する権限がありません。");
  const existing = input.key ? db.faxMessages.find((f) => f.idempotencyKey === input.key) : undefined;
  if (existing) return { po, to: existing.remoteNumber, existing };
  if (po.status === "cancelled") throw new FaxError("取り消した発注書は送信できません。");
  if (po.status === "completed") throw new FaxError("完了した発注書は送信できません。");
  if (!po.lines.length) throw new FaxError("明細のない発注書は送信できません。");
  const to = normFax(input.to);
  if (!isValidFax(to)) throw new FaxError("送信先の FAX 番号を確認してください (0 から始まる 10〜11 桁)。");
  if (to === faxLocalDigits()) throw new FaxError("自社の FAX 番号には送信できません。");
  const mine = db.faxMessages.filter((f) => f.direction === "outbound" && f.purchaseOrderId === po.id);
  const busy = mine.find((f) => IN_FLIGHT.includes(f.status));
  if (busy) throw new FaxError(`この発注書の送信 (${busy.number}) を処理中です。結果が出るまでお待ちください。`);
  const unknown = mine.find((f) => f.status === "unknown" && f.poVersion === po.version);
  if (unknown && !input.resend) throw new FaxError(`前回の送信 (${unknown.number}) が届いたか確認中です。FAX サービスで届いていないことを確かめてから「再送する」を選んでください。`);
  const done = mine.find((f) => (f.status === "sent" || f.status === "manual") && f.poVersion === po.version);
  if (done && !input.resend) throw new FaxError(`この版はすでに送信しています (${done.number})。もう一度送るときは「同じ内容を再送する」を選んでください。`);
  return { po, to };
}

/** 同じ発注書のほかの送信の自動の再送を止める (訂正・再送・取消のあとに古い内容が送られないように) */
export function stopPendingRetries(db: Database, poId: string, reason: string, exceptId?: string): number {
  let n = 0;
  for (const x of db.faxMessages) {
    if (x.id === exceptId || x.direction !== "outbound" || x.purchaseOrderId !== poId || x.status !== "failed" || !x.nextRetryAt) continue;
    x.nextRetryAt = undefined;
    x.events.push(faxEvent("status", `${reason}ため、自動の再送を止めました`, { status: "failed" }));
    x.updatedAt = nowIso();
    n += 1;
  }
  return n;
}

/** 発注書を FAX で送る。戻り値は送信の記録 (同じ操作キーの 2 回目は最初の記録を返す) */
export async function sendPurchaseOrderFax(user: User, poId: string, input: SendInput): Promise<FaxMessage> {
  const conn = faxConnection();
  if (conn.mode !== "mock" && conn.mode !== "live") throw new FaxError(conn.mode === "off" ? "FAX サービスが未接続のため送信できません。PDF を印刷して FAX 機で送り、「FAX 機で送信した」を記録してください。" : conn.detail);
  await syncDb();
  const pre = checkSendable(getDb(), user, getDb().purchaseOrders.find((p) => p.id === poId), input);
  if (pre.existing) return pre.existing;

  // 送る PDF は、この時点の内容で作って保存する (あとで発注書を直しても、送った内容が残る)
  const id = newId("fax");
  const issuedPo: PurchaseOrder = { ...pre.po, status: pre.po.status === "draft" ? "issued" : pre.po.status };
  const bytes = Buffer.from(await renderPurchaseOrderPdf(purchaseOrderPdfData(getDb(), issuedPo)));
  const day = toDateKey(new Date());
  const fileKey = `fax/out/${day.slice(0, 4)}/${day.slice(5, 7)}/${id}.pdf`;
  await putObject(fileKey, bytes);

  let fax: FaxMessage;
  try {
    fax = await mutate((db) => {
      const po = db.purchaseOrders.find((p) => p.id === poId);
      const c = checkSendable(db, user, po, input);
      if (c.existing) return c.existing;
      const supplier = db.suppliers.find((s) => s.id === c.po.supplierId);
      if (c.po.status === "draft") {
        c.po.status = "issued";
        c.po.issuedAt = nowIso();
      }
      const f: FaxMessage = {
        id,
        number: nextNumber(db, "FX", db.faxMessages, day),
        direction: "outbound",
        status: "queued",
        remoteNumber: c.to,
        remoteName: supplier?.name,
        localNumber: faxLocalDigits() || undefined,
        at: nowIso(),
        fileKey,
        fileName: poFileName(c.po),
        size: bytes.length,
        contentType: "application/pdf",
        provider: conn.adapter.name,
        idempotencyKey: input.key || undefined,
        supplierId: c.po.supplierId,
        purchaseOrderId: c.po.id,
        poVersion: c.po.version,
        orderIds: [...c.po.orderIds],
        storeId: c.po.storeId,
        assignedUserId: c.po.createdBy,
        userId: user.id,
        attempts: 0,
        events: [faxEvent("queued", `送信を受け付けました (${fmtFax(c.to)}・${conn.label}${input.resend ? "・再送" : ""})`, { status: "queued", userId: user.id })],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      stopPendingRetries(db, c.po.id, `新しい送信 (${f.number}) をした`);
      db.faxMessages.push(f);
      addAudit(db, { userId: user.id, action: "send", entity: "purchase_order", entityId: c.po.id, entityLabel: c.po.number, summary: `発注書を FAX で送信 (${f.number}・${supplier?.name ?? ""} ${fmtFax(c.to)}${c.po.version > 1 ? `・第${c.po.version}版` : ""}${input.resend ? "・再送" : ""})`, storeId: c.po.storeId });
      return f;
    });
  } catch (err) {
    await removeObjects([fileKey]).catch(() => undefined);
    throw err;
  }
  if (fax.id !== id) {
    await removeObjects([fileKey]).catch(() => undefined);
    return fax;
  }
  return (await submitFax(fax.id, user.id)) ?? fax;
}

/** FAX サービスへ依頼する (受付済み・自動の再送の予定の FAX)。通信エラーはその場で 1 回だけやり直す */
export async function submitFax(faxId: string, userId: string): Promise<FaxMessage | undefined> {
  const conn = faxConnection();
  await syncDb();
  const f = getDb().faxMessages.find((x) => x.id === faxId);
  if (!f || f.direction !== "outbound") return f;
  if (conn.mode !== "mock" && conn.mode !== "live") {
    return mutate((db) => {
      const x = db.faxMessages.find((y) => y.id === faxId);
      if (!x || x.status !== "queued") return x;
      x.status = "failed";
      x.lastError = "FAX サービスが未接続です";
      x.nextRetryAt = undefined;
      x.events.push(faxEvent("error", `送信できませんでした (${conn.detail})`, { status: "failed" }));
      x.updatedAt = nowIso();
      return x;
    });
  }
  const bytes = f.fileKey ? await readObject(f.fileKey) : null;
  // 依頼の直前に「依頼中」を記録する (依頼のあとにサーバーが止まった送信は、時間をおいて要確認にする)
  const claimed = await mutate((db) => {
    const x = db.faxMessages.find((y) => y.id === faxId);
    if (!x || !(x.status === "queued" || (x.status === "failed" && x.nextRetryAt))) return null;
    const po = x.purchaseOrderId ? db.purchaseOrders.find((p) => p.id === x.purchaseOrderId) : undefined;
    const stale = !po ? "発注書が見つからない" : po.status === "cancelled" ? "発注書を取り消した" : po.status === "completed" ? "発注書を完了にした" : x.poVersion !== po.version ? `発注書を訂正した (第${po.version}版)` : "";
    if (stale) {
      x.status = "failed";
      x.nextRetryAt = undefined;
      x.events.push(faxEvent("status", `${stale}ため、送信しませんでした`, { status: "failed" }));
      x.updatedAt = nowIso();
      return null;
    }
    if (!bytes) {
      x.status = "failed";
      x.nextRetryAt = undefined;
      x.lastError = "送信する PDF が見つかりません";
      x.events.push(faxEvent("error", "送信する PDF が見つからないため送信できませんでした", { status: "failed" }));
      x.updatedAt = nowIso();
      return null;
    }
    x.attempts += 1;
    x.status = "queued";
    x.nextRetryAt = undefined;
    x.events.push(faxEvent(x.attempts > 1 ? "retry" : "submit", `${conn.label} へ送信を依頼しました (${x.attempts} 回目)`, { status: "queued", userId }));
    x.updatedAt = nowIso();
    return { to: x.remoteNumber, fileName: x.fileName, attempts: x.attempts };
  });
  if (!claimed || !bytes) return getDb().faxMessages.find((x) => x.id === faxId);

  const call = async (): Promise<FaxSendOutcome> => {
    try {
      return await conn.adapter.send({ to: claimed.to, pdf: bytes, fileName: claimed.fileName, reference: faxId });
    } catch (err) {
      // アダプターの想定外の失敗は、依頼が届いたか分からないものとして扱う (自動では再送しない)
      return { ok: false, kind: "unknown", message: (err as Error).message || "送信の依頼でエラーが発生しました" };
    }
  };
  let outcome = await call();
  if (!outcome.ok && outcome.kind === "retryable") {
    await new Promise((r) => setTimeout(r, 2000));
    outcome = await call();
  }
  return applySendOutcome(faxId, outcome, userId);
}

function applySendOutcome(faxId: string, outcome: FaxSendOutcome, userId: string): Promise<FaxMessage | undefined> {
  return mutate((db) => {
    const x = db.faxMessages.find((y) => y.id === faxId);
    if (!x) return undefined;
    x.updatedAt = nowIso();
    if (outcome.ok) {
      x.providerId = outcome.providerId;
      x.providerRef = `${x.provider}:${outcome.providerId}`;
      x.lastError = undefined;
      if (outcome.pages) x.pages = outcome.pages;
      if (outcome.status === "sent") markSent(db, x, nowIso());
      else {
        x.status = "sending";
        x.events.push(faxEvent("accepted", "FAX サービスが受け付けました。送信の結果を待っています", { status: "sending" }));
      }
      return x;
    }
    x.lastError = outcome.message;
    if (outcome.kind === "unknown") {
      x.status = "unknown";
      x.events.push(faxEvent("error", `${outcome.message}。送信できたか分からないため、自動では再送しません。FAX サービスで確かめてから再送してください`, { status: "unknown", userId }));
    } else if (outcome.kind === "retryable" && x.attempts < MAX_SEND_ATTEMPTS) {
      x.status = "failed";
      const wait = RETRY_DELAYS_MIN[Math.min(x.attempts - 1, RETRY_DELAYS_MIN.length - 1)];
      x.nextRetryAt = new Date(Date.now() + wait * 60_000).toISOString();
      x.events.push(faxEvent("error", `${outcome.message}。${wait} 分後に自動で再送します`, { status: "failed", userId }));
    } else {
      x.status = "failed";
      x.nextRetryAt = undefined;
      x.events.push(faxEvent("error", `送信に失敗しました: ${outcome.message}${outcome.kind === "retryable" ? ` (${x.attempts} 回試しました)` : ""}`, { status: "failed", userId }));
    }
    return x;
  });
}

/** 送信成功を記録し、発注書を「送信済み」にする */
function markSent(db: Database, x: FaxMessage, at: string, pages?: number) {
  if (x.status === "sent") return;
  x.status = "sent";
  x.completedAt = at;
  x.nextRetryAt = undefined;
  x.lastError = undefined;
  if (pages) x.pages = pages;
  x.events.push(faxEvent("status", "送信に成功しました", { status: "sent" }));
  const po = x.purchaseOrderId ? db.purchaseOrders.find((p) => p.id === x.purchaseOrderId) : undefined;
  if (po && po.status !== "cancelled" && po.status !== "completed" && x.poVersion === po.version) {
    po.status = "sent";
    po.sentAt = at;
    po.updatedAt = nowIso();
  }
  addAudit(db, { userId: "system", action: "status", entity: "fax", entityId: x.id, entityLabel: x.number, summary: `FAX の送信に成功 (${x.remoteName ?? ""} ${fmtFax(x.remoteNumber)}${po ? `・発注書 ${po.number}` : ""})`, storeId: x.storeId });
}

/** FAX サービスの状態 (通知・問い合わせ) を反映する */
export function applyRemoteStatus(db: Database, x: FaxMessage, r: { status: "sending" | "sent" | "failed"; error?: string; pages?: number; completedAt?: string }): void {
  if (x.direction !== "outbound" || x.status === "sent" || x.status === "manual") return;
  x.updatedAt = nowIso();
  if (r.status === "sent") markSent(db, x, r.completedAt && !Number.isNaN(Date.parse(r.completedAt)) ? new Date(r.completedAt).toISOString() : nowIso(), r.pages);
  else if (r.status === "failed") {
    if (x.status === "failed") return;
    x.status = "failed";
    x.nextRetryAt = undefined;
    x.lastError = r.error || "送信に失敗しました";
    x.events.push(faxEvent("status", `送信に失敗しました: ${x.lastError}`, { status: "failed" }));
    addAudit(db, { userId: "system", action: "status", entity: "fax", entityId: x.id, entityLabel: x.number, summary: `FAX の送信に失敗 (${x.lastError})`, storeId: x.storeId });
  } else if (x.status !== "sending") {
    x.status = "sending";
    x.events.push(faxEvent("status", "送信中です", { status: "sending" }));
  }
}

/** 処理中の送信の状態を FAX サービスに問い合わせる */
export async function refreshFaxStatus(faxId: string): Promise<FaxMessage | undefined> {
  const conn = faxConnection();
  await syncDb();
  const f = getDb().faxMessages.find((x) => x.id === faxId);
  if (!f || f.direction !== "outbound" || f.status !== "sending" || !f.providerId) return f;
  if (conn.mode !== "mock" && conn.mode !== "live") return f;
  if (conn.adapter.name !== f.provider) return f;
  let r;
  try {
    r = await conn.adapter.status(f.providerId);
  } catch (err) {
    r = { error: (err as Error).message };
  }
  return mutate((db) => {
    const x = db.faxMessages.find((y) => y.id === faxId);
    if (!x) return undefined;
    if ("error" in r) {
      x.events.push(faxEvent("error", `送信の状態を確認できませんでした: ${r.error}`));
      x.updatedAt = nowIso();
      return x;
    }
    applyRemoteStatus(db, x, r);
    return x;
  });
}

/**
 * 担当者の再送 (失敗・要確認の送信)。同じ PDF (送った内容) をもう一度送る。
 * 要確認 (届いたか分からない) は confirmUnknown (FAX サービスで届いていないことを確かめた) が必要
 */
export async function retryFaxSend(user: User, faxId: string, confirmUnknown: boolean): Promise<FaxMessage | undefined> {
  const conn = faxConnection();
  if (conn.mode !== "mock" && conn.mode !== "live") throw new FaxError("FAX サービスが未接続のため再送できません。");
  await mutate((db) => {
    const x = db.faxMessages.find((y) => y.id === faxId);
    if (!x || x.direction !== "outbound") throw new FaxError("FAX が見つかりません。");
    const po = x.purchaseOrderId ? db.purchaseOrders.find((p) => p.id === x.purchaseOrderId) : undefined;
    if (!po || !canEditPurchaseOrder(user, po)) throw new FaxError("この FAX を再送する権限がありません。");
    if (po.status === "cancelled") throw new FaxError("取り消した発注書の FAX は再送できません。");
    if (x.status !== "failed" && x.status !== "unknown") throw new FaxError("再送できるのは、失敗・要確認の送信だけです。");
    if (x.status === "unknown" && !confirmUnknown) throw new FaxError("前回の送信が届いていないことを FAX サービスで確かめてから、確認のチェックを入れて再送してください。");
    if (db.faxMessages.some((f) => f.id !== x.id && f.purchaseOrderId === po.id && f.direction === "outbound" && IN_FLIGHT.includes(f.status))) throw new FaxError("この発注書のほかの送信を処理中です。結果が出るまでお待ちください。");
    x.status = "queued";
    x.nextRetryAt = undefined;
    x.events.push(faxEvent("retry", `${user.name} さんが再送しました`, { status: "queued", userId: user.id }));
    x.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "send", entity: "fax", entityId: x.id, entityLabel: x.number, summary: `FAX を再送 (${fmtFax(x.remoteNumber)})`, storeId: x.storeId });
  });
  return submitFax(faxId, user.id);
}

/** FAX 機で送ったことを記録する (FAX サービスが未接続のとき・FAX 機で送ったとき) */
export async function recordManualFax(user: User, poId: string, input: { to: string; key: string }): Promise<FaxMessage> {
  await syncDb();
  const pre = checkSendable(getDb(), user, getDb().purchaseOrders.find((p) => p.id === poId), { ...input, resend: true });
  if (pre.existing) return pre.existing;
  const id = newId("fax");
  const issuedPo: PurchaseOrder = { ...pre.po, status: pre.po.status === "draft" ? "issued" : pre.po.status };
  const bytes = Buffer.from(await renderPurchaseOrderPdf(purchaseOrderPdfData(getDb(), issuedPo)));
  const day = toDateKey(new Date());
  const fileKey = `fax/out/${day.slice(0, 4)}/${day.slice(5, 7)}/${id}.pdf`;
  await putObject(fileKey, bytes);
  try {
    const fax = await mutate((db) => {
      const po = db.purchaseOrders.find((p) => p.id === poId);
      const c = checkSendable(db, user, po, { ...input, resend: true });
      if (c.existing) return c.existing;
      const supplier = db.suppliers.find((s) => s.id === c.po.supplierId);
      const now = nowIso();
      if (c.po.status === "draft") c.po.issuedAt = now;
      c.po.status = "sent";
      c.po.sentAt = now;
      c.po.updatedAt = now;
      const f: FaxMessage = {
        id,
        number: nextNumber(db, "FX", db.faxMessages, day),
        direction: "outbound",
        status: "manual",
        remoteNumber: c.to,
        remoteName: supplier?.name,
        localNumber: faxLocalDigits() || undefined,
        at: now,
        completedAt: now,
        fileKey,
        fileName: poFileName(c.po),
        size: bytes.length,
        contentType: "application/pdf",
        provider: "manual",
        idempotencyKey: input.key || undefined,
        supplierId: c.po.supplierId,
        purchaseOrderId: c.po.id,
        poVersion: c.po.version,
        orderIds: [...c.po.orderIds],
        storeId: c.po.storeId,
        assignedUserId: c.po.createdBy,
        userId: user.id,
        attempts: 0,
        events: [faxEvent("manual", `${user.name} さんが FAX 機で送信したことを記録しました (${fmtFax(c.to)})`, { status: "manual", userId: user.id })],
        createdAt: now,
        updatedAt: now,
      };
      stopPendingRetries(db, c.po.id, `FAX 機で送信した (${f.number})`);
      db.faxMessages.push(f);
      addAudit(db, { userId: user.id, action: "send", entity: "purchase_order", entityId: c.po.id, entityLabel: c.po.number, summary: `発注書を FAX 機で送信 (記録・${f.number}・${supplier?.name ?? ""} ${fmtFax(c.to)})`, storeId: c.po.storeId });
      return f;
    });
    if (fax.id !== id) await removeObjects([fileKey]).catch(() => undefined);
    return fax;
  } catch (err) {
    await removeObjects([fileKey]).catch(() => undefined);
    throw err;
  }
}

/**
 * 定期実行 (/api/cron/fax・2 分ごと): 処理中の送信の状態の確認、通信エラーの自動の再送、
 * 依頼したまま結果の分からない送信を要確認に、AI の判定待ちの受信 FAX の読み直し
 */
export async function processFaxJobs(analyze: (id: string) => Promise<unknown>): Promise<{ polled: number; retried: number; stale: number; analyzed: number }> {
  await syncDb();
  const now = Date.now();
  const list = getDb().faxMessages;
  const result = { polled: 0, retried: 0, stale: 0, analyzed: 0 };
  const staleIds = list.filter((f) => f.direction === "outbound" && f.status === "queued" && f.attempts > 0 && !f.providerId && now - Date.parse(f.updatedAt) > STALE_SUBMIT_MS).map((f) => f.id);
  if (staleIds.length) {
    await mutate((db) => {
      for (const id of staleIds) {
        const x = db.faxMessages.find((y) => y.id === id);
        if (!x || x.status !== "queued" || x.providerId) continue;
        x.status = "unknown";
        x.lastError = "送信の依頼の結果が分かりません";
        x.events.push(faxEvent("error", "送信の依頼の結果が分からないため、要確認にしました (FAX サービスで確かめてから再送してください)", { status: "unknown" }));
        x.updatedAt = nowIso();
        result.stale += 1;
      }
    });
  }
  for (const f of list.filter((x) => x.direction === "outbound" && x.status === "queued" && x.attempts === 0 && now - Date.parse(x.createdAt) > 60_000).slice(0, 5)) {
    await submitFax(f.id, "system");
    result.retried += 1;
  }
  for (const f of list.filter((x) => x.direction === "outbound" && x.status === "failed" && x.nextRetryAt && Date.parse(x.nextRetryAt) <= now).slice(0, 5)) {
    await submitFax(f.id, "system");
    result.retried += 1;
  }
  for (const f of list.filter((x) => x.direction === "outbound" && x.status === "sending" && now - Date.parse(x.updatedAt) > POLL_MS).slice(0, 20)) {
    await refreshFaxStatus(f.id);
    result.polled += 1;
  }
  for (const f of list.filter((x) => x.direction === "inbound" && x.aiPending && now - Date.parse(x.updatedAt) > 60_000).slice(0, 5)) {
    await analyze(f.id);
    result.analyzed += 1;
  }
  return result;
}
