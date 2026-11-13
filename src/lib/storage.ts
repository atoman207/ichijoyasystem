import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { BACKEND } from "@/lib/db/store";
import { supabaseAdmin } from "@/lib/db/supabase";

/**
 * ファイルの保存先 (添付ファイル・書類取込の元画像)
 * ------------------------------------------------------------
 * - supabase: Supabase Storage の非公開バケット "attachments" (初回に自動で作成)。
 *   画面からは /api/attachments/[id] を開き、権限を確かめたあとに期限つきの URL (2 分) へ転送する
 * - json: data/uploads/ (ローカル検証用。.gitignore 済みの data/ 配下)
 * 保存するキーは英数字だけ (attachments/<種別>/<年月>/<ID>.<拡張子>)。元のファイル名は台帳 (attachments テーブル) に持つ
 */

export const BUCKET = "attachments";
const LOCAL_DIR = path.join(process.cwd(), "data", "uploads");
/** 期限つき URL の有効期間 (秒) */
export const SIGNED_URL_SECONDS = 120;

let bucketReady: Promise<void> | null = null;

function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const storage = supabaseAdmin().storage;
    const { data } = await storage.getBucket(BUCKET);
    if (data) return;
    const { error } = await storage.createBucket(BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw new Error(`[storage] バケット ${BUCKET} を作成できません: ${error.message}`);
  })().catch((err) => {
    bucketReady = null;
    throw err;
  });
  return bucketReady;
}

function localPath(key: string): string {
  const p = path.resolve(LOCAL_DIR, key);
  if (!p.startsWith(LOCAL_DIR + path.sep)) throw new Error("[storage] 不正なキーです");
  return p;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (BACKEND === "supabase") {
    await ensureBucket();
    const { error } = await supabaseAdmin().storage.from(BUCKET).upload(key, body, { contentType, upsert: false, cacheControl: "3600" });
    if (error) throw new Error(`[storage] 保存に失敗しました: ${error.message}`);
    return;
  }
  const file = localPath(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

/** 期限つきの URL (Supabase のみ)。download を渡すと、そのファイル名で保存させる */
export async function signedUrl(key: string, download?: string): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .storage.from(BUCKET)
    .createSignedUrl(key, SIGNED_URL_SECONDS, download ? { download } : undefined);
  if (error || !data?.signedUrl) throw new Error(`[storage] URL を作成できません: ${error?.message ?? "unknown"}`);
  return data.signedUrl;
}

/** ローカル (json) のファイルを読む */
export async function readLocalObject(key: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(localPath(key));
  } catch {
    return null;
  }
}

export async function removeObjects(keys: string[]): Promise<void> {
  const list = keys.filter(Boolean);
  if (!list.length) return;
  if (BACKEND === "supabase") {
    const { error } = await supabaseAdmin().storage.from(BUCKET).remove(list);
    if (error) throw new Error(`[storage] 削除に失敗しました: ${error.message}`);
    return;
  }
  await Promise.all(list.map((k) => fs.rm(localPath(k), { force: true })));
}
