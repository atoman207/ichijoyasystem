import type { Database, DocOutput, DocOutputKind, StoreId } from "@/lib/db/types";

/**
 * 帳票の出力記録 (お客様のご要望 2026-11-25「⑥ 予定表の案件からの帳票出力」)
 * ------------------------------------------------------------
 * 見積書・請求書・領収書の PDF を出力するたびに 1 行 (出力日時・出力者・対象の案件・帳票の種類・何回目)。
 * 帳票の出力は記録を見られる社員なら誰でもできる (金額・請求内容・入金を変える権限とは別)。2 回目からは再発行として数え、
 * 領収書の PDF には「再発行」と印字する。同じ人が同じ帳票を 3 分以内に開き直したとき (PDF の表示の読み直し・保存) は 1 回と数える。
 * import は型だけ (mutate の中で呼ぶ。画面の一覧と共通)
 */

export const DOC_OUTPUT_KIND_LABEL: Record<DocOutputKind, string> = { quote: "見積書", invoice: "請求書", receipt: "領収書" };
export const DOC_OUTPUT_VIA_LABEL: Record<DocOutput["via"], string> = { view: "画面で表示・印刷", download: "保存", batch: "まとめて印刷" };

const SAME_WINDOW_MS = 3 * 60 * 1000;

/** その帳票のこれまでの出力 (古い順)。見積は版ごと、納品書 (doc = delivery) は請求書と別に数える */
export function outputsOf(db: Pick<Database, "docOutputs">, kind: DocOutputKind, refId: string, version?: number, doc?: DocOutput["doc"]): DocOutput[] {
  return (db.docOutputs ?? []).filter((o) => o.kind === kind && o.refId === refId && (version === undefined || o.version === version) && (o.doc ?? "") === (doc ?? "")).sort((a, b) => a.at.localeCompare(b.at));
}

/** 出力記録の帳票の名前 (納品書は doc = delivery) */
export const outputLabel = (o: Pick<DocOutput, "kind" | "doc">): string => (o.doc === "delivery" ? "納品書" : DOC_OUTPUT_KIND_LABEL[o.kind]);

export interface OutputInput {
  kind: DocOutputKind;
  refId: string;
  number: string;
  version?: number;
  storeId: StoreId;
  customerId?: string;
  orderId?: string;
  via: DocOutput["via"];
  doc?: DocOutput["doc"];
}

/**
 * 出力を記録して、何回目か (0 = 最初、1 以上 = 再発行) を返す。直前の同じ人の出力 (3 分以内) なら記録を増やさない。
 * mutate の中で呼ぶ
 */
export function recordOutput(db: Database, userId: string, input: OutputInput, now: Date, newId: () => string): { reissue: number; output: DocOutput } {
  db.docOutputs ??= [];
  const past = outputsOf(db, input.kind, input.refId, input.kind === "quote" ? input.version : undefined, input.doc);
  const last = past.at(-1);
  if (last && last.userId === userId && now.getTime() - Date.parse(last.at) < SAME_WINDOW_MS && last.via !== "batch" && input.via !== "batch") return { reissue: last.reissue, output: last };
  const output: DocOutput = { id: newId(), kind: input.kind, refId: input.refId, number: input.number, ...(input.version !== undefined ? { version: input.version } : {}), storeId: input.storeId, ...(input.customerId ? { customerId: input.customerId } : {}), ...(input.orderId ? { orderId: input.orderId } : {}), at: now.toISOString(), userId, reissue: past.length, via: input.via, ...(input.doc ? { doc: input.doc } : {}) };
  db.docOutputs.push(output);
  return { reissue: output.reissue, output };
}

/** 画面の一覧用: 帳票ごとの出力の回数・最後の出力 */
export function outputSummary(db: Pick<Database, "docOutputs" | "users">, kind: DocOutputKind, refId: string): { count: number; last?: DocOutput; lastBy?: string } {
  const list = outputsOf(db, kind, refId);
  const last = list.at(-1);
  return { count: list.length, last, lastBy: last ? db.users.find((u) => u.id === last.userId)?.name : undefined };
}
