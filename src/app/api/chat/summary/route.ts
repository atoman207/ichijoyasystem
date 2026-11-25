import { getDb } from "@/lib/db/store";
import { chatState } from "@/lib/chat/inbox";
import { prefsOf } from "@/lib/chat/repo";
import { chatUser, json } from "@/lib/chat/api";
import type { ChatSummary } from "@/lib/chat/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ヘッダーのチャットのアイコン (要対応の赤い数字・未読の青い数字・通知音の設定)。画面が 15 秒ごとに読む */
export async function GET() {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const s = chatState(getDb(), user, { withLists: false });
  return json<ChatSummary>({ ...s.counts, prefs: prefsOf(user.id) });
}
