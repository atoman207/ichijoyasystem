import type { AttachmentCategory } from "@/lib/db/types";

/**
 * 資料・写真の種類 (お客様のご要望 2026-11-25「⑤ 予定表の案件からの資料登録」)
 * 現場図面 = 襖・障子・網戸がどこにはまっていたか (建具の番号) の手書きの図面、採寸図 = 畳の新調の手書きの採寸図、
 * 現場の写真 = 現場の状況、施工前・施工後 = 施工事例の写真、資料 = パソコンからの PDF など
 */
export const ATTACHMENT_CATEGORY: Record<AttachmentCategory, { label: string; short: string; hint: string; photo: boolean }> = {
  site_plan: { label: "現場図面 (建具の番号)", short: "現場図面", hint: "襖・障子・網戸に番号を振り、どこにはまっていたかを書いた図面", photo: true },
  measure: { label: "採寸図 (畳の新調)", short: "採寸図", hint: "畳の新調の手書きの採寸図", photo: true },
  site_photo: { label: "現場の写真", short: "現場写真", hint: "現場の状況の記録", photo: true },
  before: { label: "施工前の写真", short: "施工前", hint: "施工事例の写真 (施工前)", photo: true },
  after: { label: "施工後の写真", short: "施工後", hint: "施工事例の写真 (施工後)", photo: true },
  doc: { label: "資料 (PDF など)", short: "資料", hint: "パソコンから登録する PDF・各種資料", photo: false },
};

export const ATTACHMENT_CATEGORIES = Object.keys(ATTACHMENT_CATEGORY) as AttachmentCategory[];

export const isAttachmentCategory = (v: unknown): v is AttachmentCategory => typeof v === "string" && v in ATTACHMENT_CATEGORY;
