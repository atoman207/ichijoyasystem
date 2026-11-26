/**
 * 外部から届いたメッセージの通知のテスト (お客様のご要望 2026-11-26「Slack・LINE・メールのメッセージをシステムの通知に」)
 *   node scripts/tests/inbound/inbound.test.mjs   (npm run test:inbound)
 * - src/lib/inbound/feed.ts: 通知の一覧 (1 件にまとめる・古いものを消す・見られる人・ベルの行)
 * - src/lib/notify/inbound.ts: LINE (1 対 1・グループ)・Chatwork の受信が通知になる
 * - src/lib/inbound/slack.ts: 署名・Slack の書式・ボットや編集を数えない・チャンネルの店舗・名前の取得
 * - src/lib/inbound/mail-record.ts・mail.ts: メールの記録と、偽物の IMAP サーバーでの受信 (読み取り専用 = EXAMINE・BODY.PEEK、
 *   2 回目は新しいメールだけ、日本語 (ISO-2022-JP) のメール、自分の送信・メールマガジン)
 * データは一時フォルダーの JSON (サンプルデータ)。外部 (LINE・Slack・メールサーバー) には接続しない
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-inbound-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|SLACK_|INBOUND_MAIL|MAIL_FROM|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "inbound-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  CHAT_DB_PATH: path.join(work, "chat.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-inbound",
  TZ: "Asia/Tokyo",
});
process.chdir(work);
const stubs = path.join(root, "scripts/tests/ops-reports/stubs");
const jiti = createJiti(import.meta.url, {
  alias: {
    "next/navigation": path.join(stubs, "next-navigation.cjs"),
    "next/cache": path.join(stubs, "next-cache.cjs"),
    "@/lib/auth/session": path.join(stubs, "session.cjs"),
    "@": path.join(root, "src"),
    "server-only": path.join(root, "scripts/tests/maps/empty.cjs"),
  },
  moduleCache: true,
});
const imp = (p) => jiti.import(path.join(root, "src", p));

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

const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const F = await imp("lib/inbound/feed.ts");
const P = await imp("lib/auth/permissions.ts");

const stores = db().stores.filter((s) => s.kind !== "hq");
const [s1, s2] = stores;
const customer = db().customers.find((c) => c.storeId === s1.id);
const supplier = db().suppliers[0];
const order = db().orders.find((o) => o.storeId === s2.id) ?? db().orders[0];
await store.mutate((d) => {
  const c = d.customers.find((x) => x.id === customer.id);
  c.email = "yamada.customer@example.test";
  c.lineId = "U0000000000000000000000000000c001";
  if (supplier) {
    const s = d.suppliers.find((x) => x.id === supplier.id);
    s.email = "sales@supplier.example.test";
    s.chatworkRoomId = "998877";
  }
});
const user = (role, storeId, id = `u_${role}_${storeId}`) => ({ id, name: role, email: `${id}@example.test`, role, storeId, title: "", active: true });

/* ================================================================== */
section("通知の一覧 (feed.ts)");
{
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  await store.mutate((d) => {
    ok(F.addInbound(d, { id: "t_1", channel: "line", at: iso(1000), from: "A", text: "x".repeat(900), storeId: s1.id }), "1 件目を足す");
    ok(!F.addInbound(d, { id: "t_1", channel: "line", at: iso(1000), from: "A", text: "again", storeId: s1.id }), "同じ ID はもう一度足さない (再送)");
    F.addInbound(d, { id: "t_old", channel: "email", at: iso(40 * 86_400_000), from: "古い", text: "old", storeId: "hq" });
  });
  const items = F.inboundItems(db());
  ok(items.some((i) => i.id === "t_1") && !items.some((i) => i.id === "t_old"), "30 日より前のものは残さない");
  ok(items.find((i) => i.id === "t_1").text.length <= 600 && items.find((i) => i.id === "t_1").text.endsWith("…"), "本文は先頭 600 文字まで");
  const many = Array.from({ length: 520 }, (_, i) => ({ id: `m${i}`, channel: "line", at: iso(i * 1000), from: "x", text: "y", storeId: "hq" }));
  eq(F.trimInbound(many, now).length, F.INBOUND_MAX_ITEMS, "500 件まで (古いものから消す)");
  eq(F.inboundLine({ from: "山田 様", subject: "見積の件", text: "よろしく\nお願いします" }), "山田 様: 見積の件 — よろしく お願いします", "ベルの 1 行: 送り主・件名・本文");
  eq(F.inboundListHref("email"), "/notices/inbound?channel=email", "一覧の画面 (経路ごと)");
}

section("見られる人 (permissions.ts の canSeeInboundMessage)");
{
  ok(P.canSeeInboundMessage(user("admin", s1.id), "hq") && P.canSeeInboundMessage(user("admin", s1.id), s2.id), "管理者: すべて");
  ok(P.canSeeInboundMessage(user("hq_staff", "hq"), s2.id) && P.canSeeInboundMessage(user("hq_staff", "hq"), "hq"), "本部スタッフ: すべて");
  ok(P.canSeeInboundMessage(user("store_manager", s1.id), s1.id) && !P.canSeeInboundMessage(user("store_manager", s1.id), s2.id), "店長: 自店舗だけ");
  ok(P.canSeeInboundMessage(user("store_staff", s1.id), s1.id) && !P.canSeeInboundMessage(user("store_staff", s1.id), "hq"), "店舗スタッフ: 自店舗だけ (お店の決まらないものは見ない)");
  ok(!P.canSeeInboundMessage({ ...user("admin", s1.id), active: false }, s1.id), "無効のアカウントは見ない");
}

/* ================================================================== */
section("LINE・Chatwork の受信が通知になる (notify/inbound.ts)");
const IN = await imp("lib/notify/inbound.ts");
{
  const t = Date.now();
  const r = await store.mutate((d) =>
    IN.recordLineEvents(d, [
      { type: "message", timestamp: t, source: { type: "user", userId: customer.lineId ?? "U0000000000000000000000000000c001" }, message: { id: "70001", type: "text", text: "明日の訪問は 10 時でお願いします" } },
      { type: "message", timestamp: t + 1, source: { type: "user", userId: "U0000000000000000000000000000ffff" }, message: { id: "70002", type: "text", text: "畳の張替えの見積をお願いしたいです" } },
      { type: "message", timestamp: t + 2, source: { type: "user", userId: "U0000000000000000000000000000ffff" }, message: { id: "70003", type: "image" } },
    ]),
  );
  ok(r.recorded === 3, `LINE 3 件を受信 (${r.recorded})`);
  const it = (id) => F.inboundItems(db()).find((i) => i.id === id);
  const a = it("line_70001");
  eq([a?.channel, a?.from, a?.storeId, a?.href, a?.ref], ["line", `${customer.name} 様`, customer.storeId, `/customers/${customer.id}`, "お客様"], "登録済みのお客様の LINE → そのお客様の店舗に知らせる・お客様の画面");
  const b = it("line_70002");
  ok(b && b.from === "LINE のお客様 (未登録)" && b.href?.startsWith("/inquiries/inq_line_70002") && /新しい問い合わせ/.test(b.ref ?? ""), "未登録の相手 → 新しい問い合わせを開く");
  const c = it("line_70003");
  ok(c && c.text === "[画像]" && c.href === b.href && /問い合わせ/.test(c.ref ?? ""), "続きのメッセージ (画像) → 同じ問い合わせ・本文は [画像]");

  // グループ (店舗別・ひも付け前)
  const gid = "C" + "a".repeat(32);
  await store.mutate((d) => IN.recordLineEvents(d, [{ type: "join", timestamp: t, source: { type: "group", groupId: gid } }]));
  await store.mutate((d) => {
    const row = d.settings.find((s) => s.id === "line_groups");
    const g = row.value.groups.find((x) => x.id === gid);
    g.purpose = "store";
    g.storeId = s2.id;
    g.label = "店舗グループ";
  });
  await store.mutate((d) => IN.recordLineEvents(d, [{ type: "message", timestamp: t + 5, source: { type: "group", groupId: gid, userId: "Uzz" }, message: { id: "70010", type: "text", text: "今日の納品は終わりました" } }]));
  const g1 = it("line_70010");
  eq([g1?.storeId, g1?.fromDetail, g1?.from], [s2.id, "店舗グループ", "グループのメンバー"], "店舗別グループ → その店舗に知らせる (グループ名つき)");

  // 案件にひも付けたグループ
  const gid2 = "C" + "b".repeat(32);
  await store.mutate((d) => {
    const row = d.settings.find((s) => s.id === "line_groups");
    row.value.groups.push({ id: gid2, kind: "group", label: "現場グループ", orderId: order.id, status: "joined", joinedAt: new Date(t).toISOString(), messageCount: 0, pending: [] });
  });
  await store.mutate((d) => IN.recordLineEvents(d, [{ type: "message", timestamp: t + 6, source: { type: "group", groupId: gid2, userId: "Uyy" }, message: { id: "70011", type: "text", text: "材料が届きました" } }]));
  const g2 = it("line_70011");
  eq([g2?.storeId, g2?.href, g2?.ref], [order.storeId, `/orders/${order.id}`, `案件 ${order.number}`], "案件のグループ → 案件の店舗・案件の画面");
  // ひも付けたときに保留を移す (notify = false) は通知を増やさない
  const before = F.inboundItems(db()).length;
  await store.mutate((d) => {
    const row = d.settings.find((s) => s.id === "line_groups");
    const g = row.value.groups.find((x) => x.id === gid2);
    IN.recordLineGroupMessage(d, g, { id: "70099", at: new Date(t).toISOString(), type: "text", text: "前のメッセージ" }, false, false);
  });
  eq(F.inboundItems(db()).length, before, "保留のメッセージを案件に移すときは通知を増やさない");

  if (supplier) {
    const res = await store.mutate((d) => IN.recordChatworkEvent(d, { webhook_event_type: "message_created", webhook_event: { message_id: "555", room_id: "998877", account_id: "1", body: "納期は来週の火曜です", send_time: Math.floor(t / 1000) } }));
    const cw = it("cw_555");
    eq([res, cw?.channel, cw?.from, cw?.storeId, cw?.href], ["recorded", "chatwork", supplier.name, "hq", `/suppliers/${supplier.id}`], "Chatwork の投稿 → 本部・管理者に知らせる・取引先の画面");
  }

  // 見る人ごと・ベルの行
  const mgr1 = user("store_manager", s1.id);
  const mgr2 = user("store_manager", s2.id);
  const seen1 = F.inboundForUser(db(), mgr1, { days: 7 }).map((i) => i.id);
  ok(seen1.includes("line_70001") && !seen1.includes("line_70010") && !seen1.includes("cw_555"), "店長 (お客様の店舗): お客様の LINE だけ (ほかの店舗・本部あては見ない)");
  const seen2 = F.inboundForUser(db(), mgr2, { days: 7 }).map((i) => i.id);
  ok(seen2.includes("line_70010") && seen2.includes("line_70011") && !seen2.includes("line_70001"), "店長 (ほかの店舗): 自店舗のグループ・案件だけ");
  const groups = F.inboundBellGroups(F.inboundForUser(db(), user("admin", s1.id), { days: 7 }));
  ok(groups.some((g) => g.channel === "line" && g.items.length >= 5) && (!supplier || groups.some((g) => g.channel === "chatwork")), "管理者のベル: 経路ごとに 1 行 (LINE・Chatwork)");
}

/* ================================================================== */
section("Slack (inbound/slack.ts)");
const SL = await imp("lib/inbound/slack.ts");
{
  const secret = "test-slack-signing";
  const body = JSON.stringify({ type: "event_callback" });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  ok(SL.verifySlackSignature(secret, body, ts, sig), "署名が合う");
  ok(!SL.verifySlackSignature(secret, body + " ", ts, sig), "本文が違えば断る");
  ok(!SL.verifySlackSignature("other", body, ts, sig), "鍵が違えば断る");
  ok(!SL.verifySlackSignature(secret, body, String(Number(ts) - 600), `v0=${createHmac("sha256", secret).update(`v0:${Number(ts) - 600}:${body}`).digest("hex")}`), "5 分より古い要求は断る (やり直しの攻撃)");
  eq(SL.slackPlainText("<@U01ABC> 確認お願いします <https://example.test/a|見積> &amp; <#C01XYZ|general> <!here>", { U01ABC: "亀井" }), "@亀井 確認お願いします 見積 & #general @here", "Slack の書式 → 読める文字");

  const base = Math.floor(Date.now() / 1000);
  const T = (n) => `${base + n}.000100`;
  const sid = (ch, n) => `slack_${ch}_${base + n}_000100`;
  const ev = (over) => ({ type: "event_callback", event_id: "Ev1", authorizations: [{ user_id: "UBOT", is_bot: true }], event: { type: "message", channel: "C0SLACK1", channel_type: "channel", user: "U01ABC", text: "店舗の在庫を確認してください", ts: T(0), ...over } });
  let r = await store.mutate((d) => SL.recordSlackEvent(d, ev({})));
  ok(r.recorded && r.user === "U01ABC" && r.channel === "C0SLACK1", "チャンネルのメッセージを記録し、名前を取得する ID を返す");
  const it = F.inboundItems(db()).find((i) => i.id === sid("C0SLACK1", 0));
  eq([it?.channel, it?.from, it?.fromDetail, it?.storeId], ["slack", "Slack のユーザー", "Slack のチャンネル", "hq"], "店舗を決めていないチャンネル → 本部・管理者");
  r = await store.mutate((d) => SL.recordSlackEvent(d, ev({})));
  ok(!r.recorded, "同じメッセージ (再送) は 1 件");
  for (const [over, label] of [[{ subtype: "message_changed", ts: T(1) }, "編集"], [{ bot_id: "B1", ts: T(2) }, "ボットの投稿"], [{ user: "UBOT", ts: T(3) }, "このアプリ自身の投稿"], [{ subtype: "channel_join", ts: T(4) }, "参加の知らせ"]]) {
    r = await store.mutate((d) => SL.recordSlackEvent(d, ev(over)));
    ok(!r.recorded, `${label} は通知にしない`);
  }
  r = await store.mutate((d) => SL.recordSlackEvent(d, ev({ subtype: "file_share", ts: T(5), files: [{ name: "現場.jpg" }] })));
  ok(r.recorded && F.inboundItems(db()).find((i) => i.id === sid("C0SLACK1", 5))?.text.includes("[ファイル] 現場.jpg"), "ファイルの共有は通知する (ファイル名つき)");
  // チャンネルの店舗を決める → その店舗に知らせる
  await store.mutate((d) => d.settings.push({ id: F.INBOUND_SETTINGS_ID, value: { slackStores: { C0SLACK1: s1.id } }, updatedBy: "t", updatedAt: new Date().toISOString() }));
  await store.mutate((d) => SL.recordSlackEvent(d, ev({ ts: T(6) })));
  eq(F.inboundItems(db()).find((i) => i.id === sid("C0SLACK1", 6))?.storeId, s1.id, "店舗を決めたチャンネル → その店舗");
  await store.mutate((d) => SL.recordSlackEvent(d, ev({ channel: "D0DM1", channel_type: "im", ts: T(7) })));
  eq(F.inboundItems(db()).find((i) => i.id === sid("D0DM1", 7))?.fromDetail, "DM", "DM は「DM」・本部・管理者");
  ok(F.slackSeenChannels(db()).C0SLACK1?.count >= 3 && !F.slackSeenChannels(db()).D0DM1, "届いたチャンネルの一覧 (設定で店舗を決める。DM は除く)");
  await store.mutate((d) => F.setSlackNames(d, { users: { U01ABC: "亀井" }, channels: { C0SLACK1: "現場連絡" } }));
  const named = F.inboundItems(db()).find((i) => i.id === sid("C0SLACK1", 0));
  eq([named?.from, named?.fromDetail, F.slackSeenChannels(db()).C0SLACK1?.name], ["亀井", "#現場連絡", "現場連絡"], "名前が分かったら送り主・チャンネル名を直す");

  // 名前の取得 (偽物の Slack API)
  const api = net.createServer((sock) => {
    sock.once("data", (buf) => {
      const line = buf.toString().split("\r\n")[0];
      const bodyJson = line.includes("users.info") ? { ok: true, user: { profile: { display_name: "平島" } } } : line.includes("conversations.info") ? { ok: true, channel: { name: "本部連絡" } } : { ok: false };
      const b = JSON.stringify(bodyJson);
      sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(b)}\r\nConnection: close\r\n\r\n${b}`);
    });
  });
  await new Promise((res) => api.listen(0, "127.0.0.1", res));
  process.env.SLACK_API_BASE = `http://127.0.0.1:${api.address().port}`;
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  const names = await SL.fetchSlackNames({ users: ["U02"], channels: ["C02"] });
  eq(names, { users: { U02: "平島" }, channels: { C02: "本部連絡" } }, "SLACK_BOT_TOKEN があれば送り主・チャンネルの名前を取得");
  delete process.env.SLACK_BOT_TOKEN;
  eq(await SL.fetchSlackNames({ users: ["U02"], channels: [] }), { users: {}, channels: {} }, "SLACK_BOT_TOKEN がなければ取得しない");
  api.close();
}

/* ================================================================== */
section("メールの記録 (mail-record.ts)");
const MR = await imp("lib/inbound/mail-record.ts");
{
  ok(MR.isBulkMail({ listUnsubscribe: true }) && MR.isBulkMail({ precedence: "bulk" }) && MR.isBulkMail({ autoSubmitted: "auto-generated" }) && !MR.isBulkMail({ autoSubmitted: "no" }) && !MR.isBulkMail({}), "自動送信・メールマガジンの見分け");
  eq(MR.mailBodyText("ご連絡ありがとうございます。\n\n> 前のメール\n> 引用\n\n2026年11月25日 10:00 一畳屋 <info@example.test>:\n古い本文"), "ご連絡ありがとうございます。", "引用・前のメールの全文を外す");
  eq(MR.mailBodyText("本文\n-----Original Message-----\nFrom: x"), "本文", "Original Message 以下を外す");
  const at = new Date().toISOString();
  let r = await store.mutate((d) => MR.recordMail(d, { fromAddress: "Yamada.Customer@example.test", fromName: "山田", subject: "見積について", text: "見積書を確認しました" }, { id: "mail_1_1", at }));
  const log = db().commLogs.find((c) => c.id === "cl_mail_1_1");
  const item = F.inboundItems(db()).find((i) => i.id === "mail_1_1");
  ok(r === "recorded" && log?.customerId === customer.id && log?.channel === "email" && log?.direction === "inbound", "お客様のメール → やりとり履歴 (受信) にも残す (アドレスの大文字小文字は区別しない)");
  eq([item?.from, item?.storeId, item?.href, item?.subject], [`${customer.name} 様`, customer.storeId, `/customers/${customer.id}`, "見積について"], "お客様のメール → その店舗に知らせる・お客様の画面");
  r = await store.mutate((d) => MR.recordMail(d, { fromAddress: "yamada.customer@example.test", subject: "見積について", text: "x" }, { id: "mail_1_1", at }));
  eq(r, "duplicate", "同じメールは 1 件");
  if (supplier) {
    await store.mutate((d) => MR.recordMail(d, { fromAddress: "sales@supplier.example.test", subject: "納期", text: "来週です" }, { id: "mail_1_2", at }));
    const si = F.inboundItems(db()).find((i) => i.id === "mail_1_2");
    eq([si?.from, si?.storeId, Boolean(db().commLogs.find((c) => c.id === "cl_mail_1_2")?.supplierId)], [supplier.name, "hq", true], "取引先のメール → 本部・管理者・やりとり履歴");
  }
  await store.mutate((d) => MR.recordMail(d, { fromAddress: "unknown@example.test", fromName: "知らない人", subject: "お問い合わせ", text: "和室の工事をお願いしたい" }, { id: "mail_1_3", at }));
  const un = F.inboundItems(db()).find((i) => i.id === "mail_1_3");
  ok(un?.storeId === "hq" && un.ref === "未登録の差出人" && !db().commLogs.some((c) => c.id === "cl_mail_1_3") && !db().inquiries.some((i) => (i.detail ?? "").includes("和室の工事をお願いしたい")), "未登録の差出人 → 本部・管理者に知らせるだけ (問い合わせは自動で作らない)");
  await store.mutate((d) => MR.recordMail(d, { fromAddress: "yamada.customer@example.test", subject: "セール", text: "広告", listUnsubscribe: true }, { id: "mail_1_4", at }));
  const bk = F.inboundItems(db()).find((i) => i.id === "mail_1_4");
  ok(bk?.bulk === true && !db().commLogs.some((c) => c.id === "cl_mail_1_4"), "メールマガジンは bulk (ベルに出さない・履歴に残さない)");
  ok(!F.inboundForUser(db(), user("admin", s1.id), { days: 7 }).some((i) => i.id === "mail_1_4") && F.inboundForUser(db(), user("admin", s1.id), { days: 7, includeBulk: true }).some((i) => i.id === "mail_1_4"), "一覧では「自動送信も表示」で見られる");
  r = await store.mutate((d) => MR.recordMail(d, { fromAddress: "info@example.test", subject: "控え", text: "x" }, { id: "mail_1_5", at, selfAddresses: ["INFO@example.test"] }));
  eq(r, "self", "自分のアドレスからのメールは記録しない");
}

/* ================================================================== */
section("メールの受信 (mail.ts。偽物の IMAP サーバー)");
{
  const require = createRequire(path.join(root, "package.json"));
  const Encoding = require("encoding-japanese");
  const now = new Date();
  const imapDate = (d) => {
    const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    return `${String(d.getUTCDate()).padStart(2, "0")}-${m}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;
  };
  const jis = (s) => Buffer.from(Encoding.convert(Encoding.stringToCode(s), { to: "JIS", from: "UNICODE" }));
  const b64 = (buf) => buf.toString("base64");
  const msg = (from, subjectRaw, extraHeaders, bodyBuf, charset = "UTF-8", cte = "8bit") =>
    Buffer.concat([Buffer.from(`From: ${from}\r\nTo: info@example.test\r\nSubject: ${subjectRaw}\r\nDate: ${now.toUTCString()}\r\nMessage-ID: <${Math.random()}@example.test>\r\nMIME-Version: 1.0\r\n${extraHeaders}Content-Type: text/plain; charset=${charset}\r\nContent-Transfer-Encoding: ${cte}\r\n\r\n`), bodyBuf, Buffer.from("\r\n")]);
  const messages = [
    { uid: 11, date: now, raw: msg(`=?ISO-2022-JP?B?${b64(jis("山田"))}?= <yamada.customer@example.test>`, `=?ISO-2022-JP?B?${b64(jis("日程の件"))}?=`, "", jis("来週の水曜日にお願いします。"), "ISO-2022-JP", "7bit") },
    { uid: 12, date: now, raw: msg("News <news@shop.example.test>", "Sale", "List-Unsubscribe: <mailto:u@shop.example.test>\r\n", Buffer.from("広告です")) },
    { uid: 13, date: now, raw: msg("一畳屋 <info@example.test>", "控え", "", Buffer.from("自分の送信")) },
  ];
  const commands = [];
  let uidValidity = 777;
  const server = net.createServer((sock) => {
    let buf = "";
    let selected = false;
    const send = (s) => sock.write(s);
    send("* OK [CAPABILITY IMAP4rev1] fake imap ready\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = line.match(/^(\S+) (\S+)(?: (.*))?$/);
        if (!m) continue;
        const [, tag, cmdRaw, args = ""] = m;
        const cmd = cmdRaw.toUpperCase();
        commands.push(`${cmd} ${args}`);
        if (cmd === "CAPABILITY") send(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (cmd === "LOGIN") send(/"?imapuser"? "?imappass"?/.test(args) ? `${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] bad\r\n`);
        else if (cmd === "LIST") send(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK done\r\n`);
        else if (cmd === "EXAMINE" || cmd === "SELECT") {
          selected = true;
          const max = Math.max(0, ...messages.map((x) => x.uid));
          send(`* FLAGS (\\Seen \\Answered)\r\n* ${messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${uidValidity}] ok\r\n* OK [UIDNEXT ${max + 1}] ok\r\n${tag} OK [${cmd === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] done\r\n`);
        } else if (cmd === "UID" && /^SEARCH/i.test(args)) {
          const um = args.match(/UID (\d+):\*/i);
          const found = um ? messages.filter((x) => x.uid >= Number(um[1])) : messages;
          send(`* SEARCH ${found.map((x) => x.uid).join(" ")}\r\n${tag} OK done\r\n`);
        } else if (cmd === "UID" && /^FETCH/i.test(args)) {
          const set = args.split(" ")[1];
          const want = new Set(set.split(",").map(Number));
          for (const [idx, x] of messages.entries()) {
            if (!want.has(x.uid)) continue;
            sock.write(`* ${idx + 1} FETCH (UID ${x.uid} INTERNALDATE "${imapDate(x.date)}" BODY[]<0> {${x.raw.length}}\r\n`);
            sock.write(x.raw);
            sock.write(")\r\n");
          }
          send(`${tag} OK done\r\n`);
        } else if (cmd === "LOGOUT") {
          send(`* BYE bye\r\n${tag} OK done\r\n`);
          sock.end();
        } else send(`${tag} OK done\r\n`);
      }
    });
    sock.on("error", () => {});
    void selected;
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  Object.assign(process.env, { INBOUND_MAIL_HOST: "127.0.0.1", INBOUND_MAIL_PORT: String(server.address().port), INBOUND_MAIL_USER: "imapuser", INBOUND_MAIL_PASSWORD: "imappass", INBOUND_MAIL_SECURE: "false", MAIL_FROM: "一畳屋 <info@example.test>" });
  const M = await imp("lib/inbound/mail.ts");
  eq(M.inboundMailConfig()?.source, "INBOUND_MAIL_*", "接続先は INBOUND_MAIL_* (なければ SMTP_*)");
  let r = await M.pollInboundMail({ force: true });
  eq(r.skipped, "disabled", "設定でオンにするまで読まない");
  await store.mutate((d) => {
    const row = d.settings.find((s) => s.id === F.INBOUND_SETTINGS_ID);
    row.value = { ...row.value, mailEnabled: true };
  });
  r = await M.pollInboundMail({ force: true });
  ok(r.ok && r.baseline && r.recorded === 2, `最初の 1 回: 直近 24 時間を読む (お客様 1 通・メールマガジン 1 通。自分の送信は除く) (${JSON.stringify(r)})`);
  const jp = F.inboundItems(db()).find((i) => i.id === "mail_777_11");
  eq([jp?.subject, jp?.text, jp?.from, jp?.storeId], ["日程の件", "来週の水曜日にお願いします。", `${customer.name} 様`, customer.storeId], "日本語 (ISO-2022-JP) の件名・本文を読み、お客様の店舗に知らせる");
  ok(F.inboundItems(db()).find((i) => i.id === "mail_777_12")?.bulk === true && !F.inboundItems(db()).some((i) => i.id === "mail_777_13"), "メールマガジンは bulk・自分の送信は記録しない");
  ok(commands.some((c) => c.startsWith("EXAMINE")) && !commands.some((c) => c.startsWith("SELECT")), "メールボックスは読み取り専用で開く (EXAMINE)");
  ok(commands.filter((c) => /FETCH/i.test(c)).every((c) => /BODY\.PEEK\[\]/i.test(c)), "本文は BODY.PEEK で読む (未読のまま)");
  ok(!commands.some((c) => /^(STORE|EXPUNGE|COPY|MOVE|DELETE)\b/i.test(c) || /^UID (STORE|EXPUNGE|COPY|MOVE)/i.test(c)), "フラグの変更・削除・移動をしない");
  eq(F.inboundMailState(db()).lastUid, 13, "読んだところまで進める (UID 13)");

  messages.push({ uid: 14, date: new Date(), raw: msg("Unknown <someone@example.test>", "Hello", "", Buffer.from("はじめまして")) });
  commands.length = 0;
  r = await M.pollInboundMail({ force: true });
  ok(r.ok && !r.baseline && r.recorded === 1 && F.inboundItems(db()).some((i) => i.id === "mail_777_14"), `2 回目: 新しいメールだけ (${JSON.stringify(r)})`);
  ok(commands.some((c) => /SEARCH UID 14:\*/i.test(c)), "2 回目は前回より新しい UID だけを探す");
  r = await M.pollInboundMail({ force: true });
  ok(r.ok && r.recorded === 0, "新しいメールがなければ 0 通");
  r = await M.pollInboundMail({});
  eq(r.skipped, "throttled", "画面の読み込みからは 2 分に 1 回まで");

  // UIDVALIDITY が変わった → 起点を作り直す (同じメールを別の ID で二重に知らせないよう、直近 24 時間の 20 通までに限る)
  uidValidity = 888;
  r = await M.pollInboundMail({ force: true });
  ok(r.ok && r.baseline, "UIDVALIDITY が変わったら起点を作り直す");

  process.env.INBOUND_MAIL_PASSWORD = "wrong";
  r = await M.pollInboundMail({ force: true });
  ok(!r.ok && /ログインできませんでした/.test(r.error ?? "") && /ログインできませんでした/.test(F.inboundMailState(db()).lastError ?? ""), `ログインの失敗は分かる言葉で残す (${r.error})`);
  server.close();
}

console.log(`\n${pass} passed, ${fails.length} failed`);
fs.rmSync(work, { recursive: true, force: true });
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
process.exit(0);
