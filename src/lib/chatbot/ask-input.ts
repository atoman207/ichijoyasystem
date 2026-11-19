import type { AnalysisSpec } from "@/lib/assistant/analyze";
import type { ChatTurn } from "./answer";

/**
 * 画面から送られた会話の履歴を、知っている形だけにして受け取る
 * (チャットボットの Server Action `askChatbotAction` と、途中の知らせを送る `/api/assistant/ask` で共通)
 */

/** 集計の条件 (画面から戻ってきたもの) を、知っている項目だけにして受け取る */
export function cleanSpecs(v: unknown): AnalysisSpec[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AnalysisSpec[] = [];
  for (const x of v.slice(0, 4)) {
    if (!x || typeof x !== "object") continue;
    try {
      const j = JSON.parse(JSON.stringify(x).slice(0, 3000)) as AnalysisSpec;
      out.push(j);
    } catch {
      /* 壊れた条件は使わない */
    }
  }
  return out.length ? out : undefined;
}

/** 直近 8 件の発言 (集計の条件はログインした人だけ引き継ぐ) */
export function cleanTurns(history: unknown, loggedIn: boolean): ChatTurn[] {
  return (Array.isArray(history) ? (history as Partial<ChatTurn>[]) : [])
    .filter((h): h is ChatTurn => Boolean(h) && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
    .slice(-8)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 3000), specs: loggedIn && h.role === "assistant" ? cleanSpecs(h.specs) : undefined }));
}
