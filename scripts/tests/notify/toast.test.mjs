/**
 * トースト (src/components/ui/toast.ts) のテスト (2026-11-26)
 *   node scripts/tests/notify/toast.test.mjs   (npm run test:notify)
 * - 消えるまでの時間・同じ知らせのまとめ・4 つまで・group・tag・画面の操作の結果 (showResult)・別の画面への移動・閉じる
 * - 新しく届いた通知 (src/lib/notify-seen.ts の freshNotices・noticeToasts): 1 回だけ・確認済みは出さない・初めてのブラウザーは覚えるだけ
 * - 画面の部品のつなぎ (AppShell に Toaster・Flash は URL の結果を出さない・チャットと予定の小さな画面は共通のトースト) をソースで確かめる
 * React・ブラウザーは使わない
 */
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src") }, moduleCache: true });
const T = await jiti.import(path.join(root, "src/components/ui/toast.ts"));
const src = (p) => fs.readFileSync(path.join(root, "src", p), "utf8");

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    fails.push(msg);
    console.log("  ✗", msg);
  }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b) ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (t) => console.log(`\n■ ${t}`);
const list = () => T.getToasts();
const texts = () => list().map((t) => t.text);

// ---------------------------------------------------------------------------
section("消えるまでの時間");
eq(T.toastDuration("success", "保存しました。"), 4000 + 7 * 80, "完了: 4 秒 + 1 文字 80 ミリ秒");
eq(T.toastDuration("info", "あ"), 6080, "お知らせ: 6 秒から");
eq(T.toastDuration("success", "あ".repeat(500)), 12000, "長い文でも 12 秒まで");
eq(T.toastDuration("error", "できませんでした"), "sticky", "エラーは閉じるまで残す");
eq(T.toastDuration("notice", "あ"), 8080, "通知: 8 秒から");
eq(T.toastDuration("notice", "あ".repeat(500)), 15000, "通知は 15 秒まで");
eq(T.TOAST_LABEL, { success: "完了", error: "エラー", info: "お知らせ", warn: "注意", notice: "通知" }, "色だけでなくラベルで表す");

// ---------------------------------------------------------------------------
section("出す・まとめる・閉じる");
T.resetToasts();
let calls = 0;
const unsub = T.subscribeToasts(() => calls++);
const id1 = T.toast.success("保存しました。");
ok(id1 && list().length === 1 && list()[0].tone === "success", "toast.success で 1 つ出る");
ok(calls === 1, "変わったら知らせる (useSyncExternalStore)");
eq(T.toast("   "), "", "空の文は出さない");
ok(list().length === 1, "空の文で数は変わらない");
T.toast.info("別の知らせ");
const id2 = T.toast.success("保存しました。");
eq(id2, id1, "同じ知らせは同じトースト");
eq([list()[0].text, list()[0].count, list()[0].bump], ["保存しました。", 2, 1], "まとめて ×2・時間を数え直す・いちばん上へ");
ok(list().length === 2, "まとめたので 2 つのまま");
T.toast.dismiss(id1);
eq(texts(), ["別の知らせ"], "ID で閉じる");
T.toast.dismiss();
eq(list().length, 0, "すべて閉じる");
unsub();

// ---------------------------------------------------------------------------
section("4 つまで (エラーはなるべく残す)");
T.resetToasts();
T.toast.error("エラー A");
T.toast.error("エラー B");
for (const n of [1, 2, 3, 4]) T.toast.success(`完了 ${n}`);
eq(list().length, T.MAX_TOASTS, "4 つまで");
ok(texts().includes("エラー A") && texts().includes("エラー B"), "消える知らせの古いものから外す (エラーは残る)");
eq(texts()[0], "完了 4", "新しいものが上");
T.resetToasts();
for (const n of [1, 2, 3, 4, 5]) T.toast.error(`エラー ${n}`);
eq(texts(), ["エラー 5", "エラー 4", "エラー 3", "エラー 2"], "すべてエラーなら古いものから外す");

// ---------------------------------------------------------------------------
section("group (同じ種類の新しい知らせで前を閉じる)");
T.resetToasts();
T.toast.info("アップロード中…", { group: "up" });
T.toast.info("ほかの知らせ");
T.toast.success("アップロードしました", { group: "up" });
eq(texts(), ["アップロードしました", "ほかの知らせ"], "同じ group の前の知らせを閉じる");

// ---------------------------------------------------------------------------
section("通知のトースト (tone = notice・詳しい内容・tag)");
T.resetToasts();
T.toast.notice("承認依頼: 見積の確定", { detail: "Q-0001 (¥10,000)", tag: "bell", action: { label: "開く", href: "/approvals?tab=mine" } });
T.toast.notice("予定の担当になりました: 引き取り", { detail: "11/27 午前", tag: "bell" });
T.toast.notice("チャットに新しいメッセージが届きました", { group: "chat" });
eq([list()[2].tone, list()[2].detail, list()[2].action?.href], ["notice", "Q-0001 (¥10,000)", "/approvals?tab=mine"], "通知は詳しい内容と開くボタンを持つ");
ok(list()[2].duration === T.toastDuration("notice", "承認依頼: 見積の確定Q-0001 (¥10,000)"), "時間は本文と詳しい内容の長さで決める");
eq(list().length, 3, "tag は前の知らせを閉じない (同じ回の通知を並べる)");
T.toast.notice("チャットにあなたへのメンション・依頼が届きました", { group: "chat" });
eq(list().filter((t) => t.group === "chat").length, 1, "チャットの知らせは新しいものに置き換える (group)");
T.toast.dismissTag("bell");
eq(texts(), ["チャットにあなたへのメンション・依頼が届きました"], "ベルを開いたらベルの通知だけ閉じる (dismissTag)");

// ---------------------------------------------------------------------------
section("新しく届いた通知 (notify-seen.ts の freshNotices)");
const N = await jiti.import(path.join(root, "src/lib/notify-seen.ts"));
const items = [
  { title: "承認依頼 A", keys: ["apv:a1"] },
  { title: "未対応の問い合わせ 2 件", keys: ["inq:i1", "inq:i2"] },
  { title: "予定が変更されました", keys: ["ev:e1@2026-11-26T01:00:00Z"] },
];
eq(N.freshNotices(items, new Set(), new Set()), [], "このブラウザーで初めて (印なし) は知らせない (覚えるだけ)");
const announced = new Set([N.ANNOUNCE_INIT, "apv:a1", "inq:i1"]);
eq(N.freshNotices(items, announced, new Set()).map((n) => n.title), ["未対応の問い合わせ 2 件", "予定が変更されました"], "知らせていないキーのある通知だけ (まとめた通知は 1 件増えたら知らせる)");
eq(N.freshNotices(items, announced, new Set(["inq:i2"])).map((n) => n.title), ["予定が変更されました"], "確認済みの記録は知らせない");
eq(N.freshNotices(items, new Set([N.ANNOUNCE_INIT, "apv:a1", "inq:i1", "inq:i2", "ev:e1@2026-11-26T01:00:00Z"]), new Set()), [], "知らせた通知は二度出さない");
eq(N.freshNotices([{ title: "予定が変更されました", keys: ["ev:e1@2026-11-26T02:00:00Z"] }], announced, new Set()).length, 1, "記録が変わって印が変われば改めて知らせる");
eq(N.noticeToasts([1, 2, 3, 4, 5]), { show: [1, 2, 3], more: 2 }, "一度に 3 件まで + 「ほかに n 件」");
eq(N.noticeToasts([1]), { show: [1], more: 0 }, "3 件以下はそのまま");

// ---------------------------------------------------------------------------
section("画面の操作の結果 (URL の ?msg= / ?err=)");
T.resetToasts();
T.toast.info("部品の知らせ");
T.showResult(null, "お名前を入れてください。");
eq(list()[0].tone, "error", "err はエラーのトースト");
eq(list()[0].duration, "sticky", "結果のエラーは閉じるまで残す");
ok(T.shownFromUrl("お名前を入れてください。"), "URL から出した文を覚える (Flash が重ねない)");
ok(!T.shownFromUrl("画面が決めた知らせ"), "URL にない文は覚えない");
T.showResult("顧客を登録しました。", null);
eq(texts(), ["顧客を登録しました。", "部品の知らせ"], "直して保存し直したら前の結果のエラーを閉じる (部品の知らせは残す)");
T.showResult("顧客を登録しました。", null);
eq([list()[0].count, list().length], [2, 2], "同じ結果が続いたら ×2");
T.showResult("保存しました。", "ただし写真は登録できませんでした。");
eq(texts().slice(0, 2).sort(), ["ただし写真は登録できませんでした。", "保存しました。"].sort(), "同じ回の msg と err は両方出す");
T.showResult(undefined, undefined);
ok(list().length === 3, "msg も err もなければ何もしない");
T.resetToasts();
T.showResult("予定を登録しました。 [[予定表で確認]](/schedule?view=week&date=2026-11-27&store=koshi)", null);
eq([list()[0].text, list()[0].action?.label, list()[0].action?.href], ["予定を登録しました。", "予定表で確認", "/schedule?view=week&date=2026-11-27&store=koshi"], "結果の文の最後の印はボタン (日程の登録のあとの「予定表で確認」)");
ok(Number(list()[0].duration) >= 12000, "ボタンのある知らせは長めに出す");
ok(T.shownFromUrl("予定を登録しました。 [[予定表で確認]](/schedule?view=week&date=2026-11-27&store=koshi)"), "印つきの文も Flash に重ねない");


// ---------------------------------------------------------------------------
section("別の画面へ移ったら閉じるまで残る知らせを閉じる");
T.resetToasts();
T.toast.error("前の画面のエラー");
T.toast.success("前の画面の完了");
T.closeStickyElsewhere("/orders/o_1");
eq(texts(), ["前の画面の完了"], "エラー (閉じるまで残る) は閉じ、時間で消える知らせはそのまま");
T.toast.error("この画面のエラー", { duration: 8000 });
T.closeStickyElsewhere("/orders/o_2");
ok(texts().includes("この画面のエラー"), "時間を決めたエラーは移っても時間で消える");

// ---------------------------------------------------------------------------
section("画面の部品のつなぎ (ソース)");
const shell = src("components/layout/AppShell.tsx");
ok(/import \{ Toaster \} from "@\/components\/ui\/Toaster"/.test(shell) && (shell.match(/<Toaster \/>/g) ?? []).length === 1, "AppShell に Toaster が 1 つ");
const toaster = src("components/ui/Toaster.tsx");
ok(/params\.get\("msg"\)/.test(toaster) && /params\.get\("err"\)/.test(toaster) && /showResult\(msg, err\)/.test(toaster), "Toaster が URL の msg・err を読む");
ok(/searchParams\.delete\("msg"\)/.test(toaster) && /history\.replaceState\(null,/.test(toaster), "読んだら URL から外す (状態は null)");
ok(/z-\[100\]/.test(toaster) && /pointer-events-none fixed/.test(toaster), "ほかの画面の上・下の画面の操作を邪魔しない");
ok(/max-w-\[1680px\] flex-col items-stretch gap-2 sm:items-end/.test(toaster) && /sm:w-\[400px\]/.test(toaster), "画面の右上 (ヘッダーの右端にそろえる。スマートフォンは横いっぱい)");
ok(/freshNotices\(items, announced, seen\)/.test(shell) && /toast\.notice\(n\.title/.test(shell) && /markSeen\(n\.keys\)/.test(shell), "AppShell: 新しく届いたベルの通知をトーストに (開いたら確認済み)");
ok(/if \(menu === "notif"\) toast\.dismissTag\("bell"\)/.test(shell), "ベルを開いたらベルの通知のトーストを閉じる");
const badge = src("components/chat/ChatBadge.tsx");
ok(/toast\.notice\(newAction/.test(badge) && /startsWith\("\/chat"\)/.test(badge), "チャットの新着もトーストに (チャットの画面の外だけ)");
ok(/role=\{item\.tone === "error" \|\| item\.tone === "warn" \? "alert" : "status"\}/.test(toaster), "エラー・注意は alert、ほかは status (読み上げ)");
ok(/aria-label="この知らせを閉じる"/.test(toaster), "閉じるボタン");
const flash = src("components/ui/Flash.tsx");
ok(/shownFromUrl\(t\)/.test(flash) && /params\.get\("msg"\) === t/.test(flash), "Flash は URL の結果を画面の中に重ねない");
ok(/export \{ Flash \} from "\.\/Flash"/.test(src("components/ui/index.tsx")), "Flash の場所は今までどおり @/components/ui");
const chat = src("components/chat/ChatApp.tsx");
ok(!/setToast\(/.test(chat) && /toast\.success\(text\)/.test(chat), "チャットは共通のトースト");
const quick = src("components/schedule/EventQuick.tsx");
ok(!/event-quick-flash/.test(quick), "予定の小さな画面は自分の知らせを出さない (トーストが上に出る)");
ok(/for \(const k of \["qe", "msg", "err"\]\) sp\.delete\(k\)/.test(quick), "msg・err を外しても予定の小さな画面は閉じない");
const css = src("app/globals.css");
ok(/@keyframes toast-bar/.test(css) && css.indexOf("@keyframes toast-bar") > css.lastIndexOf("@theme"), "残り時間の線のアニメーションは @theme の外");

// ---- 通知の種類ごとの色 (お客様のご要望 2026-11-26「トーストは通知ごとに違う色で」。src/components/ui/notice-style.ts)
{
  const NS = await jiti.import(path.join(root, "src/components/ui/notice-style.ts"));
  const keys = Object.keys(NS.NOTICE_STYLE);
  const bars = keys.map((k) => NS.NOTICE_STYLE[k].bar);
  ok(new Set(bars).size === bars.length, `通知の種類ごとに色が違う (${keys.length} 種類の帯の色が重ならない)`);
  ok(keys.every((k) => NS.NOTICE_STYLE[k].label && NS.NOTICE_STYLE[k].icon && NS.NOTICE_STYLE[k].chip && NS.NOTICE_STYLE[k].text), "どの種類もアイコンとラベルつき (色だけに意味を持たせない)");
  eq([NS.noticeStyleKey({ kind: "approval" }), NS.noticeStyleKey({ kind: "inbound", channel: "line" }), NS.noticeStyleKey({ kind: "inbound", channel: "email" }), NS.noticeStyleKey({ kind: "inbound" })], ["approval", "inbound:line", "inbound:email", "bell"], "ベルの通知 → 色の種類 (届いたメッセージは経路ごと)");
  eq([NS.noticeStyle("overdue").label, NS.noticeStyle("inbound:slack").label, NS.noticeStyle("unknown").label, NS.noticeStyle(undefined).label], ["請求", "Slack", "通知", "通知"], "ラベル (知らない種類は「通知」)");
  T.resetToasts();
  T.toast.notice("承認依頼: 見積の確定", { style: "approval", tag: "bell" });
  T.toast.notice("支払期日超過の請求 1 件", { style: "overdue", tag: "bell" });
  T.toast.notice("同じ文", { style: "approval" });
  T.toast.notice("同じ文", { style: "overdue" });
  eq(list().map((t) => t.style), ["overdue", "approval", "overdue", "approval"], "通知のトーストは種類 (style) を持つ");
  eq(list().filter((t) => t.text === "同じ文").length, 2, "同じ文でも種類が違えば 1 つにまとめない");
  T.resetToasts();
  const layout = src("app/(app)/layout.tsx");
  const kinds = [...new Set([...layout.matchAll(/kind: "([a-z]+)"/g)].map((m) => m[1]))];
  ok(kinds.length >= 10 && kinds.every((k) => k === "inbound" || NS.NOTICE_STYLE[k]), `ベルの通知の種類すべてに色がある (${kinds.join("・")})`);
  ok(/channel: g\.channel/.test(layout), "届いたメッセージのベルの行は経路 (LINE・メールなど) を持つ");
  const shell = src("components/layout/AppShell.tsx");
  ok(/toast\.notice\(n\.title, \{[^}]*style: noticeStyleKey\(n\)/.test(shell) && /noticeStyle\(noticeStyleKey\(n\)\)/.test(shell) && !/NOTIFICATION_STYLE/.test(shell), "ベルの行とトーストは同じ色の表 (notice-style.ts)");
  const toaster = src("components/ui/Toaster.tsx");
  ok(/noticeStyle\(item\.style\)/.test(toaster) && /data-style=/.test(toaster), "Toaster は通知の種類の色・アイコン・ラベルで出す");
  ok(/style: newAction \? "mention" : "chat"/.test(src("components/chat/ChatBadge.tsx")), "チャットの知らせはチャットの色 (メンション・依頼はメンションの色)");
}

console.log(`\n${pass} 件 OK${fails.length ? ` / ${fails.length} 件 NG` : ""}`);
if (fails.length) {
  for (const f of fails) console.log("  NG:", f);
  process.exit(1);
}
