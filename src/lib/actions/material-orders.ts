"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Database, MaterialOrder, MaterialOrderCategory, MaterialOrderStatus, StoreId, User } from "@/lib/db/types";
import { canEditMaterialOrder } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";
import { isDateKey } from "@/lib/calendar";
import { MATERIAL_CATEGORIES, MATERIAL_CATEGORY, MATERIAL_STATUS, MATERIAL_STATUSES, materialRows, reformLines, type MaterialRow } from "@/lib/material-orders/plan";
import { materialTableMissing } from "@/lib/material-orders/tables";
import { readMaterialList, type ReadMaterial } from "@/lib/ai/material-list";
import { fail, requireActionUser, safeReturn, str, withErr, withMsg } from "./guards";

/**
 * 材料発注の操作 (お客様のご要望 2026-11-27「■4〜■6」)。一覧 (/material-orders) と案件の画面の「材料の発注」で同じ処理。
 * 受注から自動で出す行は、操作したときに初めて保存する (key = auto:<受注>:<明細>:<品番の番号>)。どの操作も変更履歴に残す
 */

const PAGE = "/material-orders";

function back(fd: FormData): string {
  return safeReturn(str(fd, "returnTo"), PAGE);
}

async function ready(ret: string) {
  const missing = await materialTableMissing();
  if (missing) fail(ret, missing);
}

function revalidate(orderId?: string) {
  revalidatePath(PAGE);
  if (orderId) {
    revalidatePath(`/orders/${orderId}`);
    revalidatePath("/cases", "layout");
  }
}

/** 行の印から行を探す (自動の行は受注から計算し直す) */
function findRow(db: Database, key: string): MaterialRow | undefined {
  const today = toDateKey(new Date());
  if (key.startsWith("mo:")) {
    const m = db.materialOrders.find((x) => x.id === key.slice(3));
    if (!m) return undefined;
    return materialRows(db, today, { orderIds: m.orderId ? [m.orderId] : [] }).find((r) => r.key === key) ?? materialRows(db, today, { storeId: m.storeId }).find((r) => r.key === key);
  }
  const orderId = /^auto:([^:]+):/.exec(key)?.[1];
  if (!orderId) return undefined;
  return materialRows(db, today, { orderIds: [orderId] }).find((r) => r.key === key);
}

/** 自動の行を保存する (初めて操作したとき)。保存した行はそのまま */
function ensureRecord(db: Database, row: MaterialRow, user: User, now: string): MaterialOrder {
  if (row.id) return db.materialOrders.find((x) => x.id === row.id)!;
  const rec: MaterialOrder = {
    id: newId("mo"),
    key: row.key,
    orderId: row.orderId,
    storeId: row.storeId,
    category: row.category,
    name: row.name,
    code: row.code,
    qtyAuto: row.qtyAuto,
    unit: row.unit,
    spec: row.spec,
    status: "unordered",
    source: "auto",
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  };
  db.materialOrders.push(rec);
  return rec;
}

const label = (r: Pick<MaterialRow, "name" | "code" | "orderNumber">) => `${r.name}${r.code ? ` ${r.code}` : ""}${r.orderNumber ? ` (${r.orderNumber})` : ""}`;

function setStatus(db: Database, user: User, row: MaterialRow, status: MaterialOrderStatus, now: string, ret: string, existing?: MaterialOrder) {
  if (!canEditMaterialOrder(user, row.storeId)) fail(ret, "この店舗の材料の発注を変える権限がありません。");
  const rec = existing ?? ensureRecord(db, row, user, now);
  const before = rec.status;
  if (before === status) return false;
  rec.status = status;
  if (status === "ordered") {
    rec.orderedBy = user.id;
    rec.orderedAt = now;
    // 発注したときの必要数量 (見積の数量が変わったら知らせる)
    if (row.source === "auto") rec.qtyAuto = row.qtyAuto;
  } else if (status === "unordered") {
    rec.orderedBy = undefined;
    rec.orderedAt = undefined;
  }
  rec.updatedBy = user.id;
  rec.updatedAt = now;
  addAudit(db, { userId: user.id, action: "update", entity: "material_order", entityId: rec.id, entityLabel: label(row), summary: `材料発注: ${label(row)} を「${MATERIAL_STATUS[status].label}」に`, storeId: rec.storeId, changes: [{ field: "status", before: MATERIAL_STATUS[before].label, after: MATERIAL_STATUS[status].label }] });
  return true;
}

/** 状況を変える (「発注済み」ボタン・在庫使用・別途発注・発注不要・未発注に戻す)。key は複数可 (案件の未発注をまとめて) */
export async function setMaterialStatus(formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData);
  await ready(ret);
  const status = str(formData, "status") as MaterialOrderStatus;
  if (!MATERIAL_STATUSES.includes(status)) fail(ret, "発注状況が正しくありません。");
  const keys = [...new Set(formData.getAll("key").map(String).filter(Boolean))].slice(0, 200);
  if (!keys.length) fail(ret, "材料が選ばれていません。");
  let changed = 0;
  const orderIds = new Set<string>();
  await mutate((db) => {
    const now = nowIso();
    for (const key of keys) {
      const row = findRow(db, key);
      if (!row) fail(ret, "材料が見つかりません (見積の明細が変わった可能性があります。画面を開き直してください)。");
      if (setStatus(db, user, row, status, now, ret)) changed++;
      if (row.orderId) orderIds.add(row.orderId);
    }
  });
  for (const id of orderIds) revalidate(id);
  revalidate();
  redirect(withMsg(ret, changed ? `${changed} 件を「${MATERIAL_STATUS[status].label}」にしました${status === "ordered" ? ` (発注者: ${user.name})` : ""}。` : "変更はありませんでした。"));
}

const num = (raw: string): number | undefined | null => {
  const t = raw.replace(/[,，\s]/g, "");
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 100) / 100 : null;
};

/** 1 行を直す (発注数量・状況・発注先・必要な日・メモ。手入力・読み取りの行は材料名・品番・単位・内容も) */
export async function saveMaterialRow(formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData);
  await ready(ret);
  const key = str(formData, "key");
  const qty = num(str(formData, "qty"));
  if (qty === null) fail(ret, "数量を正しく入力してください。");
  const neededBy = str(formData, "neededBy");
  if (neededBy && !isDateKey(neededBy)) fail(ret, "必要な日を正しく入力してください。");
  const status = str(formData, "status") as MaterialOrderStatus;
  let orderId: string | undefined;
  await mutate((db) => {
    const now = nowIso();
    const row = findRow(db, key);
    if (!row) fail(ret, "材料が見つかりません。");
    if (!canEditMaterialOrder(user, row.storeId)) fail(ret, "この店舗の材料の発注を変える権限がありません。");
    orderId = row.orderId;
    const rec = ensureRecord(db, row, user, now);
    const before = { qty: rec.qty, supplierName: rec.supplierName, neededBy: rec.neededBy, note: rec.note, name: rec.name, code: rec.code, unit: rec.unit, spec: rec.spec };
    rec.qty = row.source === "auto" && qty === row.qtyAuto ? undefined : qty;
    rec.supplierName = str(formData, "supplierName").slice(0, 80) || undefined;
    rec.neededBy = neededBy || undefined;
    rec.note = str(formData, "note").slice(0, 300) || undefined;
    if (row.source !== "auto") {
      rec.name = str(formData, "name").slice(0, 80) || rec.name;
      rec.code = str(formData, "code").slice(0, 60) || undefined;
      rec.unit = str(formData, "unit").slice(0, 10) || undefined;
      rec.spec = str(formData, "spec").slice(0, 300) || undefined;
    }
    rec.updatedBy = user.id;
    rec.updatedAt = now;
    const after = { qty: rec.qty, supplierName: rec.supplierName, neededBy: rec.neededBy, note: rec.note, name: rec.name, code: rec.code, unit: rec.unit, spec: rec.spec };
    const changes = (Object.keys(before) as (keyof typeof before)[]).filter((k) => (before[k] ?? "") !== (after[k] ?? "")).map((k) => ({ field: k, before: before[k] ?? null, after: after[k] ?? null }));
    if (changes.length) addAudit(db, { userId: user.id, action: "update", entity: "material_order", entityId: rec.id, entityLabel: label(row), summary: `材料発注: ${label(row)} を変更`, storeId: rec.storeId, changes });
    if (MATERIAL_STATUSES.includes(status)) setStatus(db, user, row, status, now, ret, rec);
  });
  revalidate(orderId);
  redirect(withMsg(ret, "材料の発注を保存しました。"));
}

function categoryOf(v: string): MaterialOrderCategory {
  return (MATERIAL_CATEGORIES as string[]).includes(v) ? (v as MaterialOrderCategory) : "other";
}

/** 手で材料を足す (在庫補充など案件にひも付かない発注・リフォームの手配)。受注の番号か受注の ID で案件にひも付ける */
export async function addMaterialRow(formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData);
  await ready(ret);
  const name = str(formData, "name").slice(0, 80);
  if (!name) fail(ret, "材料名を入力してください。");
  const qty = num(str(formData, "qty"));
  if (qty === null) fail(ret, "数量を正しく入力してください。");
  const neededBy = str(formData, "neededBy");
  if (neededBy && !isDateKey(neededBy)) fail(ret, "必要な日を正しく入力してください。");
  const db0 = getDb();
  const ref = str(formData, "orderId") || str(formData, "orderNumber");
  const order = ref ? db0.orders.find((o) => o.id === ref || o.number === ref.trim()) : undefined;
  if (ref && !order) fail(ret, `受注 ${ref} が見つかりません。`);
  const storeId = (order?.storeId ?? str(formData, "storeId")) as StoreId;
  if (!db0.stores.some((s) => s.id === storeId)) fail(ret, "店舗を選んでください。");
  if (!canEditMaterialOrder(user, storeId)) fail(ret, "この店舗の材料の発注を登録する権限がありません。");
  const status = (MATERIAL_STATUSES as string[]).includes(str(formData, "status")) ? (str(formData, "status") as MaterialOrderStatus) : "unordered";
  await mutate((db) => {
    const now = nowIso();
    const rec: MaterialOrder = {
      id: newId("mo"),
      orderId: order?.id,
      storeId,
      category: categoryOf(str(formData, "category") || (order?.category === "reform" ? "reform" : "other")),
      name,
      code: str(formData, "code").slice(0, 60) || undefined,
      qty,
      unit: str(formData, "unit").slice(0, 10) || undefined,
      spec: str(formData, "spec").slice(0, 300) || undefined,
      status,
      supplierName: str(formData, "supplierName").slice(0, 80) || undefined,
      neededBy: neededBy || undefined,
      note: str(formData, "note").slice(0, 300) || undefined,
      source: "manual",
      ...(status === "ordered" ? { orderedBy: user.id, orderedAt: now } : {}),
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.materialOrders.push(rec);
    addAudit(db, { userId: user.id, action: "create", entity: "material_order", entityId: rec.id, entityLabel: label({ name, code: rec.code, orderNumber: order?.number }), summary: `材料発注を登録: ${MATERIAL_CATEGORY[rec.category]} ${name}${rec.qty !== undefined ? ` ${rec.qty}${rec.unit ?? ""}` : ""}${order ? ` (受注 ${order.number})` : " (案件なし)"}`, storeId });
  });
  revalidate(order?.id);
  redirect(withMsg(ret, `材料「${name}」を登録しました。`));
}

/** 手入力・読み取りの行を消す (自動の行は「発注不要」にする) */
export async function deleteMaterialRow(formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData);
  await ready(ret);
  const key = str(formData, "key");
  if (!key.startsWith("mo:")) fail(ret, "見積から自動で出した材料は消せません (「発注不要」にしてください)。");
  let orderId: string | undefined;
  await mutate((db) => {
    const rec = db.materialOrders.find((x) => x.id === key.slice(3));
    if (!rec || rec.key) fail(ret, "材料が見つかりません。");
    if (!canEditMaterialOrder(user, rec.storeId)) fail(ret, "この店舗の材料の発注を変える権限がありません。");
    orderId = rec.orderId;
    db.materialOrders = db.materialOrders.filter((x) => x.id !== rec.id);
    addAudit(db, { userId: user.id, action: "delete", entity: "material_order", entityId: rec.id, entityLabel: rec.name, summary: `材料発注を削除: ${rec.name}${rec.code ? ` ${rec.code}` : ""}`, storeId: rec.storeId });
  });
  revalidate(orderId);
  redirect(withMsg(ret, "材料を削除しました。"));
}

/** リフォームなど: 見積の明細から手配の行を足す (案件の画面) */
export async function addMaterialsFromQuote(formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData);
  await ready(ret);
  const orderId = str(formData, "orderId");
  const lineIds = new Set(formData.getAll("lineId").map(String));
  if (!lineIds.size) fail(ret, "見積の明細を選んでください。");
  let added = 0;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail(ret, "受注が見つかりません。");
    if (!canEditMaterialOrder(user, o.storeId)) fail(ret, "この店舗の材料の発注を登録する権限がありません。");
    const q = db.quotes.find((x) => x.id === o.quoteId);
    const now = nowIso();
    for (const it of reformLines(q).filter((x) => lineIds.has(x.id))) {
      db.materialOrders.push({ id: newId("mo"), orderId: o.id, storeId: o.storeId, category: "reform", name: it.name, spec: [it.spec, `見積 ${it.qty}${it.unit}`].filter(Boolean).join(" · "), qty: it.qty > 0 ? it.qty : undefined, unit: it.unit, status: "unordered", source: "manual", createdBy: user.id, createdAt: now, updatedAt: now });
      added++;
    }
    if (added) addAudit(db, { userId: user.id, action: "create", entity: "material_order", entityId: o.id, entityLabel: o.number, summary: `材料発注: 見積の明細から ${added} 件の手配を登録 (受注 ${o.number})`, storeId: o.storeId });
  });
  revalidate(orderId);
  redirect(withMsg(ret, `見積の明細から ${added} 件の手配を足しました。発注先・必要な日を入れて、発注したら「発注済み」を押してください。`));
}

/**
 * 手書きの発注一覧を撮影して読み取る (お客様のご要望 2026-11-27「■6」)。AI が材料名・品番・数量・発注先・必要な日を読み、
 * 案件の材料に「読み取り (要確認)」として足す。読み取りの結果は担当者が確かめて直す (AI だけで発注済みにしない)
 */
export async function readMaterialPhoto(formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData);
  await ready(ret);
  const orderId = str(formData, "orderId");
  const db0 = getDb();
  const o = db0.orders.find((x) => x.id === orderId);
  if (!o) fail(ret, "受注が見つかりません。");
  if (!canEditMaterialOrder(user, o.storeId)) fail(ret, "この店舗の材料の発注を登録する権限がありません。");
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) fail(ret, "発注一覧の写真 (JPEG・PNG) か PDF を選んでください。");
  if (file.size > 8 * 1024 * 1024) fail(ret, "ファイルが大きすぎます (8 MB まで)。");
  const mime = file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "image/jpeg");
  let rows: ReadMaterial[] = [];
  try {
    rows = await readMaterialList({ userId: user.id, fileName: file.name, mimeType: mime, base64: Buffer.from(await file.arrayBuffer()).toString("base64") });
  } catch (e) {
    redirect(withErr(ret, (e as Error).message || "読み取れませんでした。"));
  }
  if (!rows.length) redirect(withErr(ret, "発注一覧の行を読み取れませんでした。写真を撮り直すか、手で入力してください。"));
  await mutate((db) => {
    const now = nowIso();
    for (const r of rows.slice(0, 80)) {
      if (r.neededBy && !isDateKey(r.neededBy)) r.neededBy = undefined;
      db.materialOrders.push({ id: newId("mo"), orderId: o.id, storeId: o.storeId, category: categoryOf(r.category), name: r.name.slice(0, 80), code: r.code?.slice(0, 60), qty: r.qty ?? undefined, unit: r.unit?.slice(0, 10), spec: r.spec?.slice(0, 300), status: "unordered", supplierName: r.supplier?.slice(0, 80), neededBy: r.neededBy, note: ["写真から読み取り (要確認)", r.note].filter(Boolean).join(" · ").slice(0, 300), source: "ai", createdBy: user.id, createdAt: now, updatedAt: now });
    }
    addAudit(db, { userId: user.id, action: "create", entity: "material_order", entityId: o.id, entityLabel: o.number, summary: `材料発注: 手書きの発注一覧を読み取り ${Math.min(rows.length, 80)} 件を登録 (受注 ${o.number}・要確認)`, storeId: o.storeId });
  });
  revalidate(orderId);
  redirect(withMsg(ret, `発注一覧から ${Math.min(rows.length, 80)} 件を読み取りました。内容 (品番・数量・発注先・必要な日) を確かめて直してください。`));
}
