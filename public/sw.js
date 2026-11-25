/*
 * 一畳屋 統合業務システム: プッシュ通知の受け取り (サービスワーカー)
 * ------------------------------------------------------------
 * - サーバー (src/lib/notify/push.ts) が暗号にして送った通知を、ロック画面・通知センターに出す (音・バイブは端末の通知の設定)
 * - 通知を押すと、その画面 (チャットのメッセージ・業務依頼) を開く。開いている画面があればそれを使う
 * - システムを開いて見ているとき (パソコン・Android) は通知を出さず、画面が音と数字で知らせる。
 *   iPhone・Mac の Safari は届いた通知を必ず出す決まりなので、いつも出す
 * - 画面のファイルは保存しない (キャッシュしない。いつも最新の画面を開く)
 */
const UA = self.navigator.userAgent || "";
const WEBKIT_PUSH = /iPhone|iPad|iPod|Macintosh/.test(UA) && /AppleWebKit/.test(UA) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(UA);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "一畳屋", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "一畳屋";
  const url = data.url || "/chat";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) c.postMessage({ type: "ichijoya-push", payload: data });
      const watching = wins.some((c) => c.focused && c.visibilityState === "visible");
      if (watching && !WEBKIT_PUSH) return;
      await self.registration.showNotification(title, {
        body: data.body || "",
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        icon: "/icons/icon-192.png",
        data: { url },
        requireInteraction: Boolean(data.priority),
        vibrate: data.priority ? [200, 100, 200] : [120],
        timestamp: Date.now(),
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/chat", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        try {
          if ("navigate" in win) {
            await win.navigate(target.href);
            return;
          }
        } catch (e) {
          // 画面の側で開く (サービスワーカーの管理の外の画面)
        }
        win.postMessage({ type: "ichijoya-open", url: target.pathname + target.search });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

// 配信サービスが端末の登録を新しくしたとき (まれ): 新しい登録をサーバーに送る
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const old = event.oldSubscription;
        const sub = event.newSubscription || (old && (await self.registration.pushManager.subscribe(old.options)));
        if (!sub) return;
        await fetch("/api/chat/push", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON(), ua: UA, replaces: old ? old.endpoint : undefined }),
        });
      } catch (e) {
        // 次に画面を開いたときに登録し直す
      }
    })(),
  );
});
