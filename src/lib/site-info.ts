import type { SiteInfo } from "@/lib/db/types";

/**
 * 現場情報・引継ぎ事項 (手書き見積書の 引取・納品日時、支払い方法、備考欄以下)
 * ------------------------------------------------------------
 * 書類取込の確認画面・見積・受注の画面・予定表のメモで共通に使う。項目名は AI の読取項目と同じ
 */

export const PAYMENT_OPTIONS = ["現金", "カード", "PayPay", "振込", "訪問集金", "その他"] as const;
export const EQUIPMENT_OPTIONS = ["脚立", "ローラー", "ジャッキ", "台車", "ジン"] as const;
/** 手書き見積書の「媒体」欄 (R = 以前のお客様) */
export const SITE_MEDIA_OPTIONS = ["R", "店舗", "チラシ", "パンフ", "DM", "点検", "SNS", "インスタ", "CM", "ラジオ", "TV", "口コミ", "紹介", "MAP", "HP", "イベント", "その他"] as const;

export type SiteFieldType = "text" | "textarea" | "number" | "choice" | "multi";

export interface SiteField {
  key: keyof SiteInfo & string;
  label: string;
  type: SiteFieldType;
  options?: readonly string[];
  wide?: boolean;
  /** 一覧・予定表のメモに出す短い名前 */
  short?: string;
}

export const SITE_FIELDS: SiteField[] = [
  { key: "pickupAt", label: "引取日時", type: "text" },
  { key: "deliveryAt", label: "納品日時", type: "text" },
  { key: "paymentMethod", label: "支払い方法 (納品時)", type: "choice", options: PAYMENT_OPTIONS, short: "支払い" },
  { key: "paymentNote", label: "支払いの補足 (VISA など)", type: "text", short: "支払い補足" },
  { key: "remarks", label: "備考", type: "textarea", wide: true },
  { key: "baggage", label: "荷物", type: "text" },
  { key: "oneOk", label: "1 人で作業", type: "choice", options: ["OK", "NG"], short: "1人" },
  { key: "spareTatami", label: "かえ畳 (枚)", type: "number", short: "かえ畳" },
  { key: "floor", label: "戸建て・階", type: "text", short: "建物" },
  { key: "sizes", label: "サイズ", type: "text" },
  { key: "straw", label: "わら", type: "choice", options: ["A", "B"] },
  { key: "material", label: "建材", type: "choice", options: ["A", "B"] },
  { key: "equipment", label: "道具 (脚立・ローラーなど)", type: "multi", options: EQUIPMENT_OPTIONS, wide: true, short: "道具" },
  { key: "paperCurtain", label: "紙カーテン", type: "text" },
  { key: "carryOut", label: "搬出", type: "choice", options: ["遠", "近"] },
  { key: "rain", label: "雨天", type: "choice", options: ["OK", "NG"] },
  { key: "media", label: "媒体 (○が付いたもの)", type: "multi", options: SITE_MEDIA_OPTIONS, wide: true, short: "媒体" },
  { key: "mediaOther", label: "媒体 その他", type: "text" },
  { key: "fusumaPaper", label: "襖紙", type: "text", wide: true },
  { key: "otherNotes", label: "欄外の書き込み", type: "textarea", wide: true, short: "その他" },
];

const clean = (v: unknown, max = 500): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** 入力・読取の値を SiteInfo にそろえる (選択肢にない値は落とす) */
export function toSiteInfo(raw: Record<string, unknown> | undefined | null): SiteInfo | undefined {
  if (!raw) return undefined;
  const out: SiteInfo = {};
  for (const f of SITE_FIELDS) {
    const v = raw[f.key];
    if (f.type === "multi") {
      const list = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,、|]/) : []).map((x) => String(x).trim()).filter((x) => (f.options ?? []).includes(x));
      if (list.length) (out as Record<string, unknown>)[f.key] = [...new Set(list)];
    } else if (f.type === "number") {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.normalize("NFKC")) : NaN;
      if (Number.isFinite(n) && n >= 0) (out as Record<string, unknown>)[f.key] = n;
    } else if (f.type === "choice") {
      const t = clean(v, 40);
      if (t && (f.options ?? []).includes(t)) (out as Record<string, unknown>)[f.key] = t;
      else if (t && f.key === "paymentMethod") out.paymentMethod = "その他";
    } else {
      const t = clean(v, f.type === "textarea" ? 2000 : 300);
      if (t) (out as Record<string, unknown>)[f.key] = t;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** フォーム (si_<項目名>) から読む */
export function siteInfoFromForm(fd: FormData, prefix = "si_"): SiteInfo | undefined {
  const raw: Record<string, unknown> = {};
  for (const f of SITE_FIELDS) raw[f.key] = f.type === "multi" ? fd.getAll(prefix + f.key).map(String) : String(fd.get(prefix + f.key) ?? "");
  return toSiteInfo(raw);
}

const show = (v: unknown): string => (Array.isArray(v) ? v.join("・") : v === undefined || v === null ? "" : String(v));

/** 表示用 [見出し, 値] (入力のある項目だけ) */
export function siteInfoLines(si: SiteInfo | undefined): [string, string][] {
  if (!si) return [];
  return SITE_FIELDS.filter((f) => show(si[f.key]) !== "").map((f) => [f.label, f.key === "spareTatami" ? `${show(si[f.key])} 枚` : show(si[f.key])]);
}

/** 1 行の要約 (予定表のメモ・検索用) */
export function siteInfoText(si: SiteInfo | undefined): string {
  if (!si) return "";
  return SITE_FIELDS.filter((f) => show(si[f.key]) !== "").map((f) => `${f.short ?? f.label}: ${show(si[f.key])}`).join(" / ");
}

/** 予定表のメモ (施工担当者への引継ぎ)。自動で書いたメモは先頭に印を付け、手で書いたメモは上書きしない */
export const HANDOVER_MARK = "【引継ぎ】";
export function handoverMemo(si: SiteInfo | undefined, workDetails?: string): string | undefined {
  const parts = [workDetails?.trim() ? `施工内容: ${workDetails.trim()}` : "", siteInfoText(si)].filter(Boolean);
  return parts.length ? `${HANDOVER_MARK}${parts.join("\n")}`.slice(0, 1500) : undefined;
}
