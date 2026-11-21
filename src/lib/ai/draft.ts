import "server-only";
import type { Database, User } from "@/lib/db/types";
import { documentSettings } from "@/lib/doc-settings";
import { canViewKnowledge, scopeByStore } from "@/lib/auth/permissions";
import { AiError, aiEnabled, generateText } from "./provider";
import { plainText, recordFacts, type RecordFacts } from "./summary";
import { searchKnowledge } from "@/lib/knowledge";

/**
 * 資料・報告文の作成の補助
 * ------------------------------------------------------------
 * ひな形 (お客様向けの案内・社内の報告など) と、関係する記録 (見積・受注・問い合わせ・請求・顧客の番号) と要点から、
 * AI が下書きを作る。キーがないときは、ひな形に記録の内容を差し込んだ定型文を返す。
 * 作った文面は画面で「下書きとして保存」すると文書の下書き (src/lib/doc-drafts.ts) になり、確認 → 承認 → 送信 まで管理できる
 */

export type DraftTemplate = "quote_send" | "schedule" | "complete_report" | "payment_request" | "apology" | "daily_report" | "work_report" | "meeting_memo" | "free";

export const DRAFT_TEMPLATES: Record<DraftTemplate, { label: string; audience: "customer" | "internal"; hint: string }> = {
  quote_send: { label: "見積書送付のご案内", audience: "customer", hint: "見積の内容 (件名・金額・有効期限) を伝え、ご不明点の問い合わせ先を添える" },
  schedule: { label: "施工日程のご連絡", audience: "customer", hint: "引取・施工・納品の日時と、当日のお願い (家具の移動・駐車場所など) を伝える" },
  complete_report: { label: "施工完了のご報告・お礼", audience: "customer", hint: "施工が完了したことの報告とお礼、お手入れの注意、アンケートのお願い" },
  payment_request: { label: "ご入金のお願い", audience: "customer", hint: "請求の金額・期限・振込先を丁寧に伝える。期限を過ぎていれば確認のお願いとして書く" },
  apology: { label: "お詫び・経緯のご報告", audience: "customer", hint: "起きたこと・原因・対応・再発防止を、言い訳にならないよう簡潔に" },
  daily_report: { label: "日報", audience: "internal", hint: "本日の作業・訪問・明日の予定・課題を箇条書きで" },
  work_report: { label: "施工報告書 (元請・社内向け)", audience: "internal", hint: "現場・作業内容・数量・使用材料・特記事項・写真の有無" },
  meeting_memo: { label: "打合せ記録", audience: "internal", hint: "日時・参加者・決まったこと・宿題 (担当・期限)" },
  free: { label: "自由に作成", audience: "internal", hint: "要点の欄に書いた依頼のとおりに作る" },
};

export type DraftFormat = "email" | "line" | "document";
export const DRAFT_FORMAT_LABEL: Record<DraftFormat, string> = { email: "メール", line: "LINE (短め)", document: "文書・報告書" };

export interface DraftInput {
  template: DraftTemplate;
  format: DraftFormat;
  /** 関係する記録の番号 (O-2026-0012・Q-…・INQ-…・INV-…・C-00012) */
  ref?: string;
  notes?: string;
}

export interface DraftResult {
  ok: boolean;
  text: string;
  provider: "claude" | "openai" | "rules";
  message?: string;
  /** 参照した記録 */
  used?: { label: string; href: string };
}

/** 番号から記録を探して事実を集める (閲覧できる記録だけ) */
export function factsByRef(db: Database, user: User, ref: string): RecordFacts | null {
  const r = ref.normalize("NFKC").trim().toUpperCase();
  if (!r) return null;
  const q = scopeByStore(user, db.quotes).find((x) => x.number.toUpperCase() === r);
  if (q) return recordFacts(db, user, "quote", q.id);
  const o = scopeByStore(user, db.orders).find((x) => x.number.toUpperCase() === r);
  if (o) return recordFacts(db, user, "order", o.id);
  const i = scopeByStore(user, db.inquiries).find((x) => x.number.toUpperCase() === r);
  if (i) return recordFacts(db, user, "inquiry", i.id);
  const inv = scopeByStore(user, db.invoices).find((x) => x.number.toUpperCase() === r);
  if (inv) {
    const f = recordFacts(db, user, "order", inv.orderId);
    const line = `請求 ${inv.number}: 請求日 ${inv.issueDate} / 支払期限 ${inv.dueDate} / 合計 ${inv.total} 円 / 入金済 ${inv.paidAmount} 円 / 残 ${inv.total - inv.paidAmount} 円`;
    return f ? { ...f, label: `請求 ${inv.number}`, href: `/invoices/${inv.id}`, facts: `${line}\n${f.facts}` } : { kind: "order", label: `請求 ${inv.number}`, href: `/invoices/${inv.id}`, head: [line], facts: line };
  }
  const c = scopeByStore(user, db.customers).find((x) => x.code.toUpperCase() === r);
  if (c) return recordFacts(db, user, "customer", c.id);
  return null;
}

function companyBlock(db: Database, user: User): string {
  const d = documentSettings(db);
  const store = db.stores.find((s) => s.id === user.storeId);
  return [`会社: ${d.companyName || "株式会社一畳屋"}`, store ? `店舗: ${store.name} (${store.phone ?? d.tel})` : `電話: ${d.tel}`, d.email ? `メール: ${d.email}` : "", `作成者: ${user.name}`, d.bankAccounts?.length ? `振込先: ${d.bankAccounts.map((b) => [b.bank, b.branch, b.type, b.number, b.holder].filter(Boolean).join(" ")).join(" / ")}` : ""].filter(Boolean).join("\n");
}

/** キーがないときの定型文 */
function rulesDraft(db: Database, user: User, input: DraftInput, f: RecordFacts | null): string {
  const t = DRAFT_TEMPLATES[input.template];
  const d = documentSettings(db);
  const store = db.stores.find((s) => s.id === user.storeId);
  const sign = `${d.companyName || "株式会社一畳屋"}${store ? ` ${store.name}` : ""}\n${user.name}${store?.phone ? `\nTEL ${store.phone}` : d.tel ? `\nTEL ${d.tel}` : ""}`;
  const head = f ? f.head.map((h) => `・${h}`).join("\n") : "";
  if (t.audience === "internal") return [`【${t.label}】 ${new Date().toLocaleDateString("ja-JP")} ${user.name}`, "", head || "・(内容)", input.notes ? `\n${input.notes}` : "", "", "以上"].filter((x) => x !== undefined).join("\n");
  const body: Record<string, string> = {
    quote_send: "このたびはお問い合わせいただき、誠にありがとうございます。\nご依頼いただきました内容のお見積書をお送りいたします。",
    schedule: "このたびはご依頼いただき、誠にありがとうございます。\n施工の日程についてご連絡いたします。",
    complete_report: "このたびはご依頼いただき、誠にありがとうございました。\n本日、施工が完了いたしましたのでご報告いたします。",
    payment_request: "いつもお世話になっております。\nご請求の件についてご連絡いたします。",
    apology: "このたびはご迷惑をおかけし、誠に申し訳ございません。\n経緯と今後の対応についてご報告いたします。",
    free: "",
  };
  return [`○○ 様`, "", body[input.template] ?? "", head ? `\n${head}` : "", input.notes ? `\n${input.notes}` : "", "", "ご不明な点がございましたら、お気軽にお問い合わせください。", "", sign].join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function draftDocument(db: Database, user: User, input: DraftInput): Promise<DraftResult> {
  const t = DRAFT_TEMPLATES[input.template];
  const f = input.ref ? factsByRef(db, user, input.ref) : null;
  if (input.ref && !f) return { ok: false, text: "", provider: "rules", message: `番号「${input.ref}」の記録が見つかりません (閲覧できる店舗の見積・受注・問い合わせ・請求・顧客コードを入力してください)。` };
  const used = f ? { label: f.label, href: f.href } : undefined;
  if (!aiEnabled()) return { ok: true, text: rulesDraft(db, user, input, f), provider: "rules", used, message: "AI の API キーが未設定のため、ひな形に記録の内容を差し込んだ定型文です。" };
  // 社内資料は作る人が見られるものだけ (見られる人の設定。店舗のロールに本部向けの資料を使わない)
  const knowledge = searchKnowledge(db.knowledge.filter((k) => canViewKnowledge(user, k)), `${t.label} ${input.notes ?? ""}`, { limit: 3 });
  try {
    const r = await generateText({
      system: [
        "あなたは株式会社一畳屋 (熊本の畳・襖・障子・網戸の専門店) の文書作成の担当です。",
        `作るもの: ${t.label} (${t.audience === "customer" ? "お客様向け" : "社内・取引先向け"}) / 形式: ${DRAFT_FORMAT_LABEL[input.format]}`,
        `書き方: ${t.hint}`,
        input.format === "line" ? "LINE なので 200 文字前後で、改行を使って読みやすく。件名は不要。" : input.format === "email" ? "1 行目に「件名: 」を書き、本文はメールの形 (宛名・挨拶・本文・署名) で。" : "見出しと箇条書きを使った文書の形で。",
        "記録にない金額・日付・約束は書かず、分からないところは【 】で空欄にしてください。丁寧で自然な日本語にしてください。",
        "そのまま貼り付けて使うため、Markdown の記号 (#・**・-) は使わず、見出しは【 】、箇条書きは「・」にしてください。",
        "",
        companyBlock(db, user),
        knowledge.length ? `\n社内資料 (参考):\n${knowledge.map((k) => `- ${k.entry.title}: ${k.entry.body.slice(0, 600)}`).join("\n")}` : "",
      ].join("\n"),
      messages: [{ role: "user", content: [f ? `関係する記録 (${f.label}):\n${f.facts.slice(0, 8000)}` : "関係する記録: なし", input.notes ? `\n要点・依頼:\n${input.notes}` : ""].join("\n") }],
      maxTokens: 2000,
    });
    return { ok: true, text: plainText(r.data), provider: r.provider, used };
  } catch (err) {
    const message = err instanceof AiError ? err.message : (err as Error).message;
    return { ok: true, text: rulesDraft(db, user, input, f), provider: "rules", used, message: `AI で作成できなかったため、定型文を表示しています (${message})` };
  }
}
