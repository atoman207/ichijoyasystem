/**
 * トースト (画面の上に少しのあいだ出る知らせ。2026-11-26)
 * ------------------------------------------------------------
 * - 画面の操作の結果 (Server Action の redirect の ?msg= / ?err=) は、AppShell の Toaster が URL から読んでトーストにする
 *   (showResult。読んだら URL から外す = 読み込み直しで二度出さない)。画面に <Flash> を書かなくても出る
 * - 画面の中の部品 (クライアント) は toast.success("…") / toast.error("…") / toast.info / toast.warn で出す
 * - 新しく届いた通知 (ヘッダーのベル・チャット) は toast.notice (「通知」。AppShell・ChatLive。開く画面のボタンつき)。
 *   style = 通知の種類 (承認・請求・予定・LINE・メールなど。./notice-style.ts の NoticeStyleKey) で、種類ごとに色・アイコン・ラベルを変える
 *   (お客様のご要望 2026-11-26「トーストは通知ごとに違う色で」。ベルの行と同じ色)
 * - 画面の右上 (ヘッダーのベルの下) に新しいものから並べる (スマートフォンは上に横いっぱい)
 * - 色 + ラベル (完了・エラー・お知らせ・注意・通知) + アイコンで表す (色だけに意味を持たせない)
 * - 完了・お知らせ・注意は文の長さに合わせて 4〜12 秒、通知は 8〜15 秒で消える (マウスを乗せる・押さえている・別のタブのあいだは止まる)。
 *   エラーは閉じるまで残す (読んでから閉じる。別の画面へ移ったら閉じる)
 * - 同じ知らせが続いたら 1 つにまとめて「×2」。一度に出すのは 4 つまで
 * React を使わない (Toaster.tsx が useSyncExternalStore で読む)。テストは npm run test:notify (toast.test.mjs)
 */

import { splitMsgLink } from "@/lib/msg-link";

export type ToastTone = "success" | "error" | "info" | "warn" | "notice";

export interface ToastAction {
  label: string;
  /** 押したら開く画面 (同じサイトの中) */
  href?: string;
  onClick?: () => void;
}

export interface ToastOptions {
  /** ラベル (既定: 完了・エラー・お知らせ・注意・通知) */
  title?: string;
  /** 本文の下の小さな文 (通知の詳しい内容など) */
  detail?: string;
  /** 消えるまでのミリ秒 / "sticky" = 閉じるまで残す (既定は toastDuration) */
  duration?: number | "sticky";
  action?: ToastAction;
  /** 同じ group の新しい知らせが来たら、前の知らせを閉じる ("result" = 画面の操作の結果) */
  group?: string;
  /** まとめて閉じるための印 (group と違い、前の知らせを閉じない。例: ベルを開いたらベルの通知を閉じる) */
  tag?: string;
  /** 通知の種類 (tone = notice のときの色・アイコン・ラベル。./notice-style.ts の NoticeStyleKey) */
  style?: string;
}

export interface ToastItem {
  id: string;
  tone: ToastTone;
  text: string;
  title?: string;
  detail?: string;
  duration: number | "sticky";
  action?: ToastAction;
  group?: string;
  tag?: string;
  style?: string;
  /** 同じ知らせが何回続いたか */
  count: number;
  /** まとめたたびに増える (消えるまでの時間を数え直す) */
  bump: number;
  /** 出したときの画面 (エラーは別の画面へ移ったら閉じる) */
  path: string;
}

export const TOAST_LABEL: Record<ToastTone, string> = { success: "完了", error: "エラー", info: "お知らせ", warn: "注意", notice: "通知" };
export const MAX_TOASTS = 4;
/** 画面の操作の結果 (URL の msg・err) の group */
export const RESULT_GROUP = "result";

/** 消えるまでの時間: 完了 4 秒・お知らせ / 注意 6 秒 + 1 文字 80 ミリ秒 (12 秒まで)・通知 8 秒 + 1 文字 80 ミリ秒 (15 秒まで)。エラーは閉じるまで */
export function toastDuration(tone: ToastTone, text: string): number | "sticky" {
  if (tone === "error") return "sticky";
  const len = [...text].length * 80;
  if (tone === "notice") return Math.min(15000, 8000 + len);
  const base = tone === "success" ? 4000 : 6000;
  return Math.min(12000, base + len);
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
/** URL (msg・err) から出した文 (Flash が同じ文を画面の中に重ねて出さないため) */
const fromUrl = new Set<string>();

function emit() {
  for (const l of listeners) l();
}

export function subscribeToasts(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getToasts(): ToastItem[] {
  return items;
}

const NONE: ToastItem[] = [];
export function getServerToasts(): ToastItem[] {
  return NONE;
}

const currentPath = () => (typeof window === "undefined" ? "" : window.location.pathname);

/** 4 つを超えたら、消える知らせの古いものから外す (エラーはなるべく残す) */
function trim(list: ToastItem[]): ToastItem[] {
  const out = [...list];
  while (out.length > MAX_TOASTS) {
    let i = -1;
    for (let k = out.length - 1; k >= 0; k--) {
      if (out[k].duration !== "sticky") {
        i = k;
        break;
      }
    }
    out.splice(i < 0 ? out.length - 1 : i, 1);
  }
  return out;
}

/** replaceGroup = false: 同じ group の前の知らせを閉じない (showResult が先に閉じる) */
function add(list: ToastItem[], tone: ToastTone, text: string, opts: ToastOptions, replaceGroup = true): { list: ToastItem[]; id: string } {
  const same = list.find((i) => i.tone === tone && i.text === text && (i.title ?? "") === (opts.title ?? "") && (i.style ?? "") === (opts.style ?? ""));
  if (same) {
    const bumped: ToastItem = { ...same, count: same.count + 1, bump: same.bump + 1, detail: opts.detail ?? same.detail, action: opts.action ?? same.action, path: currentPath() };
    return { list: [bumped, ...list.filter((i) => i !== same)], id: same.id };
  }
  const id = `t${++seq}`;
  const item: ToastItem = { id, tone, text, title: opts.title, detail: opts.detail?.trim() || undefined, duration: opts.duration ?? toastDuration(tone, `${text}${opts.detail ?? ""}`), action: opts.action, group: opts.group, tag: opts.tag, style: opts.style, count: 1, bump: 0, path: currentPath() };
  const rest = opts.group && replaceGroup ? list.filter((i) => i.group !== opts.group) : list;
  return { list: trim([item, ...rest]), id };
}

/** トーストを出す (返り値 = ID。toast.dismiss(ID) で閉じる) */
export function toast(text: string, opts: ToastOptions & { tone?: ToastTone } = {}): string {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const r = add(items, opts.tone ?? "info", t, opts);
  items = r.list;
  emit();
  return r.id;
}
toast.success = (text: string, opts: ToastOptions = {}) => toast(text, { ...opts, tone: "success" });
toast.error = (text: string, opts: ToastOptions = {}) => toast(text, { ...opts, tone: "error" });
toast.info = (text: string, opts: ToastOptions = {}) => toast(text, { ...opts, tone: "info" });
toast.warn = (text: string, opts: ToastOptions = {}) => toast(text, { ...opts, tone: "warn" });
/** 新しく届いた通知 (ヘッダーのベル・チャット) */
toast.notice = (text: string, opts: ToastOptions = {}) => toast(text, { ...opts, tone: "notice" });
/** 印 (tag) の付いた知らせをまとめて閉じる */
toast.dismissTag = (tag: string) => {
  const next = items.filter((i) => i.tag !== tag);
  if (next.length === items.length) return;
  items = next;
  emit();
};
/** ID を渡せばその知らせ、渡さなければすべてを閉じる */
toast.dismiss = (id?: string) => {
  const next = id ? items.filter((i) => i.id !== id) : [];
  if (next.length === items.length) return;
  items = next;
  emit();
};

/**
 * 画面の操作の結果 (URL の ?msg= / ?err=) を出す。前の結果の知らせは閉じる (直して保存し直したら、前のエラーを残さない)。
 * 同じ回の msg と err は両方出す
 */
export function showResult(msg?: string | null, err?: string | null): void {
  // 文の最後の「[[ボタン]](/場所)」はボタンにする (src/lib/msg-link.ts。例: 日程の登録のあとの「予定表で確認」)
  const parsed = msg ? splitMsgLink(msg.trim()) : undefined;
  const m = parsed?.text.trim();
  const e = err?.trim();
  if (!m && !e) return;
  let list = items.filter((i) => i.group !== RESULT_GROUP || i.text === m || i.text === e);
  if (msg) fromUrl.add(msg.trim());
  if (m) {
    fromUrl.add(m);
    const link = parsed?.link;
    // ボタンのある知らせは長めに出す (押す時間をとる)
    list = add(list, "success", m, { group: RESULT_GROUP, ...(link ? { action: { label: link.label, href: link.href }, duration: Math.max(12000, Number(toastDuration("success", m))) } : {}) }, false).list;
  }
  if (e) {
    fromUrl.add(e);
    list = add(list, "error", e, { group: RESULT_GROUP }, false).list;
  }
  items = list;
  emit();
}

/** この文を URL の結果としてトーストに出したか (Flash が画面の中に同じ文を重ねないため) */
export function shownFromUrl(text: string | undefined): boolean {
  return Boolean(text && fromUrl.has(text.trim()));
}

/** 別の画面へ移ったら、前の画面で出した閉じるまで残る知らせ (エラー) を閉じる */
export function closeStickyElsewhere(path: string): void {
  const next = items.filter((i) => i.duration !== "sticky" || i.path === path);
  if (next.length === items.length) return;
  items = next;
  emit();
}

/** テスト用: すべてを消して最初の状態に戻す */
export function resetToasts(): void {
  items = [];
  seq = 0;
  fromUrl.clear();
  emit();
}
