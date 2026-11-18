"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { PurchaseOrder } from "@/lib/db/types";
import { canEditPurchaseOrder, canManagePurchaseOrders } from "@/lib/auth/permissions";
import { MAX_PO_LINES, PO_EDITABLE, lineOrderIds, parseLines } from "@/lib/purchase-orders";
import { FaxError } from "@/lib/fax/inbound";
import { normFax, isValidFax, fmtFax } from "@/lib/fax/numbers";
import { recordManualFax, refreshFaxStatus, retryFaxSend, sendPurchaseOrderFax, stopPendingRetries } from "@/lib/fax/outbound";
import { FAX_STATUS } from "@/lib/constants";
import { faxTablesMissing } from "@/lib/fax/tables";
import { toDateKey } from "@/lib/format";
import { fail, requireActionUser, resolveStoreId, safeReturn, str, withMsg } from "./guards";

/**
 * 発注書の操作 (src/lib/purchase-orders.ts・src/lib/fax/outbound.ts)
 * 作成・下書きの保存・発行・複製・取消・完了、FAX の送信・再送・FAX 機で送った記録
 */

const PO_FIELDS: (keyof PurchaseOrder)[] = ["supplierId", "storeId", "issuedOn", "desiredDate", "deliveryPlace", "deliveryAddress", "faxTo", "notes", "showCustomer", "lines"];
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** 発注書を保存する (poId が空なら新規)。intent = issue のときは発行 (送信待ち) にする */
export async function savePurchaseOrder(poId: string | null, formData: FormData) {
  const user = await requireActionUser();
  const back = poId ? `/purchase-orders/${poId}/edit` : `/purchase-orders/new`;
  if (!canManagePurchaseOrders(user)) fail("/purchase-orders", "発注書を作成する権限がありません。");
  const noTable = await faxTablesMissing();
  if (noTable) fail(back, noTable);
  const intent = str(formData, "intent") === "issue" ? "issue" : "draft";
  const supplierId = str(formData, "supplierId");
  const issuedOn = str(formData, "issuedOn") || toDateKey(new Date());
  const desiredDate = str(formData, "desiredDate");
  if (!isDate(issuedOn)) fail(back, "発注日を確認してください。");
  if (desiredDate && !isDate(desiredDate)) fail(back, "希望納期の日付を確認してください。");
  const faxTo = normFax(str(formData, "faxTo"));
  if (faxTo && !isValidFax(faxTo)) fail(back, "送信先の FAX 番号を確認してください (0 から始まる 10〜11 桁)。");
  let id = poId ?? "";
  let message = "";
  try {
    await mutate((db) => {
      const supplier = db.suppliers.find((s) => s.id === supplierId);
      if (!supplier) throw new FaxError("仕入先を選んでください。");
      const parsed = parseLines(db, user, str(formData, "lines"), newId);
      if ("error" in parsed) throw new FaxError(parsed.error);
      const lines = parsed.lines;
      const firstOrder = db.orders.find((o) => o.id === lines.find((l) => l.orderId)?.orderId);
      const storeId = resolveStoreId(user, str(formData, "storeId"), firstOrder?.storeId);
      const fields = {
        supplierId,
        storeId,
        issuedOn,
        desiredDate: desiredDate || undefined,
        deliveryPlace: str(formData, "deliveryPlace").slice(0, 100),
        deliveryAddress: str(formData, "deliveryAddress").slice(0, 200) || undefined,
        faxTo: faxTo || undefined,
        notes: str(formData, "notes").slice(0, 2000) || undefined,
        showCustomer: formData.get("showCustomer") === "on" || undefined,
        lines,
        orderIds: lineOrderIds(lines),
      };
      if (!fields.deliveryPlace) throw new FaxError("納品先を入力してください。");
      const now = nowIso();
      if (!poId) {
        if (supplier.active === false) throw new FaxError("取引を終了した仕入先には発注できません。");
        const po: PurchaseOrder = {
          id: newId("po"),
          number: nextNumber(db, "PO", db.purchaseOrders, toDateKey(new Date())),
          status: intent === "issue" ? "issued" : "draft",
          version: 1,
          ...fields,
          createdBy: user.id,
          createdAt: now,
          updatedAt: now,
          issuedAt: intent === "issue" ? now : undefined,
        };
        db.purchaseOrders.push(po);
        id = po.id;
        message = `発注書 ${po.number} を${intent === "issue" ? "発行しました。PDF と FAX 番号を確認して送信してください" : "下書きで保存しました"}`;
        addAudit(db, { userId: user.id, action: "create", entity: "purchase_order", entityId: po.id, entityLabel: po.number, summary: `発注書を作成 (${supplier.name}・明細 ${lines.length} 行・案件 ${po.orderIds.length} 件${intent === "issue" ? "・発行" : "・下書き"})`, storeId: po.storeId });
        return;
      }
      const po = db.purchaseOrders.find((p) => p.id === poId);
      if (!po) throw new FaxError("発注書が見つかりません。");
      if (!canEditPurchaseOrder(user, po) || !canEditPurchaseOrder(user, { storeId })) throw new FaxError("この発注書を変更する権限がありません。");
      if (!PO_EDITABLE.includes(po.status)) throw new FaxError("取り消した・完了した発注書は変更できません。複製して新しい発注書を作ってください。");
      const wasSent = db.faxMessages.some((f) => f.purchaseOrderId === po.id && f.direction === "outbound" && f.poVersion === po.version && ["sent", "manual", "sending", "queued", "unknown"].includes(f.status));
      if (wasSent && supplierId !== po.supplierId) throw new FaxError("送信した発注書は仕入先を変えられません。複製して新しい発注書を作ってください。");
      if (db.faxMessages.some((f) => f.purchaseOrderId === po.id && f.direction === "outbound" && (f.status === "queued" || f.status === "sending"))) throw new FaxError("FAX の送信を処理中のため変更できません。結果が出てから変更してください。");
      const before = { ...po };
      Object.assign(po, fields);
      const changes = diffChanges(before, po, PO_FIELDS);
      if (!changes.length && !(intent === "issue" && po.status === "draft")) {
        message = "変更はありませんでした";
        return;
      }
      if (changes.length && wasSent) {
        // 送った内容を直したときは版を上げ、もう一度送る (訂正版)
        po.version += 1;
        po.status = "issued";
        stopPendingRetries(db, po.id, `発注書を訂正した (第${po.version}版)`);
        changes.push({ field: "version", before: before.version, after: po.version });
      } else if (intent === "issue" && po.status === "draft") {
        po.status = "issued";
        po.issuedAt = now;
      }
      po.updatedBy = user.id;
      po.updatedAt = now;
      message = po.version > before.version ? `発注書を訂正しました (第${po.version}版)。仕入先へもう一度送信してください` : po.status === "issued" && before.status === "draft" ? "発注書を発行しました。PDF と FAX 番号を確認して送信してください" : "発注書を保存しました";
      addAudit(db, { userId: user.id, action: "update", entity: "purchase_order", entityId: po.id, entityLabel: po.number, summary: po.version > before.version ? `発注書を訂正 (第${po.version}版)` : "発注書を変更", storeId: po.storeId, changes });
    });
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
  revalidatePath("/purchase-orders");
  redirect(withMsg(`/purchase-orders/${id}`, message));
}

async function poOp(poId: string, op: (po: PurchaseOrder, user: Awaited<ReturnType<typeof requireActionUser>>, db: Parameters<Parameters<typeof mutate>[0]>[0]) => string) {
  const user = await requireActionUser();
  const back = `/purchase-orders/${poId}`;
  let message = "";
  try {
    message = await mutate((db) => {
      const po = db.purchaseOrders.find((p) => p.id === poId);
      if (!po) throw new FaxError("発注書が見つかりません。");
      if (!canEditPurchaseOrder(user, po)) throw new FaxError("この発注書を操作する権限がありません。");
      return op(po, user, db);
    });
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
  revalidatePath(back);
  redirect(withMsg(back, message));
}

export async function issuePurchaseOrder(poId: string) {
  await poOp(poId, (po, user, db) => {
    if (po.status !== "draft") throw new FaxError("下書きの発注書だけ発行できます。");
    po.status = "issued";
    po.issuedAt = nowIso();
    po.updatedBy = user.id;
    po.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "status", entity: "purchase_order", entityId: po.id, entityLabel: po.number, summary: "発注書を発行", storeId: po.storeId, changes: [{ field: "status", before: "draft", after: "issued" }] });
    return "発注書を発行しました。PDF と FAX 番号を確認して送信してください";
  });
}

export async function completePurchaseOrder(poId: string) {
  await poOp(poId, (po, user, db) => {
    if (po.status !== "sent" && po.status !== "issued") throw new FaxError("発行・送信した発注書だけ完了にできます。");
    const before = po.status;
    po.status = "completed";
    stopPendingRetries(db, po.id, "発注書を完了にした");
    po.completedAt = nowIso();
    po.updatedBy = user.id;
    po.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "status", entity: "purchase_order", entityId: po.id, entityLabel: po.number, summary: "発注書を完了にしました (返信 FAX のひも付け候補から外れます)", storeId: po.storeId, changes: [{ field: "status", before, after: "completed" }] });
    return "発注書を完了にしました";
  });
}

export async function reopenPurchaseOrder(poId: string) {
  await poOp(poId, (po, user, db) => {
    if (po.status !== "completed") throw new FaxError("完了の発注書だけ戻せます。");
    po.status = po.sentAt ? "sent" : "issued";
    po.completedAt = undefined;
    po.updatedBy = user.id;
    po.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "status", entity: "purchase_order", entityId: po.id, entityLabel: po.number, summary: "発注書の完了を取り消し", storeId: po.storeId, changes: [{ field: "status", before: "completed", after: po.status }] });
    return "完了を取り消しました";
  });
}

export async function cancelPurchaseOrder(poId: string, formData: FormData) {
  const reason = str(formData, "reason").slice(0, 300);
  await poOp(poId, (po, user, db) => {
    if (po.status === "cancelled") throw new FaxError("すでに取り消しています。");
    if (!reason) throw new FaxError("取消の理由を入力してください。");
    if (db.faxMessages.some((f) => f.purchaseOrderId === po.id && f.direction === "outbound" && (f.status === "queued" || f.status === "sending"))) throw new FaxError("FAX の送信を処理中のため取り消せません。結果が出てから取り消してください。");
    const before = po.status;
    po.status = "cancelled";
    stopPendingRetries(db, po.id, "発注書を取り消した");
    po.cancelledAt = nowIso();
    po.cancelReason = reason;
    po.updatedBy = user.id;
    po.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "status", entity: "purchase_order", entityId: po.id, entityLabel: po.number, summary: `発注書を取消 (理由: ${reason})`, storeId: po.storeId, changes: [{ field: "status", before, after: "cancelled" }] });
    return before === "sent" ? "発注書を取り消しました。仕入先へ取消の連絡 (取消の PDF の送信・電話など) をしてください" : "発注書を取り消しました";
  });
}

/** 発注書を複製する (新しい発注番号の下書き。明細の案件番号は今の番号に直す) */
export async function duplicatePurchaseOrder(poId: string) {
  const user = await requireActionUser();
  const back = `/purchase-orders/${poId}`;
  const noTable = await faxTablesMissing();
  if (noTable) fail(back, noTable);
  let id = "";
  try {
    id = await mutate((db) => {
      const src = db.purchaseOrders.find((p) => p.id === poId);
      if (!src) throw new FaxError("発注書が見つかりません。");
      if (!canEditPurchaseOrder(user, src)) throw new FaxError("この発注書を複製する権限がありません。");
      const now = nowIso();
      const po: PurchaseOrder = {
        ...src,
        id: newId("po"),
        number: nextNumber(db, "PO", db.purchaseOrders, toDateKey(new Date())),
        status: "draft",
        version: 1,
        issuedOn: toDateKey(new Date()),
        lines: src.lines.slice(0, MAX_PO_LINES).map((l) => ({ ...l, id: newId("pol"), orderNumber: db.orders.find((o) => o.id === l.orderId)?.number ?? l.orderNumber })),
        copiedFrom: src.id,
        createdBy: user.id,
        createdAt: now,
        updatedBy: undefined,
        updatedAt: now,
        issuedAt: undefined,
        sentAt: undefined,
        completedAt: undefined,
        cancelledAt: undefined,
        cancelReason: undefined,
      };
      db.purchaseOrders.push(po);
      addAudit(db, { userId: user.id, action: "create", entity: "purchase_order", entityId: po.id, entityLabel: po.number, summary: `発注書を複製 (${src.number} から)`, storeId: po.storeId });
      return po.id;
    });
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
  revalidatePath("/purchase-orders");
  redirect(withMsg(`/purchase-orders/${id}/edit`, "複製しました。内容を確かめて保存してください"));
}

/** FAX で送る (送信前の確認のチェックが必要) */
export async function sendPurchaseOrder(poId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/purchase-orders/${poId}`;
  if (formData.get("confirm") !== "on") fail(back, "PDF の内容と送信先の FAX 番号を確認し、確認のチェックを入れてから送信してください。");
  let msg = "";
  try {
    const f = await sendPurchaseOrderFax(user, poId, { to: str(formData, "to"), key: str(formData, "key"), resend: formData.get("resend") === "on" });
    msg =
      f.status === "sent" ? `FAX を送信しました (${f.number})`
      : f.status === "sending" || f.status === "queued" ? `FAX サービスが受け付けました (${f.number})。送信の結果はこの画面に表示されます`
      : f.status === "unknown" ? `送信できたか分かりません (${f.number})。FAX サービスで確かめてください`
      : `${FAX_STATUS[f.status].label} (${f.number})${f.lastError ? `: ${f.lastError}` : ""}${f.nextRetryAt ? `。${new Date(f.nextRetryAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })} ごろに自動で再送します` : ""}`;
    if (f.status === "failed" || f.status === "unknown") {
      revalidatePath(back);
      fail(back, msg);
    }
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
  revalidatePath(back);
  redirect(withMsg(back, msg));
}

/** FAX 機で送ったことを記録する */
export async function recordManualSend(poId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/purchase-orders/${poId}`;
  if (formData.get("confirm") !== "on") fail(back, "FAX 機で送信したことを確認し、チェックを入れてから記録してください。");
  try {
    const f = await recordManualFax(user, poId, { to: str(formData, "to"), key: str(formData, "key") });
    revalidatePath(back);
    redirect(withMsg(back, `FAX 機で送信したことを記録しました (${f.number}・${fmtFax(f.remoteNumber)})`));
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
}

/** 失敗・要確認の送信を再送する */
export async function retryFax(faxId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "back"), `/fax/${faxId}`);
  let msg = "";
  try {
    const f = await retryFaxSend(user, faxId, formData.get("confirmUnknown") === "on");
    msg = f ? `${FAX_STATUS[f.status].label} (${f.number})${f.status === "failed" && f.lastError ? `: ${f.lastError}` : ""}` : "再送しました";
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
  revalidatePath(back);
  redirect(withMsg(back, msg));
}

/** 送信の状態を FAX サービスに問い合わせる */
export async function refreshFax(faxId: string, formData: FormData) {
  await requireActionUser();
  const back = safeReturn(str(formData, "back"), `/fax/${faxId}`);
  const f = await refreshFaxStatus(faxId);
  revalidatePath(back);
  redirect(withMsg(back, f ? `状態: ${FAX_STATUS[f.status].label}` : "FAX が見つかりません"));
}
