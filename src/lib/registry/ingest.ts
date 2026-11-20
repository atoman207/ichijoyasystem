import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import type { KnowledgeVisibility } from "@/lib/db/types";
import { extractBuiltin, kindOfExt, textSections, type Section } from "./extract";
import { dateFromName, guessCategory, storeFromPath, type Classification, type RegistryAction } from "./classify";
import { buildDoc } from "./build";
import { upsertDoc, type MaterialsSqlite } from "./materials-db";

/**
 * データ台帳: 画面から追加した資料を読み取り、資料庫に入れる (入力 → 解読 → 記憶)
 * .xlsx・.xlsm・.docx・.pptx・.csv・.txt・.md・.zip (中のファイル名) はライブラリなしで、PDF はサーバーの pdftotext で文字にする。
 * 古い形式 (.xls・.doc) と画像の PDF は文字にできない (保存し直してもらう・スクリプトで読む)
 */

export const UPLOAD_EXTS = ["xlsx", "xlsm", "docx", "pptx", "csv", "tsv", "txt", "md", "pdf", "zip"];

function pdfText(buf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-pdf-"));
    const file = path.join(dir, "in.pdf");
    fs.writeFileSync(file, buf);
    execFile("pdftotext", ["-enc", "UTF-8", "-layout", file, "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err) reject(new Error((err as NodeJS.ErrnoException).code === "ENOENT" ? "このサーバーでは PDF の文字を読めません (pdftotext がありません)" : `PDF を読めません: ${err.message.slice(0, 80)}`));
      else resolve(String(stdout).replace(/[ 　]{3,}/g, " | ").replace(/^ \| /gm, ""));
    });
  });
}

export async function extractUpload(name: string, buf: Buffer): Promise<{ sections: Section[] | null; error?: string }> {
  const ext = (/\.([^.]+)$/.exec(name)?.[1] ?? "").toLowerCase();
  try {
    if (ext === "pdf") return { sections: textSections(name.replace(/\.[^.]+$/, ""), await pdfText(buf), { pages: true }) };
    const s = extractBuiltin(name, buf);
    if (s) return { sections: s };
    if (ext === "xls" || ext === "doc") return { sections: null, error: "Excel 97-2003 (.xls)・Word 97-2003 (.doc) は、.xlsx・.docx で保存し直してから追加してください" };
    return { sections: null, error: "この形式は文字にできません (台帳にだけ記録します)" };
  } catch (err) {
    return { sections: null, error: (err as Error).message.slice(0, 200) };
  }
}

export interface UploadInput {
  name: string;
  buf: Buffer;
  visibility: KnowledgeVisibility;
  category?: string;
  /** 社内資料にも登録する */
  promote: boolean;
  note?: string;
  storageKey: string;
}

/** 1 つのファイルを資料庫に入れる。資料の ID (中身の sha1 から作る。同じ中身は同じ ID) と結果を返す */
export async function ingestUpload(mdb: MaterialsSqlite, input: UploadInput): Promise<{ id: string; status: string; chars: number; sections: number; error?: string }> {
  const sha1 = crypto.createHash("sha1").update(input.buf).digest("hex");
  const id = `up_${sha1.slice(0, 12)}`;
  const ext = (/\.([^.]+)$/.exec(input.name)?.[1] ?? "").toLowerCase();
  const kind = kindOfExt(ext);
  const { sections, error } = await extractUpload(input.name, input.buf);
  const text = (sections ?? []).map((s) => s.text).join("\n").slice(0, 5000);
  const action: RegistryAction = sections ? (input.promote ? "knowledge" : "materials") : "ledger";
  const cls: Classification = {
    ruleId: "upload",
    action,
    category: input.category || guessCategory(input.name, text),
    visibility: input.visibility,
    note: input.note || "画面から追加した資料",
    storeId: storeFromPath(input.name),
    recordDate: dateFromName(input.name),
  };
  const { doc, chunks } = buildDoc(
    {
      id,
      origin: "upload",
      folder: "追加した資料",
      folderLabel: "画面から追加した資料",
      path: input.name,
      name: input.name,
      ext,
      kind,
      bytes: input.buf.length,
      mtime: new Date().toISOString().slice(0, 10),
      sha1,
      storageKey: input.storageKey,
      sections,
      error,
    },
    cls,
  );
  upsertDoc(mdb, doc, chunks);
  return { id, status: doc.status, chars: doc.chars, sections: chunks.length, error };
}
