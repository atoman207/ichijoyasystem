/**
 * チャットの本文の扱い (画面とサーバーで共通。純粋関数)
 * ------------------------------------------------------------
 * - メンションは本文に印で残す: <@社員の ID> / <!all> (@全員) / <!store:店舗の ID> (@合志店 など)。
 *   名前が変わっても正しい人を指し、表示は今の名前で出す (Slack と同じ考え方)
 * - 入力欄では「@山田太郎」のように名前で書き、送るときに encodeMentions で印にする
 * - 受注・見積・問い合わせ・請求書の番号 (O-2026-0012 など) と URL はリンクにする
 */

export interface MentionUser {
  id: string;
  name: string;
}
export interface MentionStore {
  id: string;
  name: string;
}
export interface MentionCtx {
  users: MentionUser[];
  stores: MentionStore[];
  /** @全員 を使える (管理者・本部・店長) */
  allowAll: boolean;
}

export const ALL_TOKEN = "<!all>";
const TOKEN_RE = /<@([A-Za-z0-9_-]+)>|<!all>|<!store:([A-Za-z0-9_-]+)>/g;
/** 案件の番号 (問い合わせ INQ・見積 Q・受注 O・請求書 INV)。古い iPhone の Safari は後読み (?<!) を読めないため \b で区切る */
export const CASE_NUMBER_RE = /\b(?:INQ|INV|Q|O)-\d{4}-\d{4,6}\b/g;
const URL_RE = /https?:\/\/[^\s<>"'（）「」『』、。]+/g;

const squash = (s: string) => s.replace(/[\s　]+/g, "");

/** @ のあとに続けて書ける名前の候補 (長い順。同じ書き方の候補が 2 つあるものは使わない) */
function candidates(ctx: MentionCtx): { text: string; token: string }[] {
  const list: { text: string; token: string }[] = [];
  for (const u of ctx.users) {
    const name = u.name.trim();
    if (!name) continue;
    list.push({ text: name, token: `<@${u.id}>` });
    if (squash(name) !== name) list.push({ text: squash(name), token: `<@${u.id}>` });
  }
  for (const s of ctx.stores) {
    if (s.name.trim()) list.push({ text: s.name.trim(), token: `<!store:${s.id}>` });
  }
  if (ctx.allowAll) {
    list.push({ text: "全員", token: ALL_TOKEN });
    list.push({ text: "all", token: ALL_TOKEN });
  }
  const count = new Map<string, Set<string>>();
  for (const c of list) count.set(c.text, (count.get(c.text) ?? new Set()).add(c.token));
  return list.filter((c) => (count.get(c.text)?.size ?? 0) === 1).sort((a, b) => b.text.length - a.text.length);
}

/** 入力の「@名前」を印にする (知らない名前はそのまま文字で残す) */
export function encodeMentions(text: string, ctx: MentionCtx): string {
  const cands = candidates(ctx);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if ((ch === "@" || ch === "＠") && (i === 0 || !/[A-Za-z0-9._%+-]/.test(text[i - 1]))) {
      const rest = text.slice(i + 1);
      const hit = cands.find((c) => rest.startsWith(c.text));
      if (hit) {
        out += hit.token;
        i += 1 + hit.text.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** 印を「@名前」に戻す (編集の入力欄・プッシュ通知・業務依頼の本文) */
export function decodeMentions(body: string, ctx: Pick<MentionCtx, "users" | "stores">): string {
  return body.replace(TOKEN_RE, (m, uid?: string, sid?: string) => {
    if (uid) return `@${squash(ctx.users.find((u) => u.id === uid)?.name ?? "退職した社員")}`;
    if (sid) return `@${ctx.stores.find((s) => s.id === sid)?.name ?? "店舗"}`;
    return "@全員";
  });
}

/** 本文の印から、メンションした社員・@全員・店舗 */
export function parseMentions(body: string): { userIds: string[]; all: boolean; storeIds: string[] } {
  const userIds = new Set<string>();
  const storeIds = new Set<string>();
  let all = false;
  for (const m of body.matchAll(TOKEN_RE)) {
    if (m[1]) userIds.add(m[1]);
    else if (m[2]) storeIds.add(m[2]);
    else all = true;
  }
  return { userIds: [...userIds], all, storeIds: [...storeIds] };
}

/** 本文の案件の番号 (重複なし) */
export function caseNumbers(body: string): string[] {
  return [...new Set(body.match(CASE_NUMBER_RE) ?? [])];
}

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "user"; id: string }
  | { kind: "all" }
  | { kind: "store"; id: string }
  | { kind: "url"; href: string; text: string }
  | { kind: "case"; href: string; text: string };

/** 表示用に分ける (印・URL・案件の番号。改行は文字のまま返す) */
export function segments(body: string, links: { text: string; href: string }[] = []): Segment[] {
  const out: Segment[] = [];
  const caseHref = new Map(links.map((l) => [l.text, l.href]));
  const pushText = (s: string) => {
    if (!s) return;
    // URL と案件の番号を分ける
    const re = new RegExp(`${URL_RE.source}|${CASE_NUMBER_RE.source}`, "g");
    let last = 0;
    for (const m of s.matchAll(re)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ kind: "text", text: s.slice(last, at) });
      const v = m[0];
      if (/^https?:/.test(v)) {
        // 末尾の句読点・閉じかっこはリンクに含めない
        const trimmed = v.replace(/[.,!?;:)\]]+$/, "");
        out.push({ kind: "url", href: trimmed, text: trimmed });
        if (trimmed.length < v.length) out.push({ kind: "text", text: v.slice(trimmed.length) });
      } else if (caseHref.has(v)) out.push({ kind: "case", href: caseHref.get(v)!, text: v });
      else out.push({ kind: "text", text: v });
      last = at + v.length;
    }
    if (last < s.length) out.push({ kind: "text", text: s.slice(last) });
  };
  let last = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    pushText(body.slice(last, at));
    if (m[1]) out.push({ kind: "user", id: m[1] });
    else if (m[2]) out.push({ kind: "store", id: m[2] });
    else out.push({ kind: "all" });
    last = at + m[0].length;
  }
  pushText(body.slice(last));
  // 続いた文字はまとめる
  const merged: Segment[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (s.kind === "text" && prev?.kind === "text") prev.text += s.text;
    else merged.push(s);
  }
  return merged;
}

/** 1 行の要約 (サイドバー・通知・業務依頼の件名) */
export function preview(body: string, ctx: Pick<MentionCtx, "users" | "stores">, max = 80): string {
  const t = decodeMentions(body, ctx).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 入力中の「@…」(カーソルの直前)。候補を出すために使う */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = before.match(/(^|[^A-Za-z0-9._%+-])[@＠]([^\s@＠]{0,20})$/);
  if (!m) return null;
  const query = m[2];
  return { start: caret - query.length - 1, query };
}

/** 候補の絞り込み (名前・読みの前方一致 → 部分一致) */
export function matchName(query: string, name: string, kana = ""): number {
  const q = squash(query).toLowerCase();
  if (!q) return 1;
  const n = squash(name).toLowerCase();
  const k = squash(kana).toLowerCase();
  if (n.startsWith(q) || k.startsWith(q)) return 3;
  if (n.includes(q) || k.includes(q)) return 2;
  return 0;
}

/** 入力欄に入れるメンションの書き方 (空白を詰めた名前) */
export const mentionText = (name: string) => `@${squash(name)} `;

/** 画面の場所 (/chat の検索パラメーター) を比べるための印。サーバーの初期表示と画面の履歴で同じ書き方にする */
export function chatNavKey(p: { get(k: string): string | null } | Record<string, string | undefined>): string {
  const get = (k: string) => (typeof (p as { get?: unknown }).get === "function" ? (p as { get(k: string): string | null }).get(k) : (p as Record<string, string | undefined>)[k]) ?? "";
  return ["view", "c", "t", "m", "q"].map((k) => `${k}=${get(k)}`).join("&");
}

/* ---------------- 書式 (Slack と同じ書き方: *太字* _斜体_ ~取り消し線~ `コード` ```コードのかたまり``` > 引用 ・箇条書き) ---------------- */

export type Block =
  | { kind: "para"; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string };

const BULLET = /^\s*(?:[-*•]\s+|・\s*)(\S.*)$/;
const ORDERED = /^\s*\d{1,3}[.)．]\s+(.*)$/;
const QUOTE = /^\s*(?:>|＞)\s?(.*)$/;

/** 本文をかたまりに分ける (コード → 引用 → 箇条書き → 段落) */
export function blocks(body: string): Block[] {
  const out: Block[] = [];
  const parts = body.split("```");
  parts.forEach((part, i) => {
    // 奇数番目は ``` で囲まれたコード (閉じていない最後のものは文字のまま)
    if (i % 2 === 1 && i < parts.length - 1) {
      out.push({ kind: "code", text: part.replace(/^\n/, "").replace(/\n$/, "") });
      return;
    }
    let text = i % 2 === 1 ? "```" + part : part;
    // コードのかたまりの前後の改行 1 つは段落にしない
    if (i > 0 && i % 2 === 0) text = text.replace(/^\n/, "");
    if (i % 2 === 0 && i < parts.length - 2) text = text.replace(/\n$/, "");
    if (!text && i > 0) return;
    for (const line of text.split("\n")) {
      const last = out[out.length - 1];
      const q = line.match(QUOTE);
      const b = line.match(BULLET);
      const o = line.match(ORDERED);
      if (q) {
        if (last?.kind === "quote") last.lines.push(q[1]);
        else out.push({ kind: "quote", lines: [q[1]] });
      } else if (b || o) {
        const ordered = Boolean(o && !b);
        const item = (b ?? o)![1];
        if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
        else out.push({ kind: "list", ordered, items: [item] });
      } else if (last?.kind === "para") last.lines.push(line);
      else out.push({ kind: "para", lines: [line] });
    }
  });
  // 前後の空の段落を除く
  return out.filter((b, i) => !(b.kind === "para" && b.lines.every((l) => !l.trim()) && (i === 0 || i === out.length - 1)));
}

export type Inline = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };

// 後読み (?<=) は古い iPhone の Safari で読めないため使わない。斜体の前の文字は (前の文字) で受けて、文字として戻す
const INLINE_RE = /`([^`\n]+)`|\*([^*\n]+)\*|(^|[\s(（「『、。])_([^_\n]+)_(?=$|[\s)）」』、。!?！？])|~([^~\n]+)~/g;

/** 1 行の中の書式 (コード・太字・斜体・取り消し線)。入れ子は 1 段だけ */
export function inlines(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    const lead = m[3] ?? "";
    if (at + lead.length > last) out.push({ text: text.slice(last, at) + lead });
    if (m[1] !== undefined) out.push({ text: m[1], code: true });
    else if (m[2] !== undefined) out.push({ text: m[2], bold: true });
    else if (m[4] !== undefined) out.push({ text: m[4], italic: true });
    else if (m[5] !== undefined) out.push({ text: m[5], strike: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.filter((x) => x.text);
}
