"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nowIso, syncDb } from "@/lib/db/store";
import type { Database, FaxMessage, FaxNumberKind, Supplier, User } from "@/lib/db/types";
import { canDeleteFax, canEditFaxLinks, canEditSuppliers, canManagePurchaseOrders, canRegisterFaxNumber, canTriageFax, canViewFax, canViewPurchaseOrder } from "@/lib/auth/permissions";
import { removeObjects } from "@/lib/storage";
import { analyzeAndLink, FaxError, faxEvent, receiveFax } from "@/lib/fax/inbound";
import { faxConnection } from "@/lib/fax/adapter";
import { fmtFax, isValidFax, normFax, normRef } from "@/lib/fax/numbers";
import { renderPurchaseOrderPdf } from "@/lib/pdf/render";
import { purchaseOrderPdfData } from "@/lib/purchase-orders";
import { mockAdPdf } from "@/lib/fax/mock-docs";
import { FAX_NUMBER_KIND_LABEL } from "@/lib/constants";
import { faxTablesMissing } from "@/lib/fax/tables";
import { choice, fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * FAX の操作: 受信した FAX の登録 (PDF・画像)、仕分け (取り込む・不要・戻す)、送信元の登録 (仕入先・顧客)、
 * ひも付けの修正 (発注書・案件・担当者)、AI の読み直し、確認済み、完全な削除 (管理者)、不要な番号の台帳、
 * 模擬の受信 (検証環境だけ)
 */

const faxBack = (id: string) => `/fax/${id}`;

async function faxOp(faxId: string, formData: FormData | null, check: (user: User, f: FaxMessage) => boolean, deny: string, op: (db: Database, f: FaxMessage, user: User) => string) {
  const user = await requireActionUser();
  const back = formData ? safeReturn(str(formData, "back"), faxBack(faxId)) : faxBack(faxId);
  let message = "";
  try {
    message = await mutate((db) => {
      const f = db.faxMessages.find((x) => x.id === faxId);
      if (!f) throw new FaxError("FAX が見つかりません。");
      if (!canViewFax(user, f) || !check(user, f)) throw new FaxError(deny);
      const r = op(db, f, user);
      f.updatedAt = nowIso();
      return r;
    });
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
  revalidatePath("/fax");
  redirect(withMsg(back, message));
}

/** 受信した FAX (紙の FAX をスキャンした PDF・写真など) を登録する。AI で判定してから詳細を開く */
export async function uploadFax(formData: FormData) {
  const user = await requireActionUser();
  const back = "/fax?tab=inbox";
  const noTable = await faxTablesMissing();
  if (noTable) fail(back, noTable);
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) fail(back, "FAX の PDF・画像を選んでください。");
  const from = normFax(str(formData, "from"));
  if (from && !isValidFax(from)) fail(back, "送信元の FAX 番号を確認してください (0 から始まる 10〜11 桁)。分からないときは空欄にします。");
  const when = str(formData, "receivedAt");
  let id = "";
  try {
    const r = await receiveFax({
      provider: "upload",
      from,
      receivedAt: when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : nowIso(),
      bytes: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      userId: user.id,
      assignedUserId: canTriageFax(user) ? undefined : user.id,
      storeId: canTriageFax(user) ? undefined : user.storeId,
      note: `${user.name} さんが登録`,
    });
    id = r.fax.id;
    await analyzeAndLink(id, user.id);
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
  revalidatePath("/fax");
  redirect(withMsg(faxBack(id), "FAX を登録しました。AI の判定とひも付けを確認してください"));
}

/** 仕分け: accept = 取り込む / junk = 不要 (block = 番号も不要に登録) / restore = 不要から戻す (要確認へ) */
export async function triageFax(faxId: string, formData: FormData) {
  const decision = choice(formData, "decision", ["accept", "junk", "restore"] as const, "accept");
  const block = formData.get("block") === "on";
  await faxOp(faxId, formData, (u) => canTriageFax(u), "受信 FAX の仕分けは本部スタッフ・管理者ができます。", (db, f, user) => {
    if (f.direction !== "inbound") throw new FaxError("受信した FAX だけ仕分けできます。");
    const before = f.triage;
    if (decision === "restore") {
      if (f.triage !== "junk") throw new FaxError("不要にした FAX だけ戻せます。");
      f.triage = "review";
      const entry = db.faxNumbers.find((n) => n.number === f.remoteNumber && n.kind === "blocked");
      if (entry && formData.get("unblock") === "on") {
        db.faxNumbers = db.faxNumbers.filter((n) => n.id !== entry.id);
        addAudit(db, { userId: user.id, action: "delete", entity: "fax_number", entityId: entry.id, entityLabel: fmtFax(entry.number), summary: `不要な番号の登録を解除 (${fmtFax(entry.number)} ${entry.label})` });
      }
    } else if (decision === "accept") {
      if (f.triage === "accepted" || f.triage === "auto") throw new FaxError("すでに取り込んでいます。");
      f.triage = "accepted";
    } else {
      if (f.triage === "junk") throw new FaxError("すでに不要にしています。");
      f.triage = "junk";
      if (block && f.remoteNumber && !db.faxNumbers.some((n) => n.number === f.remoteNumber)) {
        const label = (f.ai?.senderName || f.remoteName || "").slice(0, 60) || "広告など";
        db.faxNumbers.push({ id: newId("faxno"), number: f.remoteNumber, kind: "blocked", label, note: `${f.number} から登録`, createdBy: user.id, createdAt: nowIso(), updatedAt: nowIso() });
        addAudit(db, { userId: user.id, action: "create", entity: "fax_number", entityId: f.remoteNumber, entityLabel: fmtFax(f.remoteNumber), summary: `不要な番号に登録 (${fmtFax(f.remoteNumber)} ${label})` });
      }
    }
    f.decidedBy = user.id;
    f.decidedAt = nowIso();
    const label = decision === "accept" ? "取り込みました" : decision === "junk" ? `不要にしました${block && f.remoteNumber ? " (番号も不要に登録)" : ""}` : "不要から戻しました (要確認)";
    f.events.push(faxEvent("triage", `${user.name} さんが${label}`, { userId: user.id }));
    addAudit(db, { userId: user.id, action: "update", entity: "fax", entityId: f.id, entityLabel: f.number, summary: `受信 FAX を${label}`, storeId: f.storeId, changes: [{ field: "triage", before, after: f.triage }] });
    return `${f.number} を${label}`;
  });
}

/** 送信元を新しい仕入先として登録し、この FAX と同じ番号の要確認の FAX をひも付ける */
export async function registerFaxSupplier(faxId: string, formData: FormData) {
  const name = str(formData, "name").slice(0, 100);
  const category = str(formData, "category").slice(0, 40) || "未分類";
  const kind = choice(formData, "kind", ["supplier", "partner"] as const, "supplier");
  await faxOp(faxId, formData, (u) => canTriageFax(u) && canEditSuppliers(u), "仕入先の登録は本部スタッフ・管理者ができます。", (db, f, user) => {
    if (!name) throw new FaxError("仕入先の名前を入力してください。");
    if (!f.remoteNumber) throw new FaxError("送信元の FAX 番号が分からないため登録できません。");
    if (db.suppliers.some((s) => normFax(s.fax) === f.remoteNumber)) throw new FaxError("この FAX 番号の仕入先はすでに登録されています。");
    const now = nowIso();
    const s: Supplier = { id: newId("sup"), name, category, kind, fax: fmtFax(f.remoteNumber), paymentTerms: "", closingDay: 31, active: true, notes: `FAX ${f.number} から登録`, createdAt: now, updatedAt: now };
    db.suppliers.push(s);
    addAudit(db, { userId: user.id, action: "create", entity: "supplier", entityId: s.id, entityLabel: s.name, summary: `仕入先を登録 (FAX ${fmtFax(f.remoteNumber)}・受信 FAX ${f.number} から)` });
    let n = 0;
    for (const x of db.faxMessages.filter((y) => y.direction === "inbound" && y.remoteNumber === f.remoteNumber && !y.supplierId && y.triage !== "junk")) {
      x.supplierId = s.id;
      x.remoteName = s.name;
      if (x.triage === "review") x.triage = x.id === f.id ? "accepted" : "auto";
      x.events.push(faxEvent("link", `送信元を仕入先「${s.name}」として登録しました`, { userId: user.id }));
      x.updatedAt = now;
      n += 1;
    }
    f.decidedBy = user.id;
    f.decidedAt = now;
    return `仕入先「${s.name}」を登録し、この番号の FAX ${n} 件をひも付けました`;
  });
}

/** 送信元を既存の仕入先・顧客にひも付ける (register = この番号を FAX 番号の台帳に登録し、次から自動で判別する) */
export async function linkFaxSender(faxId: string, formData: FormData) {
  const target = choice(formData, "target", ["supplier", "customer"] as const, "supplier");
  const wantRegister = formData.get("register") === "on";
  await faxOp(faxId, formData, (u, f) => canEditFaxLinks(u, f), "この FAX のひも付けを変更する権限がありません。", (db, f, user) => {
    const register = wantRegister && canRegisterFaxNumber(user);
    const now = nowIso();
    let label = "";
    if (target === "supplier") {
      const s = db.suppliers.find((x) => x.id === str(formData, "supplierId"));
      if (!s) throw new FaxError("仕入先を選んでください。");
      const before = f.supplierId;
      f.supplierId = s.id;
      f.remoteName = s.name;
      label = `仕入先「${s.name}」`;
      addAudit(db, { userId: user.id, action: "update", entity: "fax", entityId: f.id, entityLabel: f.number, summary: `FAX の送信元を ${label} にひも付け`, storeId: f.storeId, changes: [{ field: "supplierId", before, after: s.id }] });
      if (register) addNumber(db, user, f.remoteNumber, "supplier", { supplierId: s.id, label: s.name }, f.number);
    } else {
      const code = normRef(str(formData, "customerCode"));
      const c = db.customers.find((x) => normRef(x.code) === code);
      if (!c) throw new FaxError("顧客コード (例: C-00012) で顧客を指定してください。");
      if (!canTriageFax(user) && c.storeId !== user.storeId) throw new FaxError("ほかの店舗の顧客にはひも付けられません。");
      const before = f.customerId;
      f.customerId = c.id;
      f.remoteName = c.name;
      if (f.storeId === "hq" && !f.purchaseOrderId) f.storeId = c.storeId;
      label = `顧客「${c.name}」`;
      addAudit(db, { userId: user.id, action: "update", entity: "fax", entityId: f.id, entityLabel: f.number, summary: `FAX の送信元を ${label} にひも付け`, storeId: f.storeId, changes: [{ field: "customerId", before, after: c.id }] });
      if (register) addNumber(db, user, f.remoteNumber, "customer", { customerId: c.id, label: c.name }, f.number);
    }
    f.events.push(faxEvent("link", `${user.name} さんが送信元を ${label} にひも付けました${register && f.remoteNumber ? " (番号を台帳に登録)" : ""}`, { userId: user.id }));
    f.updatedAt = now;
    return `送信元を ${label} にひも付けました`;
  });
}

function addNumber(db: Database, user: User, number: string, kind: FaxNumberKind, ref: { supplierId?: string; customerId?: string; label: string }, from: string) {
  if (!number) throw new FaxError("送信元の FAX 番号が分からないため、台帳に登録できません。");
  const cur = db.faxNumbers.find((n) => n.number === number);
  const now = nowIso();
  if (cur) {
    const before = { kind: cur.kind, label: cur.label };
    Object.assign(cur, { kind, supplierId: ref.supplierId, customerId: ref.customerId, label: ref.label, updatedAt: now });
    addAudit(db, { userId: user.id, action: "update", entity: "fax_number", entityId: cur.id, entityLabel: fmtFax(number), summary: `FAX 番号の台帳を変更 (${FAX_NUMBER_KIND_LABEL[kind]}: ${ref.label})`, changes: [{ field: "kind", before: before.kind, after: kind }, { field: "label", before: before.label, after: ref.label }] });
    return;
  }
  db.faxNumbers.push({ id: newId("faxno"), number, kind, supplierId: ref.supplierId, customerId: ref.customerId, label: ref.label, note: `${from} から登録`, createdBy: user.id, createdAt: now, updatedAt: now });
  addAudit(db, { userId: user.id, action: "create", entity: "fax_number", entityId: number, entityLabel: fmtFax(number), summary: `FAX 番号を台帳に登録 (${FAX_NUMBER_KIND_LABEL[kind]}: ${ref.label})` });
}

/** ひも付けの修正: 発注書・案件 (受注番号)・担当者 */
export async function updateFaxLinks(faxId: string, formData: FormData) {
  await faxOp(faxId, formData, (u, f) => canEditFaxLinks(u, f), "この FAX のひも付けを変更する権限がありません。", (db, f, user) => {
    const before = { purchaseOrderId: f.purchaseOrderId, orderIds: [...f.orderIds], assignedUserId: f.assignedUserId, supplierId: f.supplierId };
    const poId = str(formData, "purchaseOrderId");
    if (poId) {
      const po = db.purchaseOrders.find((p) => p.id === poId);
      if (!po || !canViewPurchaseOrder(user, po)) throw new FaxError("発注書が見つからないか、扱う権限がありません。");
      if (f.direction === "outbound" && f.purchaseOrderId && f.purchaseOrderId !== po.id) throw new FaxError("送信した FAX の発注書は変えられません。");
      f.purchaseOrderId = po.id;
      f.supplierId ??= po.supplierId;
      if (f.supplierId !== po.supplierId && formData.get("forceSupplier") !== "on") throw new FaxError("送信元の仕入先と発注書の仕入先が違います。正しい場合は「仕入先も発注書に合わせる」にチェックを入れてください。");
      f.supplierId = po.supplierId;
      f.storeId = po.storeId;
    } else if (formData.get("clearPo") === "on" && f.direction === "inbound") {
      f.purchaseOrderId = undefined;
    }
    // 案件: 受注番号をカンマ・空白区切りで (発注書の案件は自動で含める)
    const typed = str(formData, "orderNumbers").split(/[\s,、，]+/).map(normRef).filter(Boolean);
    const orders = typed.map((n) => db.orders.find((o) => normRef(o.number) === n));
    const missing = typed.filter((_, i) => !orders[i]);
    if (missing.length) throw new FaxError(`受注番号 ${missing.join("・")} が見つかりません。`);
    const po = f.purchaseOrderId ? db.purchaseOrders.find((p) => p.id === f.purchaseOrderId) : undefined;
    f.orderIds = [...new Set([...(po?.orderIds ?? []), ...orders.map((o) => o!.id)])];
    if (!po && f.orderIds.length && !f.customerId && f.storeId === "hq") f.storeId = db.orders.find((o) => o.id === f.orderIds[0])!.storeId;
    const assignee = str(formData, "assignedUserId");
    if (assignee && !db.users.some((u) => u.id === assignee && u.active)) throw new FaxError("担当者を選び直してください。");
    f.assignedUserId = assignee || undefined;
    const changes = (["purchaseOrderId", "orderIds", "assignedUserId", "supplierId"] as const)
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(f[k]))
      .map((k) => ({ field: k, before: before[k], after: f[k] }));
    if (!changes.length) return "変更はありませんでした";
    f.events.push(faxEvent("link", `${user.name} さんがひも付けを修正しました`, { userId: user.id }));
    addAudit(db, { userId: user.id, action: "update", entity: "fax", entityId: f.id, entityLabel: f.number, summary: "FAX のひも付けを修正", storeId: f.storeId, changes });
    return "ひも付けを保存しました";
  });
}

/** 担当者が内容を確認した (返信 FAX の確認。通知から外れる) */
export async function checkFax(faxId: string, formData: FormData) {
  await faxOp(faxId, formData, () => true, "この FAX を表示する権限がありません。", (db, f, user) => {
    if (f.checkedAt) throw new FaxError("すでに確認済みです。");
    f.checkedAt = nowIso();
    f.checkedBy = user.id;
    f.events.push(faxEvent("check", `${user.name} さんが内容を確認しました`, { userId: user.id }));
    addAudit(db, { userId: user.id, action: "update", entity: "fax", entityId: f.id, entityLabel: f.number, summary: "FAX の内容を確認", storeId: f.storeId });
    return "確認済みにしました";
  });
}

/** AI で読み直す (判定と番号の読み取り。ひも付け済みの発注書は変えない) */
export async function reanalyzeFax(faxId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "back"), faxBack(faxId));
  await syncDb();
  const f = getDb().faxMessages.find((x) => x.id === faxId);
  if (!f || !canViewFax(user, f) || !canEditFaxLinks(user, f)) fail(back, "この FAX を読み直す権限がありません。");
  if (f.direction !== "inbound") fail(back, "受信した FAX だけ読み直せます。");
  const r = await analyzeAndLink(faxId, user.id);
  revalidatePath("/fax");
  if (r?.ai?.error) fail(back, `AI の判定に失敗しました: ${r.ai.error}`);
  redirect(withMsg(back, "AI で読み直しました"));
}

/** 不要にした FAX を完全に削除する (PDF を含む。管理者だけ) */
export async function deleteFax(faxId: string) {
  const user = await requireActionUser();
  const back = faxBack(faxId);
  if (!canDeleteFax(user)) fail(back, "FAX の削除は管理者ができます。");
  let key: string | undefined;
  try {
    key = await mutate((db) => {
      const f = db.faxMessages.find((x) => x.id === faxId);
      if (!f) throw new FaxError("FAX が見つかりません。");
      if (f.direction !== "inbound" || f.triage !== "junk") throw new FaxError("削除できるのは、不要に仕分けた受信 FAX だけです。");
      db.faxMessages = db.faxMessages.filter((x) => x.id !== faxId);
      addAudit(db, { userId: user.id, action: "delete", entity: "fax", entityId: f.id, entityLabel: f.number, summary: `不要な FAX を削除 (${fmtFax(f.remoteNumber) || "番号不明"}・${f.ai?.senderName ?? f.remoteName ?? ""})`, storeId: f.storeId });
      return f.fileKey;
    });
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
  if (key) await removeObjects([key]).catch(() => undefined);
  revalidatePath("/fax");
  redirect(withMsg("/fax?tab=junk", "FAX を削除しました"));
}

/** 不要な番号を台帳に登録する */
export async function addBlockedNumber(formData: FormData) {
  const user = await requireActionUser();
  const back = "/fax?tab=numbers";
  if (!canTriageFax(user)) fail(back, "不要な番号の台帳は本部スタッフ・管理者が変更できます。");
  const noTable = await faxTablesMissing();
  if (noTable) fail(back, noTable);
  const number = normFax(str(formData, "number"));
  if (!isValidFax(number)) fail(back, "FAX 番号を確認してください (0 から始まる 10〜11 桁)。");
  const label = str(formData, "label").slice(0, 60) || "不要な番号";
  try {
    await mutate((db) => {
      if (db.suppliers.some((s) => normFax(s.fax) === number)) throw new FaxError("仕入先の FAX 番号は不要にできません (仕入先の台帳を確認してください)。");
      if (db.faxNumbers.some((n) => n.number === number)) throw new FaxError("この番号はすでに台帳にあります。");
      db.faxNumbers.push({ id: newId("faxno"), number, kind: "blocked", label, note: str(formData, "note").slice(0, 200) || undefined, createdBy: user.id, createdAt: nowIso(), updatedAt: nowIso() });
      addAudit(db, { userId: user.id, action: "create", entity: "fax_number", entityId: number, entityLabel: fmtFax(number), summary: `不要な番号に登録 (${fmtFax(number)} ${label})` });
    });
  } catch (err) {
    if (err instanceof FaxError) fail(back, err.message);
    throw err;
  }
  revalidatePath("/fax");
  redirect(withMsg(back, `${fmtFax(number)} を不要な番号に登録しました (次から届く FAX は自動で「不要」になります)`));
}

/** FAX 番号の台帳から外す */
export async function removeFaxNumber(numberId: string) {
  const user = await requireActionUser();
  const back = "/fax?tab=numbers";
  if (!canTriageFax(user)) fail(back, "FAX 番号の台帳は本部スタッフ・管理者が変更できます。");
  let label = "";
  await mutate((db) => {
    const n = db.faxNumbers.find((x) => x.id === numberId);
    if (!n) return;
    db.faxNumbers = db.faxNumbers.filter((x) => x.id !== numberId);
    label = `${fmtFax(n.number)} ${n.label}`;
    addAudit(db, { userId: user.id, action: "delete", entity: "fax_number", entityId: n.id, entityLabel: fmtFax(n.number), summary: `FAX 番号の台帳から外す (${FAX_NUMBER_KIND_LABEL[n.kind]}: ${label})` });
  });
  revalidatePath("/fax");
  redirect(withMsg(back, label ? `${label} を台帳から外しました` : "すでに外れています"));
}

/* ---------------- 模擬の受信 (サンプルデータの検証環境だけ) ---------------- */

function requireMock(back: string) {
  if (faxConnection().mode !== "mock") fail(back, "模擬の受信は検証環境 (FAX_PROVIDER=mock・サンプルデータ) でだけ使えます。");
}

/** 仕入先からの返信 FAX (発注書に受注確認を書き込んで送り返した想定) を受信する */
export async function mockReceiveReply(poId: string) {
  const user = await requireActionUser();
  const back = `/purchase-orders/${poId}`;
  requireMock(back);
  await syncDb();
  const db = getDb();
  const po = db.purchaseOrders.find((p) => p.id === poId);
  if (!po || !canViewPurchaseOrder(user, po) || !canManagePurchaseOrders(user)) fail(back, "発注書が見つかりません。");
  const supplier = db.suppliers.find((s) => s.id === po.supplierId);
  const bytes = Buffer.from(await renderPurchaseOrderPdf(purchaseOrderPdfData(db, { ...po, status: "sent" })));
  const r = await receiveFax({
    provider: "mock",
    providerId: `reply-${newId("in")}`,
    from: normFax(supplier?.fax) || "0961112222",
    receivedAt: nowIso(),
    pages: 1,
    bytes,
    fileName: `返信_${po.number}.pdf`,
    text: `発注番号 ${po.number} 受注確認 お受けします 納品予定日 ${po.desiredDate ?? ""} ${supplier?.name ?? ""}`,
    userId: "system",
  });
  await analyzeAndLink(r.fax.id);
  revalidatePath(back);
  redirect(withMsg(`/fax/${r.fax.id}`, "模擬の返信 FAX を受信しました"));
}

/** 未登録の番号から広告の FAX を受信する */
export async function mockReceiveAd() {
  await requireActionUser();
  const back = "/fax?tab=review";
  requireMock(back);
  const r = await receiveFax({
    provider: "mock",
    providerId: `ad-${newId("in")}`,
    from: `0965${String(Math.floor(Math.random() * 900000) + 100000)}`,
    receivedAt: nowIso(),
    pages: 1,
    bytes: Buffer.from(await mockAdPdf()),
    fileName: "受信FAX.pdf",
    text: "法人向け 光回線 乗り換えキャンペーン 今だけ月額 半額 お問い合わせはフリーダイヤルへ 配信停止は FAX で",
    userId: "system",
  });
  await analyzeAndLink(r.fax.id);
  redirect(withMsg(`/fax/${r.fax.id}`, "模擬の広告 FAX を受信しました"));
}
