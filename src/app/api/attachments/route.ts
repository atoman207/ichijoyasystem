import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth/session";
import { BACKEND, addAudit, mutate, syncDb } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { canAddToParent, discardStored, resolveParent, storeFile, UserError, type IncomingFile } from "@/lib/attachments";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 添付ファイルの登録 (1 回の送信で 1 ファイル。複数枚は画面側で順に送る)
 * multipart/form-data: parentType, parentId, file, thumb (写真の縮小画像・任意), width, height, takenAt, caption
 */
export async function POST(req: Request) {
  // 他のサイトからの送信を拒否する (Cookie は SameSite=Lax だが念のため)
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return json(403, "この操作は受け付けられません。");
  const user = await getSessionUser();
  if (!user) return json(401, "ログインし直してください。");
  const db = await syncDb();
  if (BACKEND === "supabase" && missingTables().includes("attachments") && (await recheckMissingTables()).includes("attachments")) {
    return json(503, "添付ファイルの台帳 (attachments テーブル) がデータベースにまだありません。管理者に連絡してください (テーブル定義の SQL の実行が必要です)。");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, "ファイルを受け取れませんでした。ファイルが大きすぎる可能性があります (1 ファイル 4 MB まで)。");
  }
  const parent = resolveParent(db, String(form.get("parentType") ?? ""), String(form.get("parentId") ?? ""));
  if (!parent) return json(404, "登録先の記録が見つかりません。");
  if (!canAddToParent(user, db, parent)) return json(403, "この記録にファイルを登録する権限がありません。");
  const file = await incoming(form.get("file"));
  if (!file) return json(400, "ファイルを選んでください。");
  const thumb = await incoming(form.get("thumb"));

  let stored;
  try {
    stored = await storeFile({
      user,
      parent,
      file,
      thumb: thumb ?? undefined,
      width: Number(form.get("width")) || undefined,
      height: Number(form.get("height")) || undefined,
      takenAt: String(form.get("takenAt") ?? "") || undefined,
      caption: String(form.get("caption") ?? ""),
    });
  } catch (err) {
    if (err instanceof UserError) return json(400, err.message);
    console.error("[attachments] store failed:", err);
    return json(500, "ファイルの保存に失敗しました。時間をおいて再度お試しください。");
  }
  try {
    await mutate((d) => {
      if (!resolveParent(d, parent.type, parent.id)) throw new UserError("登録先の記録が削除されています。");
      d.attachments.push(stored);
      addAudit(d, {
        userId: user.id,
        action: "create",
        entity: parent.entity,
        entityId: parent.id,
        entityLabel: parent.label,
        summary: `${stored.kind === "photo" ? "写真" : "資料"}を添付 (${stored.fileName})`,
        storeId: parent.storeId,
      });
    });
  } catch (err) {
    await discardStored(stored);
    if (err instanceof UserError) return json(409, err.message);
    console.error("[attachments] save failed:", err);
    return json(500, "ファイルの登録に失敗しました。時間をおいて再度お試しください。");
  }
  revalidatePath(parent.href.split("?")[0]);
  if (parent.customerId) revalidatePath(`/customers/${parent.customerId}`);
  return NextResponse.json({ ok: true, id: stored.id, kind: stored.kind });
}

async function incoming(v: FormDataEntryValue | null): Promise<IncomingFile | null> {
  if (!(v instanceof File) || v.size === 0) return null;
  return { name: v.name || "file", type: v.type, bytes: Buffer.from(await v.arrayBuffer()) };
}

function json(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}
