import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { mutate, syncDb } from "@/lib/db/store";
import { canViewNotice, isUnread } from "@/lib/change-notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 同じサイトの中への転送 (相対パス。CLAUDE.md: req.url から転送先を作らない) */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

/** ヘッダーのベルの「変更のお知らせ」を開く: 既読にして、変更した案件の画面へ (src/lib/change-notices.ts) */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return seeOther("/login");
  const { id } = await params;
  const db = await syncDb();
  const n = (db.changeNotices ?? []).find((x) => x.id === id);
  if (!n || !canViewNotice(user, n)) return seeOther(`/notices?err=${encodeURIComponent("お知らせが見つかりません。")}`);
  if (isUnread(user, n)) {
    await mutate((d) => {
      const x = (d.changeNotices ?? []).find((y) => y.id === id);
      if (x && isUnread(user, x)) x.readBy = [...x.readBy, user.id];
    });
  }
  const href = n.href.startsWith("/") && !n.href.startsWith("//") ? n.href : "/notices";
  return seeOther(href);
}
