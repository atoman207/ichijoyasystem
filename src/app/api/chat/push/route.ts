import { allowedEndpoint, hasSubscription, removeSubscription, saveSubscription, subscriptionsOf, vapidKeys } from "@/lib/notify/push";
import { prefsOf, setPrefs } from "@/lib/chat/repo";
import { chatUser, json, jsonError, sameOrigin } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * プッシュ通知の端末の登録 (画面の「この端末で通知を受け取る」とサービスワーカー)
 * GET ?endpoint=<この端末> → { vapidKey, registered (この端末が登録済み), devices (登録した端末の数) }
 * POST { subscription: PushSubscription.toJSON(), ua, replaces? } → 登録 / DELETE { endpoint } → 登録の取り消し
 */
export async function GET(req: Request) {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const endpoint = new URL(req.url).searchParams.get("endpoint") ?? "";
  const keys = vapidKeys();
  return json({ ok: true, vapidKey: keys?.publicKey ?? "", registered: endpoint ? hasSubscription(user.id, endpoint) : false, devices: subscriptionsOf(user.id).length, prefs: prefsOf(user.id) });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "この操作は受け付けられません。");
  const user = await chatUser();
  if (user instanceof Response) return user;
  if (!vapidKeys()) return jsonError(503, "このサーバーではプッシュ通知を使えません (鍵の準備ができていません)。");
  const b = (await req.json().catch(() => null)) as { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; ua?: string; replaces?: string } | null;
  const endpoint = String(b?.subscription?.endpoint ?? "");
  const p256dh = String(b?.subscription?.keys?.p256dh ?? "");
  const auth = String(b?.subscription?.keys?.auth ?? "");
  if (!allowedEndpoint(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,30}$/.test(auth)) return jsonError(400, "この端末の通知の登録を受け付けられませんでした。ブラウザーを最新にしてお試しください。");
  if (b?.replaces && b.replaces !== endpoint) removeSubscription(user.id, b.replaces);
  saveSubscription(user.id, { endpoint, p256dh, auth, ua: String(b?.ua ?? req.headers.get("user-agent") ?? "") });
  // 通知を受け取る端末を登録したら、本人の「プッシュ通知」をオンにする
  const prefs = prefsOf(user.id);
  if (!prefs.push) setPrefs(user.id, { ...prefs, push: true });
  return json({ ok: true, devices: subscriptionsOf(user.id).length });
}

export async function DELETE(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "この操作は受け付けられません。");
  const user = await chatUser();
  if (user instanceof Response) return user;
  const b = (await req.json().catch(() => null)) as { endpoint?: string } | null;
  removeSubscription(user.id, String(b?.endpoint ?? ""));
  return json({ ok: true, devices: subscriptionsOf(user.id).length });
}
