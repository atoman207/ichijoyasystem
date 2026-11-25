/**
 * ヘッダーの数字の「確認済み」の記録をブラウザー (localStorage) に持つ小さな入れ物 (AppShell の useSyncExternalStore で読む)。
 * キーの決め方と画面の対応は src/lib/notify-seen.ts。
 *
 * - 確認した順に保存し、多すぎるときは古いものから捨てる (MAX 件)
 * - ほかのタブで確認したら storage のイベントで読み直す (同じ人のタブは同じ数字)
 * - localStorage が使えない環境 (プライベートブラウズの一部など) は、この画面を開いている間だけメモリに持つ
 */

const MAX = 3000;
const listeners = new Map<string, Set<() => void>>();
const cache = new Map<string, { list: string[]; set: ReadonlySet<string> }>();
const memory = new Map<string, string>();

function parse(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function load(key: string): { list: string[]; set: ReadonlySet<string> } {
  let raw: string | null | undefined;
  try {
    raw = localStorage.getItem(key);
  } catch {
    raw = memory.get(key);
  }
  const list = parse(raw);
  const entry = { list, set: new Set(list) as ReadonlySet<string> };
  cache.set(key, entry);
  return entry;
}

/** いまの確認済み (同じ内容なら同じ Set を返す) */
export function seenSnapshot(key: string): ReadonlySet<string> {
  return (cache.get(key) ?? load(key)).set;
}

export function subscribeSeen(key: string, onChange: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== key) return;
    load(key);
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** 確認済みにする (すでに確認済みなら何もしない) */
export function addSeen(key: string, keys: readonly string[]): void {
  const cur = cache.get(key) ?? load(key);
  const add = [...new Set(keys)].filter((k) => !cur.set.has(k));
  if (!add.length) return;
  const list = [...cur.list, ...add].slice(-MAX);
  cache.set(key, { list, set: new Set(list) });
  const raw = JSON.stringify(list);
  try {
    localStorage.setItem(key, raw);
  } catch {
    memory.set(key, raw);
  }
  for (const fn of listeners.get(key) ?? []) fn();
}

/** 以前の既読の保存 (通知の文面ごと。2026-11-26 まで) を消す */
export function dropLegacyRead(userId: string): void {
  try {
    localStorage.removeItem(`ichijoya:read-notifications:${userId}`);
  } catch {
    // 使えない環境では何もしない
  }
}
