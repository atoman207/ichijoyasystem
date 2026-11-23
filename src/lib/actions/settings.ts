"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, mutate, newId, diffChanges } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { DOCUMENT_SETTINGS_ID, documentSettings, validRegistrationNumber } from "@/lib/doc-settings";
import { testConnection } from "@/lib/ai/provider";
import { CUSTOMER_CREATOR_LABEL, OPS_SETTINGS_ID } from "@/lib/ops-settings";
import type { StoreId } from "@/lib/db/types";
import { canManageSettings } from "@/lib/auth/permissions";
import { CATEGORY_LABEL } from "@/lib/constants";
import { categoryName, isItemCategory, productItemCategory } from "@/lib/mgmt/categories";
import { choice, fail, numField, requireActionUser, str, withMsg } from "./guards";

async function requireAdmin(back: string) {
  const user = await requireActionUser();
  if (!canManageSettings(user)) fail(back, "この操作は管理者のみ実行できます。");
  return user;
}

export async function updateProduct(id: string, formData: FormData) {
  const back = "/settings?tab=products";
  const admin = await requireAdmin(back);
  const price = numField(formData, "unitPrice");
  if (price < 0) fail(back, "単価は 0 円以上で入力してください。");
  let catChanged = false;
  await mutate((db) => {
    const p = db.products.find((x) => x.id === id);
    if (!p) fail(back, "商品が見つかりません。");
    const before = p.unitPrice;
    p.unitPrice = price;
    p.active = str(formData, "active") !== "off";
    const changes: { field: string; before: unknown; after: unknown }[] = [];
    if (before !== price) changes.push({ field: "unitPrice", before, after: price });
    // 管理会計の品目 (欄があるときだけ。空 = 種別から自動)
    if (formData.has("mgmtCategory")) {
      const raw = str(formData, "mgmtCategory");
      if (raw && !isItemCategory(db, raw)) fail(back, "品目を選んでください。");
      const next = raw || undefined;
      if ((p.mgmtCategory ?? "") !== (next ?? "")) {
        changes.push({ field: "mgmtCategory", before: p.mgmtCategory ?? null, after: next ?? null });
        p.mgmtCategory = next;
        catChanged = true;
      }
    }
    addAudit(db, { userId: admin.id, action: "update", entity: "product", entityId: id, entityLabel: p.name, summary: `商品を変更 (${p.name}: 単価 ¥${before.toLocaleString("ja-JP")} → ¥${price.toLocaleString("ja-JP")}${catChanged ? ` / 品目 ${categoryName(db, productItemCategory(p))}` : ""})`, changes });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, catChanged ? "商品を更新しました。品目の変更は、品目を選んでいない見積の明細の集計 (管理会計) にも反映されます。" : "商品を更新しました。今後作成する見積に反映されます (既存の見積は変わりません)。"));
}

export async function createProduct(formData: FormData) {
  const back = "/settings?tab=products";
  const admin = await requireAdmin(back);
  const name = str(formData, "name");
  if (!name) fail(back, "商品名は必須です。");
  if (numField(formData, "unitPrice") < 0) fail(back, "単価は 0 円以上で入力してください。");
  await mutate((db) => {
    const id = newId("p");
    const mgmt = str(formData, "mgmtCategory");
    if (mgmt && !isItemCategory(db, mgmt)) fail(back, "品目を選んでください。");
    db.products.push({ id, category: choice(formData, "category", CATEGORY_LABEL, "other"), name, grade: str(formData, "grade") || undefined, unit: str(formData, "unit") || "式", unitPrice: numField(formData, "unitPrice"), sizeLabel: str(formData, "sizeLabel") || undefined, active: true, mgmtCategory: mgmt || undefined });
    addAudit(db, { userId: admin.id, action: "create", entity: "product", entityId: id, entityLabel: name, summary: `商品を追加 (${name})` });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "商品を追加しました。"));
}

export async function updateStore(id: StoreId, formData: FormData) {
  const back = "/settings?tab=stores";
  const admin = await requireAdmin(back);
  await mutate((db) => {
    const s = db.stores.find((x) => x.id === id);
    if (!s) fail(back, "店舗が見つかりません。");
    const before = { ...s };
    // 電話は空にできる (固定電話を置いていない店舗)。住所・責任者は空のときは変えない
    s.phone = str(formData, "phone");
    s.address = str(formData, "address") || s.address;
    s.managerUserId = str(formData, "managerUserId") || s.managerUserId;
    const changes = diffChanges(before, s, ["phone", "address", "managerUserId"]);
    if (changes.length) addAudit(db, { userId: admin.id, action: "update", entity: "store", entityId: id, entityLabel: s.name, summary: `店舗情報を更新 (${s.name})`, changes });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "店舗情報を更新しました。"));
}

/* ------------------------------------------------------------------ */
/* 帳票 (見積書・請求書・領収書) の会社情報                               */
/* ------------------------------------------------------------------ */

export async function updateDocumentSettings(formData: FormData) {
  const back = "/settings?tab=documents";
  const admin = await requireAdmin(back);
  if (BACKEND === "supabase" && missingTables().includes("settings") && (await recheckMissingTables()).includes("settings")) {
    fail(back, "データベースに設定の表 (settings) がまだありません。開発担当が npm run db:migrate を実行すると保存できるようになります。");
  }
  const registrationNumber = str(formData, "registrationNumber").normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
  if (!validRegistrationNumber(registrationNumber)) fail(back, "登録番号は T と 13 桁の数字で入力してください (例: T1234567890123)。");
  const banks = [0, 1, 2]
    .map((i) => ({ bank: str(formData, `bank${i}`), branch: str(formData, `branch${i}`), type: str(formData, `type${i}`) || "普通", number: str(formData, `number${i}`).normalize("NFKC"), holder: str(formData, `holder${i}`) }))
    .filter((b) => b.bank || b.number);
  if (banks.some((b) => !b.bank || !b.number || !b.holder)) fail(back, "振込先は銀行名・口座番号・口座名義をすべて入力してください。");
  const value = {
    companyName: str(formData, "companyName"),
    postalCode: str(formData, "postalCode"),
    address: str(formData, "address"),
    tel: str(formData, "tel"),
    fax: str(formData, "fax"),
    email: str(formData, "email"),
    website: str(formData, "website"),
    registrationNumber,
    showStore: formData.get("showStore") === "on",
    bankAccounts: banks,
    quoteValidDays: numField(formData, "quoteValidDays") || 30,
    paymentDays: numField(formData, "paymentDays"),
    quoteNote: str(formData, "quoteNote"),
    invoiceNote: str(formData, "invoiceNote"),
  };
  await mutate((db) => {
    const now = new Date().toISOString();
    const row = db.settings.find((s) => s.id === DOCUMENT_SETTINGS_ID);
    const before = documentSettings(db);
    if (row) Object.assign(row, { value, updatedBy: admin.id, updatedAt: now });
    else db.settings.push({ id: DOCUMENT_SETTINGS_ID, value, updatedBy: admin.id, updatedAt: now });
    const after = documentSettings(db);
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    addAudit(db, { userId: admin.id, action: "update", entity: "settings", entityId: DOCUMENT_SETTINGS_ID, entityLabel: "帳票の会社情報", summary: `帳票の会社情報を更新${changed.length ? ` (${changed.length} 項目)` : ""}` });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "帳票の会社情報を保存しました。見積書・請求書の PDF に反映されます。"));
}

/** AI の接続を確認する (設定 → 外部連携・AI)。結果は画面に表示し、変更履歴にも残す */
export async function checkAiConnection(): Promise<{ ok: boolean; message: string }> {
  const user = await requireActionUser();
  if (!canManageSettings(user)) return { ok: false, message: "この操作は管理者のみ実行できます。" };
  const r = await testConnection();
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: "ai", entityLabel: "AI 接続", summary: r.ok ? `AI の接続を確認 (成功: ${r.provider} / ${r.model} / ${(r.ms / 1000).toFixed(1)} 秒)` : `AI の接続を確認 (失敗: ${r.message})` });
  }).catch(() => undefined);
  if (r.ok) return { ok: true, message: `接続できました (${r.provider === "claude" ? "Claude" : "OpenAI"} / ${r.model} / ${(r.ms / 1000).toFixed(1)} 秒)。応答: ${r.reply}` };
  return { ok: false, message: `${r.message}${r.detail ? ` (詳細: ${r.detail})` : ""}` };
}

/** 運用の設定 (顧客の新規登録ができる人など) */
export async function updateOpsSettings(formData: FormData) {
  const back = "/settings?tab=ops";
  const admin = await requireAdmin(back);
  if (BACKEND === "supabase" && missingTables().includes("settings") && (await recheckMissingTables()).includes("settings")) fail(back, "データベースに設定の表がまだありません。");
  const mode = str(formData, "customerCreators");
  const customerCreators = mode === "office_and_managers" || mode === "all" ? mode : "office";
  await mutate((db) => {
    const now = new Date().toISOString();
    const row = db.settings.find((s) => s.id === OPS_SETTINGS_ID);
    const value = { ...(row?.value ?? {}), customerCreators };
    if (row) Object.assign(row, { value, updatedBy: admin.id, updatedAt: now });
    else db.settings.push({ id: OPS_SETTINGS_ID, value, updatedBy: admin.id, updatedAt: now });
    addAudit(db, { userId: admin.id, action: "update", entity: "settings", entityId: OPS_SETTINGS_ID, entityLabel: "運用の設定", summary: `顧客の新規登録ができる人: ${CUSTOMER_CREATOR_LABEL[customerCreators]}` });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "運用の設定を保存しました。"));
}
