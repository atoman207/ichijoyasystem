"use client";

/**
 * チャットの画面の共通 (時刻の表示・通知音・プッシュ通知の登録・API の呼び出し)
 */

import type { ChatFile } from "@/lib/chat/types";

/* ---------------- 時刻 (日本時間) ---------------- */

const JST = 9 * 3600_000;
const jst = (iso: string) => new Date(Date.parse(iso) + JST);
export const dayKey = (iso: string) => jst(iso).toISOString().slice(0, 10);
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

export function timeLabel(iso: string): string {
  const d = jst(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function dayLabel(iso: string): string {
  const d = jst(iso);
  const today = dayKey(new Date().toISOString());
  const k = d.toISOString().slice(0, 10);
  const yesterday = dayKey(new Date(Date.now() - 86400_000).toISOString());
  const md = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 (${WEEK[d.getUTCDay()]})`;
  if (k === today) return `今日 · ${md}`;
  if (k === yesterday) return `昨日 · ${md}`;
  return k.slice(0, 4) === today.slice(0, 4) ? md : `${d.getUTCFullYear()}年${md}`;
}

/** 一覧の短い日時 (今日は時刻、それ以外は月/日) */
export function shortWhen(iso?: string): string {
  if (!iso) return "";
  if (dayKey(iso) === dayKey(new Date().toISOString())) return timeLabel(iso);
  const d = jst(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function fullWhen(iso: string): string {
  const d = jst(iso);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} (${WEEK[d.getUTCDay()]}) ${timeLabel(iso)}`;
}

export function dueLabel(iso?: string): string {
  if (!iso) return "";
  const d = jst(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${timeLabel(iso)}`;
}

export function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const fileUrl = (messageId: string, f: Pick<ChatFile, "id">, opts: { thumb?: boolean; download?: boolean } = {}) =>
  `/api/chat/files/${encodeURIComponent(messageId)}/${encodeURIComponent(f.id)}${opts.thumb ? "?size=thumb" : opts.download ? "?download=1" : ""}`;

/* ---------------- API ---------------- */

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error || `通信に失敗しました (${res.status})`);
  return j;
}

/* ---------------- 通知音 (Web Audio。音のファイルを使わない) ---------------- */

let ctx: AudioContext | null = null;
let unlocked = false;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  return ctx;
}

/** ブラウザーの決まりで、画面を一度押すまで音を出せない。最初の操作で音を出せる状態にする */
export function unlockAudioOnce() {
  if (typeof window === "undefined" || unlocked) return;
  const go = () => {
    const a = audio();
    if (a && a.state === "suspended") void a.resume();
    unlocked = true;
    window.removeEventListener("pointerdown", go);
    window.removeEventListener("keydown", go);
  };
  window.addEventListener("pointerdown", go, { passive: true });
  window.addEventListener("keydown", go);
}

function tone(a: AudioContext, freq: number, start: number, dur: number, gain: number) {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = "sine";
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(a.destination);
  o.start(start);
  o.stop(start + dur + 0.02);
}

/** priority = 自分あて (2 音・はっきり)、normal = 通常のメッセージ (1 音・控えめ) */
export function playChime(kind: "priority" | "normal") {
  const a = audio();
  if (!a) return;
  if (a.state === "suspended") void a.resume().catch(() => undefined);
  const t = a.currentTime + 0.02;
  if (kind === "priority") {
    tone(a, 880, t, 0.22, 0.22);
    tone(a, 1318.5, t + 0.16, 0.34, 0.2);
  } else {
    tone(a, 1046.5, t, 0.28, 0.12);
  }
}

/* ---------------- アプリのアイコンの数字 (ホーム画面に追加したアプリ) ---------------- */

export function setAppBadge(n: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (n > 0) void nav.setAppBadge?.(n)?.catch(() => undefined);
    else void nav.clearAppBadge?.()?.catch(() => undefined);
  } catch {
    // 対応していないブラウザー
  }
}

/* ---------------- プッシュ通知 ---------------- */

export type PushState = "unsupported" | "ios-home" | "denied" | "off" | "on";

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    return (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
  } catch {
    return null;
  }
}

/** この端末のプッシュ通知の状態 */
export async function pushState(): Promise<{ state: PushState; endpoint?: string }> {
  if (typeof window === "undefined") return { state: "unsupported" };
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
  if (!supported) return { state: isIos() && !isStandalone() ? "ios-home" : "unsupported" };
  if (Notification.permission === "denied") return { state: "denied" };
  const reg = await swRegistration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (!sub || Notification.permission !== "granted") return { state: "off" };
  return { state: "on", endpoint: sub.endpoint };
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 「この端末で通知を受け取る」: 許可を取り、配信先をサーバーに登録する (押したときに呼ぶ。iPhone は画面の操作の中でないと許可を聞けない) */
export async function enablePush(vapidKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!vapidKey) return { ok: false, error: "このサーバーではプッシュ通知を使えません。" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, error: isIos() && !isStandalone() ? "iPhone・iPad は、Safari の「共有 → ホーム画面に追加」で追加したアプリから開くと通知を受け取れます。" : "このブラウザーはプッシュ通知に対応していません。" };
  }
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, error: "通知が許可されませんでした。端末 (ブラウザー) の設定で、このサイトの通知を「許可」にしてください。" };
  const reg = await swRegistration();
  if (!reg) return { ok: false, error: "通知の準備ができませんでした (サービスワーカー)。ページを読み込み直してお試しください。" };
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // 鍵が変わっていたら登録し直す
  const want = keyBytes(vapidKey);
  const have = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && have && (have.length !== want.length || have.some((b, i) => b !== want[i]))) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  } catch (err) {
    return { ok: false, error: `通知の登録に失敗しました (${err instanceof Error ? err.message : "原因不明"})。` };
  }
  const res = await fetch("/api/chat/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), ua: navigator.userAgent }) });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) return { ok: false, error: j.error || "通知の登録をサーバーに保存できませんでした。" };
  return { ok: true };
}

export async function disablePush(): Promise<void> {
  const reg = await swRegistration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (!sub) return;
  await fetch("/api/chat/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

/** チャットのアイコンとチャットの画面が、数字を新しくするための合図 */
export const CHAT_REFRESH_EVENT = "ichijoya-chat-refresh";
export function signalChatRefresh() {
  window.dispatchEvent(new Event(CHAT_REFRESH_EVENT));
}
