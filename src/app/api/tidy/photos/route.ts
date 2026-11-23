import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, nowIso, syncDb } from "@/lib/db/store";
import { canEditTidyCheck } from "@/lib/auth/permissions";
import { UserError, type IncomingFile } from "@/lib/attachments";
import type { TidyPhoto } from "@/lib/db/types";
import { TIDY_MAX_PHOTOS } from "@/lib/tidy";
import { discardTidyPhotos, storeTidyPhoto } from "@/lib/tidy-photos";
import { postTablesMissing } from "@/lib/posts-tables";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 整理整頓チェックの写真の登録 (1 回の送信で 1 枚。画面の部品は添付ファイルと同じ AttachmentUploader)
 * multipart/form-data: parentId (チェックの ID), file, thumb (縮小画像・任意), width, height, takenAt, caption
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return json(403, "この操作は受け付けられません。");
  const user = await getSessionUser();
  if (!user) return json(401, "ログインし直してください。");
  const missing = await postTablesMissing(["tidy_checks"]);
  if (missing) return json(503, missing);
  const db = await syncDb();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, "写真を受け取れませんでした。写真が大きすぎる可能性があります (1 枚 4 MB まで)。");
  }
  const checkId = String(form.get("parentId") ?? "");
  const c = (db.tidyChecks ?? []).find((x) => x.id === checkId);
  if (!c) return json(404, "整理整頓チェックが見つかりません。");
  if (!canEditTidyCheck(user, c)) return json(403, "このチェックに写真を登録する権限がありません。");
  if (c.photos.length >= TIDY_MAX_PHOTOS) return json(400, `写真は 1 つのチェックに ${TIDY_MAX_PHOTOS} 枚までです。`);
  const file = await incoming(form.get("file"));
  if (!file) return json(400, "写真を選んでください。");
  let photo: TidyPhoto;
  try {
    photo = await storeTidyPhoto({ user, file, thumb: await incoming(form.get("thumb")), width: Number(form.get("width")) || undefined, height: Number(form.get("height")) || undefined, takenAt: String(form.get("takenAt") ?? "") || undefined, caption: String(form.get("caption") ?? "") });
  } catch (err) {
    if (err instanceof UserError) return json(400, err.message);
    console.error("[tidy] photo store failed:", err);
    return json(500, "写真の保存に失敗しました。時間をおいて再度お試しください。");
  }
  try {
    await mutate((d) => {
      const x = d.tidyChecks.find((y) => y.id === checkId);
      if (!x) throw new UserError("整理整頓チェックが削除されています。");
      x.photos = [...x.photos, photo];
      x.updatedBy = user.id;
      x.updatedAt = nowIso();
      addAudit(d, { userId: user.id, action: "update", entity: "tidy_check", entityId: x.id, entityLabel: `${x.number} ${x.date}`, summary: `整理整頓チェックに写真を追加 (${photo.fileName})`, storeId: x.storeId, changes: [{ field: "photos", before: `${x.photos.length - 1} 枚`, after: `${x.photos.length} 枚` }] });
    });
  } catch (err) {
    await discardTidyPhotos([photo]);
    if (err instanceof UserError) return json(409, err.message);
    console.error("[tidy] photo save failed:", err);
    return json(500, "写真の登録に失敗しました。時間をおいて再度お試しください。");
  }
  revalidatePath(`/kpi/tidy/${checkId}`);
  return NextResponse.json({ ok: true, id: photo.id, kind: "photo" });
}

async function incoming(v: FormDataEntryValue | null): Promise<IncomingFile | null> {
  if (!(v instanceof File) || v.size === 0) return null;
  return { name: v.name || "photo.jpg", type: v.type, bytes: Buffer.from(await v.arrayBuffer()) };
}

function json(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}
