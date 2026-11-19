import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { UserError } from "@/lib/attachments";
import type { MapRefType } from "@/lib/db/types";
import { canEditRecordMap, canViewLocation } from "@/lib/maps/access";
import { registerMapDocument, type DocTarget } from "@/lib/maps/documents";
import { mapTablesMissing } from "@/lib/maps/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TYPES = ["customer", "quote", "order", "event", "location"] as const;

/**
 * 住宅地図の PDF の登録・差し替え (1 回の送信で 1 ファイル)
 * multipart/form-data: targetType (customer|quote|order|event|location), targetId, file, replaceId (差し替えのとき),
 * provider (zenrin|other), kind (residential|other), title, edition, copyrightNotice, licenseRef, licenseNote, shareable=1, licenseConfirmed=1
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return json(403, "この操作は受け付けられません。");
  const user = await getSessionUser();
  if (!user) return json(401, "ログインし直してください。");
  const db = await syncDb();
  const missing = await mapTablesMissing();
  if (missing) return json(503, missing);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, "ファイルを受け取れませんでした。ファイルが大きすぎる可能性があります (1 ファイル 9 MB まで)。");
  }
  const s = (k: string) => String(form.get(k) ?? "").trim();
  const type = s("targetType") as (typeof TYPES)[number];
  if (!TYPES.includes(type)) return json(400, "登録先が正しくありません。");
  const targetId = s("targetId");
  if (type === "location") {
    const loc = db.mapLocations.find((l) => l.id === targetId && l.status === "active");
    if (!loc) return json(404, "場所が見つかりません。");
    if (!canViewLocation(user, db, loc)) return json(403, "この場所に住宅地図を登録する権限がありません。");
  } else if (!canEditRecordMap(user, db, type as MapRefType, targetId)) {
    return json(403, "この記録に住宅地図を登録する権限がありません。");
  }
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return json(400, "PDF ファイルを選んでください。");
  const provider = s("provider") === "other" ? "other" : "zenrin";
  try {
    const r = await registerMapDocument({
      user,
      target: { type, id: targetId } as DocTarget,
      file: { name: f.name || "map.pdf", bytes: Buffer.from(await f.arrayBuffer()) },
      meta: {
        provider,
        kind: s("kind") === "other" ? "other" : "residential",
        title: s("title"),
        edition: s("edition"),
        copyrightNotice: s("copyrightNotice"),
        licenseRef: s("licenseRef"),
        licenseNote: s("licenseNote"),
        shareable: s("shareable") === "1",
        licenseConfirmed: s("licenseConfirmed") === "1",
      },
      replaceId: s("replaceId") || undefined,
      source: "upload",
    });
    revalidatePath("/", "layout");
    return NextResponse.json({ ok: true, id: r.document.id, status: r.status, message: r.message, locationId: r.location.id });
  } catch (err) {
    if (err instanceof UserError) return json(400, err.message);
    console.error("[maps] upload failed:", err);
    return json(500, "住宅地図の登録に失敗しました。時間をおいて再度お試しください。");
  }
}

function json(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}
