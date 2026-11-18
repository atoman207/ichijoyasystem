import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, getDb, mutate } from "@/lib/db/store";
import { canDownloadBackup } from "@/lib/auth/permissions";
import { credentialStatus } from "@/lib/account-rules";
import { backupFileFor, storageArchive } from "@/lib/backup";

export const dynamic = "force-dynamic";

/**
 * バックアップのダウンロード (管理者。VPS の故障に備えて、社外のパソコン・ディスク・クラウドに保管するため)
 *   /api/backups/download?kind=db&name=ichijoya-<日時>.dump        データベース (pg_dump のカスタム形式。復元は deploy/README.md)
 *   /api/backups/download?kind=chatbot&name=chatbot-<日時>.sqlite  チャットボット (SQLite)
 *   /api/backups/download?kind=files                                添付ファイル・写真・顔写真の一式 (tar.gz。その場で作る)
 * - お客様の個人情報をすべて含むため: 管理者のみ・初期パスワードのままでは不可・だれが何をダウンロードしたかを変更履歴に残す
 * - ファイル名は一覧 (src/lib/backup.ts) にあるものと完全に一致するときだけ (ほかのファイルを指定されないように)
 * - 断るときは 設定 → データ管理 に戻して理由を表示する (転送先は相対パス。CLAUDE.md の Route Handler の注意)
 */
const BACK = "/settings?tab=data";

function backWith(err: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: `${BACK}&err=${encodeURIComponent(err)}`, "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  // 画面遷移の先読み (prefetch / RSC) ではダウンロードしない (変更履歴に誤って残らないように)
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user) return new NextResponse(null, { status: 303, headers: { Location: `/login?next=${encodeURIComponent(BACK)}`, "Cache-Control": "no-store" } });
  if (!canDownloadBackup(user)) return backWith("バックアップのダウンロードは管理者が行えます。");
  if (credentialStatus(getDb().auditLogs, user.id).password === "initial") {
    return backWith("初期パスワードのままでは、バックアップをダウンロードできません (お客様の個人情報をすべて含むため)。プロフィールでパスワードを変更してから、もう一度お試しください。");
  }

  const params = new URL(req.url).searchParams;
  const kind = params.get("kind");
  let body: ReadableStream<Uint8Array>;
  let filename: string;
  let length: number | undefined;
  let label: string;
  if (kind === "db" || kind === "chatbot") {
    const f = backupFileFor(kind, params.get("name") ?? "");
    if (!f) return backWith("そのバックアップのファイルは見つかりません (古いものは自動で削除されます)。一覧から選び直してください。");
    body = Readable.toWeb(fs.createReadStream(f.path)) as ReadableStream<Uint8Array>;
    filename = f.name;
    length = f.bytes;
    label = kind === "db" ? "データベース" : "チャットボット";
  } else if (kind === "files") {
    const a = storageArchive();
    if (!a) return backWith("添付ファイル・写真のバックアップがまだありません。先に「今すぐバックアップ」を実行してください。");
    body = Readable.toWeb(Readable.from(a.stream)) as ReadableStream<Uint8Array>;
    filename = a.name;
    label = "添付ファイル・写真 (一式)";
  } else {
    return backWith("ダウンロードするバックアップを選んでください。");
  }

  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "data", entityId: `backup:${filename}`, entityLabel: `バックアップ (${label})`, summary: `バックアップをダウンロード: ${label} ${filename}` });
  });
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...(length != null ? { "Content-Length": String(length) } : {}),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
