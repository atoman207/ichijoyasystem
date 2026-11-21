import "server-only";
import { askChatbot } from "./answer";
import type { AskFn, EvalRunners } from "./eval";
import { recordDigest, summarizeDigest } from "@/lib/ai/summary";
import { SECTIONS_BY_KIND, SUMMARY_KIND_LABEL, type SummaryKind, type SummarySection } from "@/lib/ai/summary-sections";
import { DRAFT_FORMAT_LABEL, DRAFT_TEMPLATES, draftDocument, type DraftFormat, type DraftTemplate } from "@/lib/ai/draft";

/**
 * 精度の評価で実際に呼ぶ処理 (画面の「評価を実行」・定期実行・デプロイのあとの評価で共通)
 * - ask: 「質問する」(askChatbot を評価の扱いで: 相談の履歴・蓄えた回答・1 時間の上限に触れない)
 * - summarize: 記録の要約 (画面の「AI で要約」と同じ recordDigest → summarizeDigest。閲覧範囲は聞く人)
 * - draft: 文書の作成 (画面の「文書の作成」と同じ draftDocument。保存はしない)
 */

export const evalAsk: AskFn = async (db, user, history, question) => {
  const r = await askChatbot(db, user, history.map((h) => ({ role: h.role, content: h.content, specs: h.specs as never })), question, { evaluation: true });
  return { answer: r.answer, tools: r.tools, sources: r.sources, source: r.source, checks: r.checks, tables: r.tables };
};

export const evalRunners: EvalRunners = {
  summarize: async (db, user, input) => {
    if (!(input.kind in SUMMARY_KIND_LABEL)) return { ok: false, text: "", sources: [], message: `要約できない種類です (${input.kind})` };
    const kind = input.kind as SummaryKind;
    const sections = (input.sections ?? []).filter((s): s is SummarySection => (SECTIONS_BY_KIND[kind] as string[]).includes(s));
    const d = recordDigest(db, user, kind, input.id, { from: input.from, to: input.to, sections });
    if (!d) return { ok: false, text: "", sources: [], message: "記録が見つからないか、閲覧する権限がありません。" };
    const r = await summarizeDigest(d);
    return { ok: r.ok, text: r.text, sources: r.sources, record: r.record, message: r.message, provider: r.provider };
  },
  draft: async (db, user, input) => {
    if (!(input.template in DRAFT_TEMPLATES) || !(input.format in DRAFT_FORMAT_LABEL)) return { ok: false, text: "", message: "ひな形・形式が分かりません。" };
    const r = await draftDocument(db, user, { template: input.template as DraftTemplate, format: input.format as DraftFormat, ref: input.ref, notes: input.notes });
    return { ok: r.ok, text: r.text, used: r.used, message: r.message, provider: r.provider };
  },
};
