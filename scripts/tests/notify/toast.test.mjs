/**
 * トースト (src/components/ui/toast.ts) のテスト (2026-11-26)
 *   node scripts/tests/notify/toast.test.mjs   (npm run test:notify)
 * - 消えるまでの時間・同じ知らせのまとめ・4 つまで・group・画面の操作の結果 (showResult)・別の画面への移動・閉じる
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
eq(T.TOAST_LABEL, { success: "完了", error: "エラー", info: "お知らせ", warn: "注意" }, "色だけでなくラベルで表す");

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

console.log(`\n${pass} 件 OK${fails.length ? ` / ${fails.length} 件 NG` : ""}`);
if (fails.length) {
  for (const f of fails) console.log("  NG:", f);
  process.exit(1);
}
