import "server-only";
import { AiError, aiEnabled, generateJson, type AiPart } from "./provider";
import { withAiContext } from "./usage";

/**
 * 手書きの発注一覧・材料の手配表の読み取り (お客様のご要望 2026-11-27「■6 リフォーム案件の工程・発注管理」)。
 * 撮影した一覧の 1 行 = 材料 1 件。数は計算しない・推測しない (読めなければ null)。読み取った行は「要確認」で登録し、担当者が直す
 */

export interface ReadMaterial {
  name: string;
  code?: string;
  qty?: number;
  unit?: string;
  spec?: string;
  supplier?: string;
  neededBy?: string;
  note?: string;
  category: string;
}

const nullable = (t: string) => ({ anyOf: [{ type: t }, { type: "null" }] });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "code", "qty", "unit", "spec", "supplier", "neededBy", "note", "category"],
        properties: {
          name: { type: "string" },
          code: nullable("string"),
          qty: nullable("number"),
          unit: nullable("string"),
          spec: nullable("string"),
          supplier: nullable("string"),
          neededBy: nullable("string"),
          note: nullable("string"),
          category: { type: "string", enum: ["fusuma", "curtain", "cloth", "reform", "tatami", "shoji", "amido", "other"] },
        },
      },
    },
  },
} as const;

const SYSTEM = [
  "あなたは畳・襖・リフォームの会社の事務担当です。撮影した手書きの発注一覧・材料の手配表・リフォーム発注管理票を、1 行 = 材料 1 件として読み取ります。",
  "- リフォーム発注管理票の列は 業者 / 工事・材料等 / 数量 / 単位 / 単価 / 原価 / 発注日 / 施工・納品日 / 納品場所 / 備考。業者欄が空の行は直前の業者を引き継ぐ。",
  "- name は材料名・工事内容 (例: フローリング材、石膏ボード、襖紙 のぞみ、クロス、大工 人工)。code は品番・型番 (例: のぞみ177、SP-2341)。",
  "- qty は書かれた数量 (数字だけ)。unit は単位 (枚・本・m・㎡・箱・ケース・式・坪・人工 など)。spec は寸法・色・施工箇所・納品場所など。",
  "- supplier は発注先・外注業者の名前 (業者欄)。neededBy は施工・納品日や必要な日 (YYYY-MM-DD。年がなければ今年。分からなければ null)。",
  "- note に備考・単価・原価・発注日があれば短く残す。小計・合計・見出しだけの行は出さない。",
  "- category は材料の品目 (襖紙 = fusuma、カーテン = curtain、クロス・壁紙 = cloth、それ以外の建材・工事の手配 = reform)。",
  "- 読めない項目は null。数を計算したり推測したりしない。行を省かない。",
].join("\n");

export async function readMaterialList(p: { userId: string; fileName: string; mimeType: string; base64: string }): Promise<ReadMaterial[]> {
  if (!aiEnabled()) throw new AiError("config", "AI の読み取りが設定されていません (外部連携・AI の設定)。手で入力してください。");
  const isPdf = p.mimeType === "application/pdf" || /\.pdf$/i.test(p.fileName);
  const isImage = /^image\/(png|jpeg|jpg|webp|gif)$/.test(p.mimeType);
  if (!isPdf && !isImage) throw new AiError("unsupported", "写真 (JPEG・PNG) か PDF を選んでください。");
  const doc: AiPart = isPdf ? { type: "pdf", base64: p.base64, fileName: p.fileName } : { type: "image", mediaType: p.mimeType === "image/jpg" ? "image/jpeg" : p.mimeType, base64: p.base64 };
  const year = new Date().getFullYear();
  const r = await withAiContext({ kind: "material_list", userId: p.userId }, () =>
    generateJson<{ rows: (Omit<ReadMaterial, "code" | "qty" | "unit" | "spec" | "supplier" | "neededBy" | "note"> & Record<"code" | "unit" | "spec" | "supplier" | "neededBy" | "note", string | null> & { qty: number | null })[] }>({
      system: SYSTEM,
      parts: [doc, { type: "text", text: `この発注一覧を読み取ってください (今年は ${year} 年)。` }],
      schema: SCHEMA as unknown as Record<string, unknown>,
      schemaName: "ichijoya_material_list",
      maxTokens: 6000,
    }),
  );
  return (r.data.rows ?? [])
    .filter((x) => x.name?.trim())
    .map((x) => ({
      name: x.name.trim(),
      code: x.code?.trim() || undefined,
      qty: typeof x.qty === "number" && Number.isFinite(x.qty) && x.qty >= 0 ? x.qty : undefined,
      unit: x.unit?.trim() || undefined,
      spec: x.spec?.trim() || undefined,
      supplier: x.supplier?.trim() || undefined,
      neededBy: x.neededBy && /^\d{4}-\d{2}-\d{2}$/.test(x.neededBy) ? x.neededBy : undefined,
      note: x.note?.trim() || undefined,
      category: x.category,
    }));
}
