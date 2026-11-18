import "server-only";
import type { Database } from "@/lib/db/types";
import { buildDocs } from "./sources";
import { buildSeed } from "./seed";
import { getMeta, hashText, replaceDocs, replaceSeedQa, setMeta } from "./store";

/** seed の作り方を変えたら上げる (次の質問のときに作り直す) */
const SEED_VERSION = "5";
/** 同じプロセスで資料を確かめ直す間隔 */
const CHECK_MS = 5 * 60_000;

const g = globalThis as typeof globalThis & { __chatbotCheckedAt?: number };

export interface BuildResult {
  rebuilt: boolean;
  docs: number;
  changed: number;
  removed: number;
  seeds: number;
}

/**
 * 根拠の資料と seed をシステムの現在の定義に合わせる。内容が変わっていなければ何もしない。
 * force = true は管理画面の「作り直す」
 */
export function ensureChatbotData(db: Pick<Database, "settings" | "knowledge">, force = false): BuildResult {
  if (!force && g.__chatbotCheckedAt && Date.now() - g.__chatbotCheckedAt < CHECK_MS) return { rebuilt: false, docs: 0, changed: 0, removed: 0, seeds: 0 };
  g.__chatbotCheckedAt = Date.now();
  const docs = buildDocs(db);
  const sourceHash = hashText(`${SEED_VERSION}\n${JSON.stringify(docs)}`);
  if (!force && getMeta("source_hash") === sourceHash) return { rebuilt: false, docs: docs.length, changed: 0, removed: 0, seeds: 0 };
  const { changed, removed } = replaceDocs(docs);
  const seeds = replaceSeedQa(buildSeed(db));
  setMeta("source_hash", sourceHash);
  setMeta("built_at", new Date().toISOString());
  return { rebuilt: true, docs: docs.length, changed, removed, seeds };
}
