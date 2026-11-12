import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { DocumentKind, Product, StoreId } from "@/lib/db/types";
import { addDays, toDateKey } from "@/lib/format";
import { EXPENSE_ACCOUNTS } from "@/lib/constants";

/**
 * 紙書類の読取 (OCR + 構造化)
 * ------------------------------------------------------------
 * - ANTHROPIC_API_KEY が設定されている場合: Claude (vision) に画像/PDF を渡し、
 *   書類種別ごとの JSON スキーマで構造化データを抽出する
 * - 未設定の場合: ファイル名と種別から決定論的なサンプル結果を返す (デモ用)
 *
 * どちらの場合も戻り値の形は同じなので、画面側は差し替えを意識しない。
 */

export interface OcrResult {
  provider: "claude" | "mock";
  confidence: number;
  extracted: Record<string, unknown>;
  warnings: string[];
}

export const OCR_MODEL = "claude-opus-5-5";

const SCHEMA_HINT: Record<DocumentKind, string> = {
  handwritten_quote:
    '{"customerName": string, "siteAddress"?: string, "items": [{"name": string, "spec"?: string, "qty": number, "unit"?: string, "unitPrice": number}], "total"?: number, "note"?: string}',
  drawing: '{"rooms": [{"name": string, "size": string, "widthMm"?: number, "depthMm"?: number, "tatamiCount"?: number}], "measurements"?: string[], "note"?: string}',
  supplier_invoice: '{"supplier": string, "invoiceNumber"?: string, "invoiceDate": "YYYY-MM-DD", "dueDate"?: "YYYY-MM-DD", "amount": number, "taxAmount"?: number, "items"?: [{"name": string, "qty"?: number, "amount": number}]}',
  receipt: '{"vendor": string, "date": "YYYY-MM-DD", "amount": number, "taxAmount"?: number, "account": string, "paymentMethod": "cash"|"card"|"transfer", "items"?: string[]}',
  contract: '{"customerName": string, "contractDate"?: "YYYY-MM-DD", "amount"?: number, "summary": string}',
  other: '{"summary": string, "fields"?: {[key: string]: string}}',
};

function hashStr(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export function mockExtract(kind: DocumentKind, fileName: string, products: Product[], storeId: StoreId): OcrResult {
  const h = hashStr(fileName + kind);
  const pick = <T>(arr: readonly T[], salt = 0): T => arr[(h + salt) % arr.length];
  const today = toDateKey(new Date());
  const lower = fileName.toLowerCase();
  const conf = 0.86 + ((h % 11) / 100);
  const warnings: string[] = [];
  switch (kind) {
    case "handwritten_quote": {
      const tatami = products.filter((p) => p.category === "tatami" && p.id !== "p_t_disposal");
      const main = pick(tatami);
      const qty = pick([4.5, 6, 6, 8, 8, 10, 12], 3);
      const items = [
        { name: main.name, spec: main.grade, qty, unit: main.unit, unitPrice: main.unitPrice },
        { name: "古畳 引取・処分", qty, unit: "畳", unitPrice: 1000 },
        { name: "諸経費 (一式)", qty: 1, unit: "式", unitPrice: 3000 },
      ];
      if (h % 3 === 0) {
        const f = pick(products.filter((p) => p.category === "fusuma"), 5);
        items.splice(1, 0, { name: f.name, spec: f.grade, qty: pick([2, 4, 6], 7), unit: f.unit, unitPrice: f.unitPrice });
      }
      const subtotal = items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
      if (h % 4 === 0) warnings.push("数量の手書き文字 (6 と 8) の判別確度が低いため確認してください");
      return { provider: "mock", confidence: conf, warnings, extracted: { customerName: pick(["田中様", "山本様 (紹介)", "○○介護施設", "松本様 新築"], 2), siteAddress: pick(["熊本市東区", "合志市須屋", "玉名市大倉", "熊本市南区近見"], 4), items, subtotal, total: Math.floor(subtotal * 1.1), note: "手書き見積書から読取 (サンプル)" } };
    }
    case "receipt": {
      const presets = [
        { vendor: "ENEOS 合志SS", account: "車両費 (ガソリン代)", amount: 6820, paymentMethod: "card" },
        { vendor: "ホームセンター アグリ 合志店", account: "消耗品費", amount: 4380, paymentMethod: "cash" },
        { vendor: "セブン-イレブン 熊本保田窪店", account: "会議費", amount: 1296, paymentMethod: "cash" },
        { vendor: "NEXCO西日本 (ETC)", account: "旅費交通費", amount: 2310, paymentMethod: "card" },
        { vendor: "出光 玉名バイパスSS", account: "車両費 (ガソリン代)", amount: 5940, paymentMethod: "card" },
        { vendor: "ダイソー 保田窪店", account: "消耗品費", amount: 1100, paymentMethod: "cash" },
      ];
      let preset = pick(presets);
      if (lower.includes("eneos") || lower.includes("ガソリン") || lower.includes("gas")) preset = presets[0];
      if (lower.includes("etc") || lower.includes("高速")) preset = presets[3];
      return { provider: "mock", confidence: Math.min(0.98, conf + 0.05), warnings, extracted: { vendor: preset.vendor, date: addDays(today, -(h % 4)), amount: preset.amount, taxAmount: Math.floor(preset.amount - preset.amount / 1.1), account: preset.account, paymentMethod: preset.paymentMethod, storeId } };
    }
    case "supplier_invoice": {
      const presets = [
        { supplier: "熊本県い草生産者協同組合", amount: 412500, desc: "い草・畳表" },
        { supplier: "九州畳材 株式会社", amount: 198000, desc: "畳床・畳縁" },
        { supplier: "和紙工房 ふすま堂", amount: 66000, desc: "襖紙・障子紙" },
        { supplier: "西日本インテリア商会", amount: 87450, desc: "カーテン・ブラインド" },
      ];
      const p = pick(presets);
      const invoiceDate = addDays(today, -(h % 10));
      return { provider: "mock", confidence: conf, warnings, extracted: { supplier: p.supplier, invoiceNumber: `INV-${(h % 9000) + 1000}`, invoiceDate, dueDate: addDays(invoiceDate, 30), amount: p.amount, taxAmount: Math.floor(p.amount - p.amount / 1.1), items: [{ name: p.desc, amount: p.amount }] } };
    }
    case "drawing":
      return { provider: "mock", confidence: conf - 0.05, warnings: ["図面の寸法は現地採寸で再確認してください"], extracted: { rooms: [{ name: "和室 (1F)", size: "6畳", widthMm: 3640, depthMm: 2730, tatamiCount: 6 }, { name: "続き間", size: "4.5畳", widthMm: 2730, depthMm: 2730, tatamiCount: 4.5 }], measurements: ["襖 大 2枚 (1780×880)", "障子 大 4枚"], note: "縁側側の障子は破れあり" } };
    case "contract":
      return { provider: "mock", confidence: conf, warnings, extracted: { customerName: "○○様", contractDate: today, amount: 223300, summary: "畳表替え工事 請負契約書 (サンプル)" } };
    default:
      return { provider: "mock", confidence: conf, warnings, extracted: { summary: "書類の内容を読み取りました (サンプル)", fields: { 件名: fileName } } };
  }
}

export function aiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function extractDocument(params: { kind: DocumentKind; fileName: string; mimeType: string; base64?: string; products: Product[]; storeId: StoreId }): Promise<OcrResult> {
  const { kind, fileName, mimeType, base64, products, storeId } = params;
  if (!aiEnabled() || !base64) return mockExtract(kind, fileName, products, storeId);
  const isPdf = mimeType === "application/pdf";
  const isImage = /^image\/(png|jpeg|jpg|webp|gif)$/.test(mimeType);
  if (!isPdf && !isImage) return mockExtract(kind, fileName, products, storeId);

  const client = new Anthropic();
  const system = [
    "あなたは畳・襖・障子の施工会社 (株式会社一畳屋) の事務アシスタントです。",
    "渡された書類画像から情報を読み取り、指定の JSON スキーマのみを出力してください。説明文は不要です。",
    `書類種別: ${kind}。出力スキーマ: ${SCHEMA_HINT[kind]}`,
    "金額は税込の整数 (円)。日付は YYYY-MM-DD。読み取れない項目は省略。",
    `勘定科目は次から選択: ${EXPENSE_ACCOUNTS.join(" / ")}。`,
    `最後に "confidence" (0-1) と "warnings" (string[]) をトップレベルに含めてください。`,
    `参考: 自社商品マスタ ${products.slice(0, 20).map((p) => `${p.name}=${p.unitPrice}円/${p.unit}`).join(", ")}`,
  ].join("\n");
  const source = isPdf
    ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } } as const)
    : ({ type: "image", source: { type: "base64", media_type: mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: base64 } } as const);
  try {
    const res = await client.beta.messages.create({
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      model: OCR_MODEL,
      max_tokens: 4000,
      system,
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: [source, { type: "text", text: "この書類を読み取り、JSON のみを返してください。" }] }],
    });
    if (res.stop_reason === "refusal") {
      return { ...mockExtract(kind, fileName, products, storeId), warnings: ["AI が読取を拒否したためサンプル結果を表示しています"] };
    }
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.9;
    const warnings = Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [];
    delete parsed.confidence;
    delete parsed.warnings;
    return { provider: "claude", confidence, extracted: parsed, warnings };
  } catch (err) {
    console.warn("[ocr] claude extraction failed, falling back to mock:", (err as Error).message);
    return { ...mockExtract(kind, fileName, products, storeId), warnings: [`AI 読取に失敗したためサンプル結果を表示しています (${(err as Error).message})`] };
  }
}
