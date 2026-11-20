"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Inquiry, MediaKey, Promotion, PromotionKind, PromotionStatus, ServiceCategory, StoreId } from "@/lib/db/types";
import { canAccessStore, canEditPromotion, canManageOpsReportSettings, canSeeAllStores } from "@/lib/auth/permissions";
import { isDateKey } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { CATEGORY_LABEL } from "@/lib/constants";
import { MEDIA, MEDIA_MAPPING_ID, isMediaKey, readMediaRules, type MediaRule } from "@/lib/media";
import { PROMOTION_KIND, PROMOTION_STATUS } from "@/lib/ops-reports/promo-analysis";
import { parseAreas, parseEventSheet } from "@/lib/ops-reports/promo-input";
import { opsTablesMissing } from "@/lib/ops-reports/tables";
import { customerHasPhone, phoneDigits } from "@/lib/customer-contacts";
import { choice, fail, isKeyOf, requireActionUser, str, withMsg } from "./guards";

const FIELDS: (keyof Promotion)[] = ["kind", "title", "storeId", "status", "startDate", "endDate", "areas", "copies", "cost", "media", "vendor", "note"];

/** フォームの値を販促の記録にそろえる (エラーは back へ戻す) */
function readPromotion(formData: FormData, back: string): Omit<Promotion, "id" | "number" | "createdBy" | "createdAt" | "updatedAt" | "updatedBy"> {
  const kind = choice(formData, "kind", PROMOTION_KIND, "flyer") as PromotionKind;
  const title = str(formData, "title").slice(0, 100);
  if (!title) fail(back, "名前を入力してください (例: 2026年4月 合志店 新聞折込チラシ)。");
  const status = choice(formData, "status", PROMOTION_STATUS, "done") as PromotionStatus;
  const startDate = str(formData, "startDate");
  if (!isDateKey(startDate)) fail(back, "配布日・開始日を正しく入力してください。");
  const endDate = str(formData, "endDate") || undefined;
  if (endDate && (!isDateKey(endDate) || endDate < startDate)) fail(back, "終了日は開始日以降の日付を入力してください。");
  const { areas, errors } = parseAreas(str(formData, "areas"));
  if (errors.length) fail(back, `地域と部数: ${errors.slice(0, 3).join(" / ")}`);
  const copiesRaw = str(formData, "copies").normalize("NFKC").replace(/[,\s部枚通件人]/g, "");
  const copiesInput = copiesRaw ? Number(copiesRaw) : 0;
  if (!Number.isInteger(copiesInput) || copiesInput < 0) fail(back, "部数・件数は 0 以上の整数で入力してください。");
  const copies = areas.length ? areas.reduce((a, x) => a + x.copies, 0) : copiesInput;
  const costRaw = str(formData, "cost").normalize("NFKC").replace(/[,¥\s円]/g, "");
  const cost = costRaw ? Number(costRaw) : undefined;
  if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) fail(back, "費用は 0 以上の金額で入力してください。");
  const mediaRaw = str(formData, "media");
  const media: MediaKey = isMediaKey(mediaRaw) ? mediaRaw : PROMOTION_KIND[kind].media;
  return {
    kind,
    title,
    storeId: str(formData, "storeId") as StoreId,
    status,
    startDate,
    endDate,
    areas,
    copies,
    cost,
    media,
    vendor: str(formData, "vendor").slice(0, 100) || undefined,
    note: str(formData, "note").slice(0, 1000) || undefined,
  };
}

/** undefined の項目を消す (保存の差分に出さない) */
function compact<T extends object>(x: T): T {
  for (const k of Object.keys(x) as (keyof T)[]) if (x[k] === undefined) delete x[k];
  return x;
}

export async function createPromotion(formData: FormData) {
  const user = await requireActionUser();
  const back = "/promotions/new";
  const input = readPromotion(formData, back);
  if (!canSeeAllStores(user)) input.storeId = user.storeId;
  if (!getDb().stores.some((s) => s.id === input.storeId)) fail(back, "店舗を選んでください。");
  if (!canEditPromotion(user, input.storeId)) fail(back, "この店舗の販促を登録する権限がありません (本部スタッフ・管理者・その店舗の店長)。");
  const missing = await opsTablesMissing(["promotions"]);
  if (missing) fail(back, missing);
  const id = newId("pr");
  await mutate((db) => {
    const now = nowIso();
    const p: Promotion = compact({ id, number: nextNumber(db, "PR", db.promotions, input.startDate), ...input, createdBy: user.id, createdAt: now, updatedBy: user.id, updatedAt: now });
    db.promotions.push(p);
    addAudit(db, { userId: user.id, action: "create", entity: "promotion", entityId: id, entityLabel: p.number, summary: `販促を登録 (${PROMOTION_KIND[p.kind].label} ${p.title}・${p.copies.toLocaleString("ja-JP")}${PROMOTION_KIND[p.kind].unit})`, storeId: p.storeId });
  });
  revalidatePath("/promotions");
  redirect(withMsg(`/promotions/${id}`, "販促を登録しました。"));
}

export async function updatePromotion(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/promotions/${id}`;
  const input = readPromotion(formData, back);
  const missing = await opsTablesMissing(["promotions"]);
  if (missing) fail(back, missing);
  await mutate((db) => {
    const p = db.promotions.find((x) => x.id === id);
    if (!p) fail("/promotions?tab=list", "販促の記録が見つかりません。");
    if (!canEditPromotion(user, p.storeId)) fail(back, "この販促を変更する権限がありません。");
    if (!canSeeAllStores(user) || !db.stores.some((s) => s.id === input.storeId)) input.storeId = p.storeId;
    if (!canEditPromotion(user, input.storeId)) fail(back, "変更先の店舗の販促を扱う権限がありません。");
    const before = { ...p };
    Object.assign(p, input);
    compact(p);
    p.updatedBy = user.id;
    p.updatedAt = nowIso();
    const changes = diffChanges(before, p, FIELDS);
    if (!changes.length) return;
    addAudit(db, { userId: user.id, action: changes.some((c) => c.field === "status") ? "status" : "update", entity: "promotion", entityId: id, entityLabel: p.number, summary: `販促を更新 (${p.title})`, storeId: p.storeId, changes });
  });
  revalidatePath("/promotions");
  revalidatePath(back);
  redirect(withMsg(back, "販促を更新しました。"));
}

export async function deletePromotion(id: string) {
  const user = await requireActionUser();
  const back = `/promotions/${id}`;
  const missing = await opsTablesMissing(["promotions"]);
  if (missing) fail(back, missing);
  await mutate((db) => {
    const p = db.promotions.find((x) => x.id === id);
    if (!p) fail("/promotions?tab=list", "販促の記録が見つかりません。");
    if (!canEditPromotion(user, p.storeId)) fail(back, "この販促を削除する権限がありません。");
    const linked = db.inquiries.filter((i) => i.promotionId === id).length;
    if (linked) fail(back, `この販促にひも付いた問い合わせが ${linked} 件あります。削除せずに状態を「中止」にするか、問い合わせのきっかけの販促を外してから削除してください。`);
    db.promotions = db.promotions.filter((x) => x.id !== id);
    addAudit(db, { userId: user.id, action: "delete", entity: "promotion", entityId: id, entityLabel: p.number, summary: `販促を削除 (${PROMOTION_KIND[p.kind].label} ${p.title})`, storeId: p.storeId });
  });
  revalidatePath("/promotions");
  redirect(withMsg("/promotions?tab=list", "販促を削除しました。"));
}

/**
 * イベントの受付票をまとめて問い合わせとして登録する (入口 = イベント・展示会、媒体 = 販促の媒体、きっかけの販促 = この販促)。
 * 電話番号が同じ店舗の顧客と一致すれば、その顧客にひも付ける
 */
export async function registerEventInquiries(id: string, formData: FormData) {
  const user = await requireActionUser();
  // ?err= を付けるので # (ページ内の位置) は付けない
  const back = `/promotions/${id}`;
  const { rows, errors } = parseEventSheet(str(formData, "sheet"));
  if (errors.length) fail(back, errors.slice(0, 3).join(" / "));
  if (!rows.length) fail(back, "受付票の内容を貼り付けてください (1 行に 1 枚: 氏名, 電話, 住所, 内容)。");
  const date = str(formData, "date");
  if (!isDateKey(date)) fail(back, "受付日を正しく入力してください。");
  if (date > toDateKey(new Date())) fail(back, "受付日に未来の日付は入力できません。");
  const category = choice(formData, "category", CATEGORY_LABEL, "tatami") as ServiceCategory;
  const mediaRaw = str(formData, "media");
  const assignedRaw = str(formData, "assignedUserId");
  const missing = await opsTablesMissing(["promotions"]);
  if (missing) fail(back, missing);
  let linkedCustomers = 0;
  const count = await mutate((db) => {
    const p = db.promotions.find((x) => x.id === id);
    if (!p) fail("/promotions?tab=list", "販促の記録が見つかりません。");
    if (!canEditPromotion(user, p.storeId)) fail(back, "この販促の受付票を登録する権限がありません (本部スタッフ・管理者・その店舗の店長)。");
    const media: MediaKey = isMediaKey(mediaRaw) ? mediaRaw : p.media;
    const assignee = db.users.find((u) => u.id === assignedRaw && u.active);
    const now = nowIso();
    const receivedAt = new Date(`${date}T12:00:00+09:00`).toISOString();
    const customers = db.customers.filter((c) => c.storeId === p.storeId && canAccessStore(user, c.storeId));
    for (const r of rows) {
      const digits = phoneDigits(r.phone);
      const customer = digits.length >= 9 ? customers.find((c) => customerHasPhone(c, digits)) : undefined;
      if (customer) linkedCustomers++;
      const inqId = newId("inq");
      const summary = r.summary ? `${r.summary} (イベント受付)` : `イベント「${p.title}」の受付`;
      const inq: Inquiry = {
        id: inqId,
        number: nextNumber(db, "INQ", db.inquiries, date),
        customerId: customer?.id,
        contactName: r.name,
        contactPhone: r.phone || customer?.phone || undefined,
        channel: "event",
        storeId: p.storeId,
        category,
        summary: summary.slice(0, 120),
        detail: [`イベント「${p.title}」(${p.number}) の受付票から登録`, r.address ? `住所: ${r.address}` : "", r.summary ? `内容: ${r.summary}` : ""].filter(Boolean).join("\n"),
        status: "new",
        assignedUserId: assignee?.id ?? user.id,
        receivedAt,
        createdBy: user.id,
        updatedAt: now,
        media,
        promotionId: p.id,
      };
      if (r.address) inq.area = r.address;
      if (!inq.contactPhone) delete inq.contactPhone;
      if (!inq.customerId) delete inq.customerId;
      db.inquiries.push(inq);
      addAudit(db, { userId: user.id, action: "create", entity: "inquiry", entityId: inqId, entityLabel: inq.number, summary: `問い合わせを登録 (${r.name} / イベント「${p.title}」の受付票)`, storeId: p.storeId });
      if (customer) {
        db.commLogs.push({ id: newId("cl"), customerId: customer.id, channel: "event", direction: "inbound", subject: inq.summary, body: inq.detail, at: receivedAt, userId: user.id, relatedType: "inquiry", relatedId: inqId });
        customer.updatedAt = now;
      }
    }
    addAudit(db, { userId: user.id, action: "import", entity: "promotion", entityId: p.id, entityLabel: p.number, summary: `イベントの受付票 ${rows.length} 枚を問い合わせとして登録 (${p.title})`, storeId: p.storeId });
    return rows.length;
  });
  revalidatePath("/inquiries");
  revalidatePath("/promotions");
  revalidatePath(`/promotions/${id}`);
  redirect(withMsg(`/promotions/${id}`, `受付票 ${count} 枚を問い合わせとして登録しました${linkedCustomers ? ` (うち ${linkedCustomers} 件は電話番号が一致した顧客にひも付け)` : ""}。問い合わせ一覧の「未対応」から対応してください。`));
}

/**
 * 媒体の対応表 (過去の値 → 全社共通の分類) を保存する (本部スタッフ・管理者)。
 * 画面の行 r_<番号>_from / r_<番号>_match / r_<番号>_media。値が空の行は消す。reset=1 で既定に戻す
 */
export async function saveMediaMapping(formData: FormData) {
  const user = await requireActionUser();
  const back = "/promotions?tab=mapping";
  if (!canManageOpsReportSettings(user)) fail(back, "対応表を変更できるのは本部スタッフ・管理者です。");
  const reset = str(formData, "reset") === "1";
  const rules: MediaRule[] = [];
  if (!reset) {
    const n = Math.min(500, Math.max(0, Number(str(formData, "count")) || 0));
    for (let i = 0; i < n; i++) {
      const from = str(formData, `r_${i}_from`).slice(0, 60);
      if (!from) continue;
      const media = str(formData, `r_${i}_media`);
      if (!isKeyOf(MEDIA, media)) fail(back, `「${from}」の分類を選んでください。`);
      rules.push({ from, match: str(formData, `r_${i}_match`) === "exact" ? "exact" : "contains", media });
    }
  }
  await mutate((db) => {
    const before = readMediaRules(db);
    const now = nowIso();
    if (reset) db.settings = db.settings.filter((s) => s.id !== MEDIA_MAPPING_ID);
    else {
      const cur = db.settings.find((s) => s.id === MEDIA_MAPPING_ID);
      if (cur) {
        cur.value = { rules };
        cur.updatedBy = user.id;
        cur.updatedAt = now;
      } else db.settings.push({ id: MEDIA_MAPPING_ID, value: { rules }, updatedBy: user.id, updatedAt: now });
    }
    const after = reset ? readMediaRules(db).rules : rules;
    const text = (rs: MediaRule[]) => rs.map((r) => `${r.from}${r.match === "exact" ? " (同じ値)" : ""} → ${MEDIA[r.media].label}`).join(" / ");
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: MEDIA_MAPPING_ID, entityLabel: "媒体の対応表", summary: reset ? "媒体の対応表を既定に戻しました" : `媒体の対応表を保存 (${rules.length} 行)`, changes: text(before.rules) === text(after) ? [] : [{ field: "媒体の対応表", before: text(before.rules), after: text(after) }] });
  });
  revalidatePath("/promotions");
  revalidatePath("/inquiries");
  redirect(withMsg(back, reset ? "対応表を既定に戻しました。" : "対応表を保存しました。分析と問い合わせ一覧の媒体 (推定) に反映されます。"));
}
