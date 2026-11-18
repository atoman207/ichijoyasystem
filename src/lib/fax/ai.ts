import "server-only";
import type { FaxAiLabel, FaxAiResult } from "@/lib/db/types";
import { AiError, aiEnabled, generateJson, type AiPart } from "@/lib/ai/provider";
import { findRefs, normFax, normRef } from "./numbers";

/**
 * 受信 FAX の AI 判定と、発注番号・案件番号の読み取り (AI-OCR)
 * ------------------------------------------------------------
 * - 判定: 業務関連 (仕入先・お客様からの返信・注文請書・納期回答・請求書など) / 広告・営業 / 判定不能 と信頼度
 * - 読み取り: 書かれた発注番号 (PO-2026-0001)・案件番号 (受注番号 O-2026-0123 など)・送信元の名前と FAX 番号・書類の種類・要約
 * 判定の結果だけで FAX を消したり不要にしたりしない (要確認の一覧で担当者が決める)。読み取った番号は
 * システムにある番号と照合してからひも付ける (inbound.ts)。AI のキーがないときは判定しない (模擬の受信の文字だけは読む)
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "confidence", "reason", "senderName", "senderFax", "documentType", "summary", "poNumbers", "orderNumbers"],
  properties: {
    category: { type: "string", enum: ["business", "ad", "unknown"], description: "business = 業務関連 (発注への返信・注文請書・納期回答・見積・請求・お客様からの依頼など) / ad = 広告・営業・勧誘 / unknown = 判定できない (白紙・読めない)" },
    confidence: { type: "number", description: "判定の信頼度 (0〜1)" },
    reason: { type: "string", description: "判定の理由 (日本語で 1〜2 文)" },
    senderName: { type: "string", description: "送信元の会社名・氏名 (書かれていなければ空文字)" },
    senderFax: { type: "string", description: "送信元の FAX 番号 (FAX のヘッダーや本文に書かれていれば。なければ空文字)" },
    documentType: { type: "string", description: "書類の種類 (例: 注文請書・納期回答・発注書の返信・見積書・請求書・広告。分からなければ空文字)" },
    summary: { type: "string", description: "内容の要約 (日本語で 2〜3 文。納期・数量の回答や欠品の連絡などを含める)" },
    poNumbers: { type: "array", items: { type: "string" }, description: "書かれている発注番号 (PO- で始まる番号。書かれたとおり。なければ空)" },
    orderNumbers: { type: "array", items: { type: "string" }, description: "書かれている案件番号・受注番号 (O- で始まる番号など。書かれたとおり。なければ空)" },
  },
};

const SYSTEM = [
  "あなたは畳・襖・障子・内装の会社 (株式会社一畳屋) の事務担当です。会社の FAX に届いた書類を読み、業務に関係するかを判定し、番号を読み取ります。",
  "当社が仕入先へ送る発注書には「発注番号 PO-年-連番 (例: PO-2026-0012)」と、明細ごとの「案件番号 (例: O-2026-0123)」が印字されています。仕入先はこの発注書に受注確認・納期を書き込んで FAX で返信してきます。",
  "手書き・かすれ・傾きがあっても、番号は 1 文字ずつ丁寧に読んでください。推測で番号を作らないでください。",
  "広告 (不動産・通信回線・セミナー・融資・求人などの営業) は ad、白紙や読めない書類は unknown にしてください。",
].join("\n");

interface AiJson {
  category: FaxAiLabel;
  confidence: number;
  reason: string;
  senderName: string;
  senderFax: string;
  documentType: string;
  summary: string;
  poNumbers: string[];
  orderNumbers: string[];
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => normRef(x)).filter(Boolean))].slice(0, 20);

/** PDF・画像を読んで判定する。失敗しても例外にせず、error を入れた結果を返す */
export async function analyzeFax(input: { bytes: Buffer; contentType: string; fileName: string; text?: string; sender?: string }): Promise<FaxAiResult> {
  const at = new Date().toISOString();
  const fromText = input.text ? findRefs(input.text) : { poNumbers: [], orderNumbers: [] };
  if (!aiEnabled()) {
    return {
      label: "unknown",
      confidence: 0,
      reason: input.text ? "AI が未設定のため、届いた文字から番号だけを読み取りました" : "AI が未設定のため判定していません",
      poNumbers: fromText.poNumbers,
      orderNumbers: fromText.orderNumbers,
      provider: "rules",
      at,
    };
  }
  const isPdf = input.contentType === "application/pdf";
  const isImage = input.contentType.startsWith("image/");
  if (!isPdf && !isImage) return { label: "unknown", confidence: 0, reason: "PDF・画像ではないため判定していません", poNumbers: [], orderNumbers: [], provider: "none", at };
  const base64 = input.bytes.toString("base64");
  const parts: AiPart[] = [
    isPdf ? { type: "pdf", base64, fileName: input.fileName || "fax.pdf" } : { type: "image", mediaType: input.contentType, base64 },
    { type: "text", text: `この FAX を判定し、番号を読み取ってください。${input.sender ? `送信元の番号: ${input.sender}` : "送信元の番号は不明です。"}` },
  ];
  try {
    const r = await generateJson<AiJson>({ system: SYSTEM, parts, schema: SCHEMA, schemaName: "fax_triage", maxTokens: 2000, effort: "low" });
    const d = r.data;
    const label: FaxAiLabel = d.category === "business" || d.category === "ad" ? d.category : "unknown";
    return {
      label,
      confidence: Math.min(1, Math.max(0, Number(d.confidence) || 0)),
      reason: String(d.reason ?? "").slice(0, 300),
      senderName: String(d.senderName ?? "").slice(0, 100) || undefined,
      senderFax: normFax(d.senderFax) || undefined,
      documentType: String(d.documentType ?? "").slice(0, 60) || undefined,
      summary: String(d.summary ?? "").slice(0, 600) || undefined,
      poNumbers: uniq([...(d.poNumbers ?? []).map(String), ...fromText.poNumbers]),
      orderNumbers: uniq([...(d.orderNumbers ?? []).map(String), ...fromText.orderNumbers]),
      provider: r.provider,
      model: r.model,
      at,
    };
  } catch (err) {
    const message = err instanceof AiError ? err.message : "AI の判定に失敗しました";
    console.warn("[fax] AI analysis failed:", (err as Error).message);
    return { label: "unknown", confidence: 0, reason: "AI の判定に失敗しました", poNumbers: fromText.poNumbers, orderNumbers: fromText.orderNumbers, provider: "error", at, error: message };
  }
}
