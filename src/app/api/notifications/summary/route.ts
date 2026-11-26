import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { liveSignature } from "@/lib/notify-live";
import { triggerInquiryFollowups } from "@/lib/inquiry-followup";
import { triggerInboundMail } from "@/lib/inbound/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ヘッダーの件数の印 (AppShell が 1 分ごとに読み、変わったら画面を読み直す。src/lib/notify-live.ts) */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  // 期限を過ぎた問い合わせの依頼の再通知 (5 分に 1 回まで。応答は待たない。src/lib/inquiry-followup.ts)
  triggerInquiryFollowups();
  // 会社のメールボックスの新しいメール (2 分に 1 回まで。設定でオンのときだけ。src/lib/inbound/mail.ts)
  triggerInboundMail();
  return NextResponse.json(liveSignature(user), { headers: { "Cache-Control": "private, no-store" } });
}
