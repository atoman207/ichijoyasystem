import "server-only";
import type { Database } from "@/lib/db/types";
import { chatworkConfig, chatworkWebhookTokens } from "./config";

/**
 * Chatwork の接続の確認 (連携用アカウント・参加しているルーム・協力業者のルーム・社内通知のルーム)
 * Webhook は Chatwork の画面でしか作れない (API がない) ため、ここでは受信先の URL とトークンの数を示す
 */

export interface ChatworkCheck {
  ok: boolean;
  lines: string[];
}

export async function checkChatwork(db: Database, webhookUrl: string): Promise<ChatworkCheck> {
  const cfg = chatworkConfig();
  if (!cfg) return { ok: false, lines: ["CHATWORK_API_TOKEN が未設定です。"] };
  const headers = { "X-ChatWorkToken": cfg.token };
  const lines: string[] = [];
  let ok = true;
  try {
    const meRes = await fetch(`${cfg.base}/me`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!meRes.ok) return { ok: false, lines: [`Chatwork に接続できません (HTTP ${meRes.status})。API トークンを確認してください (組織の管理者が API の利用を許可している必要があります)。`] };
    const me = (await meRes.json()) as { account_id?: number; name?: string; organization_name?: string };
    const self = (process.env.CHATWORK_SELF_ACCOUNT_ID ?? "").trim();
    lines.push(`連携用アカウント: ${me.name ?? "-"}${me.organization_name ? ` (${me.organization_name})` : ""} · アカウント ID ${me.account_id ?? "-"}`);
    if (!self) lines.push(`CHATWORK_SELF_ACCOUNT_ID が未設定です → ${me.account_id} を設定すると、システムからの投稿を受信に数えません。`);
    else if (self !== String(me.account_id)) {
      ok = false;
      lines.push(`CHATWORK_SELF_ACCOUNT_ID (${self}) が連携用アカウントの ID (${me.account_id}) と違います。`);
    }
    const roomsRes = await fetch(`${cfg.base}/rooms`, { headers, signal: AbortSignal.timeout(15_000) });
    const rooms = roomsRes.ok ? ((await roomsRes.json()) as { room_id: number; name: string }[]) : [];
    const joined = new Set(rooms.map((r) => String(r.room_id)));
    lines.push(`参加しているルーム: ${rooms.length} 件`);
    if (cfg.roomId) {
      if (joined.has(cfg.roomId)) lines.push(`社内通知のルーム: ${rooms.find((r) => String(r.room_id) === cfg.roomId)?.name ?? cfg.roomId}`);
      else {
        ok = false;
        lines.push(`社内通知のルーム (CHATWORK_ROOM_ID ${cfg.roomId}) に連携用アカウントが参加していません。`);
      }
    }
    const partners = db.suppliers.filter((s) => s.active !== false && s.chatworkRoomId);
    const missing = partners.filter((s) => !joined.has(s.chatworkRoomId!));
    lines.push(`ルーム ID を登録した協力業者・仕入先: ${partners.length} 件${missing.length ? ` (うち連携用アカウントが参加していないルーム: ${missing.map((s) => `${s.name} ${s.chatworkRoomId}`).join("、")})` : ""}`);
    if (missing.length) ok = false;
    const tokens = chatworkWebhookTokens().length;
    lines.push(`受信 (Webhook): トークン ${tokens} 件 · URL ${webhookUrl}${tokens < partners.length ? ` (受信するルームごとに Webhook を作り、トークンをカンマ区切りで CHATWORK_WEBHOOK_TOKEN に追加してください)` : ""}`);
  } catch (err) {
    return { ok: false, lines: [...lines, `確認できませんでした: ${(err as Error).message}`] };
  }
  return { ok, lines };
}
