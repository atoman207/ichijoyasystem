/**
 * チャット (チャンネル・DM・要対応・プッシュ通知) のテスト。お客様のご要望 2026-11-25 (other/docs/16〜18)
 *   node scripts/tests/chat/chat.test.mjs   (npm run test:chat)
 * 1. プッシュ通知の暗号 (RFC 8291 の付録の値)・VAPID の署名・手元の偽の配信サーバーで復号できるか・無効な端末の削除
 * 2. 本文 (メンションの印・URL・案件の番号・入力中の @)
 * 3. 見られる人 (全社・店舗・店長・追加したチャンネル・DM。DM は管理者も見られない)
 * 4. 送る・重要 (確認・再通知)・@全員・DM・グループ・チャンネルの追加・資料の公開範囲・業務依頼・スレッド・編集・削除・既読・要対応の数
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ) とチャットの SQLite。名前は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-chat-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "chat-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  CHAT_DB_PATH: path.join(work, "chat.sqlite"),
  PUSH_VAPID_FILE: path.join(work, "push-vapid.json"),
  PUSH_ALLOW_ANY_ENDPOINT: "1",
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-chat",
  APP_BASE_URL: "https://chat-test.example",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_|PUSH_VAPID_PUBLIC|PUSH_VAPID_PRIVATE)/.test(k)) delete process.env[k];
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
const as = async (user, fn) => {
  globalThis.__testUser = user;
  try {
    return await fn();
  } finally {
    globalThis.__testUser = undefined;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PC = await imp("lib/notify/push-crypto.ts");
const PU = await imp("lib/notify/push.ts");
const T = await imp("lib/chat/text.ts");
const store = await imp("lib/db/store.ts");
const P = await imp("lib/auth/permissions.ts");
const C = await imp("lib/chat/channels.ts");
const R = await imp("lib/chat/repo.ts");
const I = await imp("lib/chat/inbox.ts");
const A = await imp("lib/actions/chat.ts");
const DB = await imp("lib/chat/db.ts");

/* ================================================================== */
section("1. プッシュ通知の暗号・署名・配信");
{
  const body = PC.encryptPayload(Buffer.from("When I grow up, I want to be a watermelon"), "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg", {
    salt: PC.fromB64u("DGv6ra1nlYgDCS1FRnbzlw"),
    asPrivate: PC.fromB64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  });
  eq(PC.b64u(body), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN", "本文の暗号が RFC 8291 付録 A の値と一致する");

  const keys = PC.generateVapidKeys();
  ok(PC.validVapid(keys), "作った VAPID の鍵の形が正しい (公開鍵 65 バイト・秘密鍵 32 バイト・組が合う)");
  ok(!PC.validVapid({ publicKey: keys.publicKey, privateKey: PC.generateVapidKeys().privateKey }), "公開鍵と秘密鍵の組が合わないときは使わない");
  const auth = PC.vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://chat-test.example", Date.parse("2026-11-26T00:00:00Z"));
  const m = auth.match(/^vapid t=([^,]+), k=(.+)$/);
  ok(Boolean(m) && m[2] === keys.publicKey, "Authorization は「vapid t=<JWT>, k=<公開鍵>」");
  const [h, c, sig] = m[1].split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  eq([JSON.parse(Buffer.from(h, "base64url").toString()).alg, claims.aud, claims.sub, claims.exp], ["ES256", "https://fcm.googleapis.com", "https://chat-test.example", Date.parse("2026-11-26T12:00:00Z") / 1000], "JWT: ES256・aud = 配信サービスの origin・sub・期限 12 時間");
  const pub = PC.fromB64u(keys.publicKey);
  const pubKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: PC.b64u(pub.subarray(1, 33)), y: PC.b64u(pub.subarray(33)) }, format: "jwk" });
  ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: pubKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), "JWT の署名を公開鍵で確かめられる");

  ok(PU.allowedEndpoint("https://fcm.googleapis.com/fcm/send/x") && PU.allowedEndpoint("https://web.push.apple.com/abc") && PU.allowedEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"), "配信先: Google・Apple・Mozilla の配信サービスを受け付ける");
  delete process.env.PUSH_ALLOW_ANY_ENDPOINT;
  ok(!PU.allowedEndpoint("https://evil.example/push") && !PU.allowedEndpoint("http://127.0.0.1:3000/api"), "配信先: ほかのサイト・社内のサーバーは受け付けない");
  process.env.PUSH_ALLOW_ANY_ENDPOINT = "1";
}

// 手元の偽の配信サーバー (届いた通知を端末の鍵で復号して確かめる)
const received = [];
let respond = 201;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(respond);
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
function device() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return { ecdh, p256dh: PC.b64u(ecdh.getPublicKey()), auth: PC.b64u(authSecret), authSecret };
}
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
function decrypt(dev, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = dev.ecdh.computeSecret(asPub);
  const ikm = hmac(hmac(dev.authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), dev.ecdh.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}

/* ================================================================== */
section("2. 本文 (メンション・リンク)");
const db = () => store.getDb();
const users = db().users.filter((u) => u.active);
const stores = db().stores;
const S = stores.find((s) => s.kind === "store").id;
const S2 = stores.filter((s) => s.kind === "store")[1].id;
const now = new Date().toISOString();
// テスト用の社員 (架空の名前)
await store.mutate((x) => {
  const mk = (id, name, kana, role, storeId) => x.users.push({ id, name, kana, email: `${id}@example.test`, role, title: "", storeId, active: true, createdAt: now, updatedAt: now });
  mk("u_ct_mgr", "試験 店長", "しけん てんちょう", "store_manager", S);
  mk("u_ct_a", "試験 花子", "しけん はなこ", "store_staff", S);
  mk("u_ct_b", "試験 次郎", "しけん じろう", "store_staff", S);
  mk("u_ct_x", "別店 三郎", "べってん さぶろう", "store_staff", S2);
  mk("u_ct_hq", "本部 四郎", "ほんぶ しろう", "hq_staff", stores.find((s) => s.kind === "hq")?.id ?? S);
  mk("u_ct_admin", "社長 五郎", "しゃちょう ごろう", "admin", stores.find((s) => s.kind === "hq")?.id ?? S);
  mk("u_ct_gone", "退職 六郎", "たいしょく ろくろう", "store_staff", S);
  x.users.find((u) => u.id === "u_ct_gone").active = false;
});
const U = (id) => db().users.find((u) => u.id === id);
const mgr = U("u_ct_mgr");
const a = U("u_ct_a");
const b = U("u_ct_b");
const x2 = U("u_ct_x");
const hq = U("u_ct_hq");
const admin = U("u_ct_admin");
{
  const ctx = { users: db().users.map((u) => ({ id: u.id, name: u.name })), stores: stores.map((s) => ({ id: s.id, name: s.name })), allowAll: false };
  const enc = T.encodeMentions("@試験花子 さん、@試験 店長 と @" + stores.find((s) => s.id === S).name + " へ。@全員 info@example.com", ctx);
  ok(enc.includes("<@u_ct_a>") && enc.includes("<@u_ct_mgr>") && enc.includes(`<!store:${S}>`), "@名前 (空白あり・なし)・@店舗 を印にする");
  ok(enc.includes("@全員") && !enc.includes("<!all>"), "@全員 は使える人 (管理者・本部・店長) だけが印になる");
  ok(enc.includes("info@example.com"), "メールアドレスの @ はメンションにしない");
  ok(T.encodeMentions("@全員 確認", { ...ctx, allowAll: true }).startsWith("<!all>"), "店長以上の @全員 は <!all>");
  eq(T.parseMentions("<@u1> と <@u2> <!all> <!store:koshi> <@u1>"), { userIds: ["u1", "u2"], all: true, storeIds: ["koshi"] }, "印からメンションを読む (重複なし)");
  eq(T.decodeMentions(enc, ctx).startsWith("@試験花子"), true, "印を「@名前」に戻す (編集・通知の文)");
  const seg = T.segments("見積 Q-2026-0012 と https://example.com/a?b=1 を確認 <@u_ct_a>", [{ text: "Q-2026-0012", href: "/quotes/q1" }]);
  eq(seg.map((x) => x.kind), ["text", "case", "text", "url", "text", "user"], "本文を 文字・案件の番号・URL・メンション に分ける");
  eq(T.caseNumbers("O-2026-0001, INQ-2026-0012。XO-2026-0003 Q-2026-12"), ["O-2026-0001", "INQ-2026-0012"], "案件の番号 (受注・問い合わせ。ほかの文字に続くものは除く)");
  eq(T.mentionQuery("おはよう @しけ", "おはよう @しけ".length), { start: 5, query: "しけ" }, "入力中の @ の候補を出す位置");
  eq(T.mentionQuery("mail@exa", 8), null, "メールアドレスの途中では候補を出さない");
  eq(T.chatNavKey(new URLSearchParams("c=all&m=x")), T.chatNavKey({ c: "all", m: "x" }), "画面の場所の印 (URL とサーバーで同じ)");
}

/* ================================================================== */
section("3. 見られる人");
{
  const sys = C.systemChannels(db());
  const st = sys.find((c) => c.id === `store:${S}`);
  ok(st.memberIds.includes(a.id) && st.memberIds.includes(mgr.id) && !st.memberIds.includes(x2.id) && !st.memberIds.includes("u_ct_gone"), "店舗のチャンネル: その店舗の有効な社員 (退職した社員・ほかの店舗は入らない)");
  const mg = sys.find((c) => c.id === "managers");
  ok(mg.memberIds.includes(mgr.id) && mg.memberIds.includes(hq.id) && mg.memberIds.includes(admin.id) && !mg.memberIds.includes(a.id), "店長のチャンネル: 店長・本部・管理者 (店舗スタッフは入らない)");
  ok(sys[0].id === "all" && sys[sys.length - 1].id === "managers", "並び: 全社 → 店舗 → 店長");
  const hqStore = stores.find((s) => s.kind === "hq");
  if (hqStore) eq(sys.find((c) => c.storeId === hqStore.id)?.name, hqStore.shortName?.trim() || "本部", "本部・ショールームのチャンネルの名前は「本部」");
  ok(P.canViewChatChannel(x2, st) === false && P.canViewChatChannel(hq, st) && P.canViewChatChannel(admin, st), "店舗のチャンネル: ほかの店舗の社員は見られない・本部と管理者は見られる");
  ok(!P.canViewChatChannel(a, mg) && P.canViewChatChannel(mgr, mg), "店長のチャンネル: 店舗スタッフは見られない");
  const dm = { kind: "dm", memberIds: [a.id, b.id] };
  ok(P.canViewChatChannel(a, dm) && !P.canViewChatChannel(admin, dm) && !P.canViewChatChannel(hq, dm), "DM: 参加している本人だけ (管理者・本部も見られない)");
  ok(!P.canViewChatChannel({ ...a, active: false }, { kind: "all", memberIds: [] }), "退職した社員はどのチャンネルも見られない");
  ok(P.canViewChatFile(mgr, "managers") && P.canViewChatFile(hq, "managers") && !P.canViewChatFile(a, "managers") && P.canViewChatFile(a, "members"), "「店長以上だけ」の資料は店長・本部・管理者だけ");
}

/* ================================================================== */
section("4. 送る・メンション・要対応");
const chS = `store:${S}`;
const send = (user, input) => as(user, () => A.sendChatMessage(input));
const state = (user) => I.chatState(db(), user);
{
  const r0 = await send(x2, { channelId: chS, body: "ほかの店舗から" });
  ok(!r0.ok && /権限/.test(r0.error), "ほかの店舗の社員は店舗のチャンネルに送れない");
  const before = state(mgr).counts.action;
  const order = db().orders.find((o) => o.number);
  const r1 = await send(a, { channelId: chS, body: `@試験店長 在庫を確認しました ${order?.number ?? ""} https://example.com` });
  ok(r1.ok && r1.data.message.mentions.includes(mgr.id), "送れる・@名前 を印にしてメンションの宛先にする");
  if (order) eq(r1.data.message.links, [{ text: order.number, href: `/orders/${order.id}` }], "受注の番号を受注の画面へのリンクにする");
  const s1 = state(mgr);
  eq(s1.counts.action, before + 1, "メンションされた店長の要対応が 1 増える");
  ok(s1.inbox.some((i) => i.kind === "mention" && i.messageId === r1.data.message.id), "要対応の一覧に「メンション」で出る");
  ok(s1.channels.find((c) => c.id === chS).mentions >= 1, "チャンネルの一覧の赤い数字にも出る");
  const sb = state(b);
  ok(sb.channels.find((c) => c.id === chS).unread >= 1 && !sb.inbox.some((i) => i.messageId === r1.data.message.id), "ほかのメンバーは未読 (要対応には入らない)");
  eq(sb.counts.unread, 0, "店舗のチャンネルの既定は「自分あてだけ」なので、青い数字 (未読) には数えない");
  await as(b, () => A.setChatChannelNotify(chS, "all"));
  ok(state(b).counts.unread >= 1, "「すべて通知」にすると青い数字に数える");
  await as(mgr, () => A.markChatRead(chS, r1.data.message.at));
  eq(state(mgr).counts.action, before, "読むと (既読) メンションは要対応から消える");
  const bad = await as(a, () => A.markChatRead("dm:zzz+yyy", now));
  ok(!bad.ok, "見られないチャンネルは既読にできない");
  const r2 = await send(a, { channelId: chS, body: "@全員 見てください" });
  ok(!r2.ok && /全員/.test(r2.error), "店舗スタッフは @全員 を使えない");
  const r3 = await send(mgr, { channelId: chS, body: "@全員 明日は棚卸しです" });
  ok(r3.ok && r3.data.message.mentionAll, "店長は @全員 を使える");
  ok(state(b).inbox.some((i) => i.messageId === r3.data.message.id && i.kind === "mention"), "@全員 はメンバー全員の要対応 (メンション) になる");
  const r4 = await send(mgr, { channelId: chS, body: `@${stores.find((s) => s.id === S2).name} 応援をお願いします` });
  ok(r4.ok && !state(x2).inbox.some((i) => i.messageId === r4.data.message.id), "@ほかの店舗 は、このチャンネルを見られない人には届かない");
  const empty = await send(a, { channelId: chS, body: "   " });
  ok(!empty.ok, "空のメッセージは送れない");
}

/* ================================================================== */
section("5. 重要メッセージ (確認・再通知)");
let impId = "";
{
  const r0 = await send(a, { channelId: chS, body: "重要です", important: true });
  ok(!r0.ok && /重要/.test(r0.error), "店舗スタッフは重要メッセージを送れない");
  const r1 = await send(mgr, { channelId: chS, body: "【必読】年末の営業時間", important: true });
  ok(r1.ok && r1.data.message.important, "店長は重要メッセージを送れる");
  impId = r1.data.message.id;
  const v = r1.data.message.ack;
  ok(v && v.total === C.systemChannels(db()).find((c) => c.id === chS).memberIds.length - 1 && v.done === 0, "確認する人 = チャンネルのメンバー (送った人を除く)");
  ok(state(a).inbox.some((i) => i.kind === "important" && i.messageId === impId), "受け取った人の要対応に「重要」で出る");
  await as(a, () => A.markChatRead(chS, new Date().toISOString()));
  ok(state(a).inbox.some((i) => i.kind === "important" && i.messageId === impId), "読んだだけでは消えない (「確認しました」まで残る)");
  const ackX = await as(x2, () => A.ackChatMessage(impId));
  ok(!ackX.ok, "見られない人は確認できない");
  const ackA = await as(a, () => A.ackChatMessage(impId));
  ok(ackA.ok && !state(a).inbox.some((i) => i.messageId === impId), "「確認しました」で要対応から消える");
  const viewM = R.toViews(mgr, [R.getMessage(impId)], db())[0];
  ok(viewM.ack.done === 1 && viewM.ack.ackedIds.includes(a.id) && viewM.ack.pendingIds.includes(b.id), "送った人は確認した人・まだの人が分かる");
  const viewB = R.toViews(b, [R.getMessage(impId)], db())[0];
  ok(viewB.ack.pendingIds === undefined && viewB.ack.required, "店舗スタッフには確認の一覧 (名前) を出さない");
  const rem0 = await as(b, () => A.remindChatMessage(impId));
  ok(!rem0.ok, "再通知できるのは送った人と管理者");
  const rem1 = await as(mgr, () => A.remindChatMessage(impId));
  ok(rem1.ok && rem1.data.count === viewM.ack.pendingIds.length, "まだの人にもう一度知らせる");
  const rem2 = await as(mgr, () => A.remindChatMessage(impId));
  ok(!rem2.ok && /10 分/.test(rem2.error), "続けての再通知は 10 分あける");
}

/* ================================================================== */
section("6. DM (管理者も見られない)・グループ・プッシュ通知");
let dmId = "";
{
  const o1 = await as(a, () => A.openDirect([b.id]));
  dmId = o1.data.channelId;
  eq(dmId, C.directId(a.id, b.id), "1 対 1 の DM の ID は 2 人で決まる");
  const o2 = await as(b, () => A.openDirect([a.id]));
  eq(o2.data.channelId, dmId, "相手から開いても同じ DM");
  // b の端末を登録 (偽の配信サーバー)
  const dev = device();
  PU.saveSubscription(b.id, { endpoint: `http://127.0.0.1:${port}/push/b`, p256dh: dev.p256dh, auth: dev.auth, ua: "test" });
  received.length = 0;
  const r = await send(a, { channelId: dmId, body: "明日の件、よろしくお願いします" });
  ok(r.ok, "DM を送れる");
  await sleep(300);
  const got = received.find((x) => x.url === "/push/b");
  ok(Boolean(got), "DM の相手の端末にプッシュ通知が届く (DM の既定は「すべて通知」)");
  if (got) {
    const p = decrypt(dev, got.body);
    eq([p.title, p.body.includes("明日の件"), p.url.startsWith(`/chat?c=${encodeURIComponent(dmId)}&m=`)], [a.name, true, true], "通知を端末の鍵で復号できる (送った人・本文・開く画面)");
    eq([got.headers["content-encoding"], got.headers.urgency, /^vapid t=/.test(got.headers.authorization)], ["aes128gcm", "normal", true], "通知のヘッダー (aes128gcm・通常の優先度・VAPID)");
  }
  const sb = state(b);
  ok(sb.counts.unread >= 1 && !sb.inbox.some((i) => i.messageId === r.data.message.id), "DM は未読 (青) で、要対応 (赤) とは分ける");
  ok(!I.chatState(db(), admin).channels.some((c) => c.id === dmId), "管理者のチャンネルの一覧に他人の DM は出ない");
  const s = await as(admin, () => A.sendChatMessage({ channelId: dmId, body: "のぞき見" }));
  ok(!s.ok, "管理者も他人の DM には送れない・見られない");
  const found = R.searchMessages(C.visibleChannels(db(), admin).map((c) => c.id), "明日の件");
  eq(found.length, 0, "管理者の検索に他人の DM は出ない");
  ok(!P.canDeleteChatMessage(admin, { userId: a.id }, { kind: "dm" }) && P.canDeleteChatMessage(admin, { userId: a.id }, { kind: "store" }), "管理者が消せるのはチャンネルの投稿だけ (DM は本人だけ)");
  // 優先の通知 (メンション) は「自分あてだけ」のチャンネルでも届く
  received.length = 0;
  await send(mgr, { channelId: chS, body: "@試験次郎 至急" });
  await sleep(300);
  const pr = received.find((x) => x.url === "/push/b");
  ok(Boolean(pr) && pr.headers.urgency === "high" && decrypt(dev, pr.body).title.startsWith("@あなた"), "メンションは優先の通知 (高い優先度・「@あなた」) で届く");
  // 通常のメッセージは「自分あてだけ」なら送らない
  await as(b, () => A.setChatChannelNotify(chS, "priority"));
  received.length = 0;
  await send(mgr, { channelId: chS, body: "通常の連絡" });
  await sleep(300);
  ok(!received.some((x) => x.url === "/push/b"), "「自分あてだけ」のチャンネルの通常のメッセージは送らない");
  // 本人がプッシュ通知をオフ
  await as(b, () => A.setChatPrefs({ sound: true, push: false }));
  received.length = 0;
  await send(a, { channelId: dmId, body: "オフのとき" });
  await sleep(300);
  ok(!received.some((x) => x.url === "/push/b"), "本人がプッシュ通知をオフにすると送らない");
  await as(b, () => A.setChatPrefs({ sound: true, push: true }));
  // 無効になった端末 (410) は登録を消す
  respond = 410;
  await send(a, { channelId: dmId, body: "古い端末" });
  await sleep(300);
  eq(PU.subscriptionsOf(b.id).length, 0, "配信サービスが 410 を返した端末の登録は消す");
  respond = 201;
  // グループ
  const g1 = await as(a, () => A.openDirect([b.id, x2.id]));
  const g2 = await as(x2, () => A.openDirect([a.id, b.id]));
  ok(g1.ok && g1.data.channelId.startsWith("dm_") && g2.data.channelId === g1.data.channelId, "数人の DM: 同じ顔ぶれなら同じ DM を開く");
  const many = await as(a, () => A.openDirect(users.slice(0, 12).map((u) => u.id)));
  ok(!many.ok || many.data, "DM の人数の上限を確かめる");
}

/* ================================================================== */
section("7. チャンネルの追加・資料の公開範囲");
{
  const c0 = await as(a, () => A.createChatChannel({ name: "雑談", memberIds: [], visibility: "public" }));
  ok(c0.ok, "店舗スタッフもチャンネルを作れる (誰でも。公開のチャンネルはメンバーなしでよい)");
  const c0b = await as(a, () => A.createChatChannel({ name: "内緒", memberIds: [], visibility: "private" }));
  ok(!c0b.ok, "非公開のチャンネルはメンバーを 1 人以上選ぶ");
  const c1 = await as(mgr, () => A.createChatChannel({ name: "#勉強会", topic: "新商品", memberIds: [a.id], visibility: "private" }));
  ok(c1.ok, "店長は非公開のチャンネルを作れる");
  const id = c1.data.channelId;
  const ch = C.findChannel(db(), id);
  eq([ch.name, ch.memberIds.sort()], ["勉強会", [a.id, mgr.id].sort()], "名前の # を外し、作った人もメンバーになる");
  ok(!P.canViewChatChannel(b, ch) && !P.canViewChatChannel(admin, ch), "追加したチャンネルはメンバーだけ (管理者もメンバーでなければ見られない)");
  const u1 = await as(a, () => A.updateChatChannel(id, { name: "x", memberIds: [] }));
  ok(!u1.ok, "作った人・管理者以外は変えられない");
  await as(mgr, () => A.updateChatChannel(id, { name: "勉強会", memberIds: [a.id, b.id] }));
  ok(P.canViewChatChannel(b, C.findChannel(db(), id)), "メンバーを足すと見られる");
  ok(db().auditLogs.some((l) => l.entity === "chat_channel" && l.entityId === id && l.action === "update" && l.changes?.some((c) => c.field === "members")), "チャンネルの変更は変更履歴に残す (メンバーの増減)");
  const lv = await as(b, () => A.leaveChatChannel(id));
  ok(lv.ok && !P.canViewChatChannel(b, C.findChannel(db(), id)), "メンバーは自分で抜けられる");
  const lv2 = await as(mgr, () => A.leaveChatChannel(id));
  ok(!lv2.ok, "作った人は抜けられない (アーカイブする)");
  const ar = await as(mgr, () => A.archiveChatChannel(id, true));
  ok(ar.ok && !C.visibleChannels(db(), mgr).some((c) => c.id === id), "アーカイブすると一覧から外れる");
  const sendArchived = await send(mgr, { channelId: id, body: "x" });
  ok(!sendArchived.ok, "アーカイブしたチャンネルには送れない");

  // 資料 (預けたファイル → 送る)
  const fake = (by, ch, name) => {
    const fid = `cf_${Math.random().toString(36).slice(2)}`;
    R.saveUpload({ id: fid, userId: by.id, channelId: ch, file: { id: fid, name, type: "application/pdf", size: 10, photo: false, access: "members", key: `chat/test/${fid}.pdf`, uploadedBy: by.id }, at: new Date().toISOString() });
    return fid;
  };
  const f1 = fake(a, chS, "見積の控え.pdf");
  const s1 = await send(a, { channelId: chS, body: "", uploadIds: [f1], fileAccess: { [f1]: "managers" } });
  ok(!s1.ok && /店長以上/.test(s1.error), "店舗スタッフは資料を「店長以上だけ」にできない");
  const s2 = await send(a, { channelId: chS, body: "", uploadIds: [f1] });
  ok(s2.ok && s2.data.message.files.length === 1, "本文がなくても資料だけ送れる");
  const again = await send(a, { channelId: chS, body: "", uploadIds: [f1] });
  ok(!again.ok, "同じ預かりのファイルは 2 回送れない");
  const f2 = fake(mgr, chS, "人事の資料.pdf");
  const s3 = await send(mgr, { channelId: chS, body: "店長以上の資料", uploadIds: [f2], fileAccess: { [f2]: "managers" } });
  ok(s3.ok && s3.data.message.files[0].access === "managers", "店長は「店長以上だけ」の資料を送れる");
  const asStaff = R.toViews(a, [R.getMessage(s3.data.message.id)], db())[0];
  eq([asStaff.files.length, asStaff.hiddenFiles], [0, 1], "店舗スタッフには見えない (数だけ出す)");
  const f3 = fake(a, chS, "x.pdf");
  const s4 = await send(b, { channelId: chS, body: "", uploadIds: [f3] });
  ok(!s4.ok, "ほかの人が預けたファイルは使えない");
}

/* ================================================================== */
section("7b. 公開のチャンネル・メンバー・ピン留め・後で見る・未読にする・スター・共有");
{
  const pub = (await as(a, () => A.createChatChannel({ name: "現場の写真", memberIds: [b.id], visibility: "public" }))).data.channelId;
  const ch = () => C.findChannel(db(), pub);
  ok(P.canViewChatChannel(x2, ch()) && !P.canPostChatChannel(x2, ch()), "公開のチャンネル: ほかの店舗の社員も見られる (参加するまで送れない)");
  ok(!I.chatState(db(), x2).channels.some((c) => c.id === pub), "参加していない公開のチャンネルはサイドバーに出さない (チャンネルを探すから)");
  const s0 = await send(x2, { channelId: pub, body: "参加前" });
  ok(!s0.ok && /参加/.test(s0.error), "参加する前は送れない");
  const j = await as(x2, () => A.joinChatChannel(pub));
  ok(j.ok && ch().memberIds.includes(x2.id) && I.chatState(db(), x2).channels.some((c) => c.id === pub && c.joined && c.canPost), "「チャンネルに参加」でメンバーになり送れる");
  const add = await as(b, () => A.addChatMembers(pub, [hq.id]));
  ok(add.ok && ch().memberIds.includes(hq.id), "メンバーなら誰でもメンバーを追加できる");
  const addX = await as(admin, () => A.addChatMembers(pub, [mgr.id]));
  ok(!addX.ok, "メンバーでない人は追加できない");
  const rmB = await as(b, () => A.removeChatMember(pub, hq.id));
  ok(!rmB.ok, "メンバーを外せるのは作成した人・管理者だけ");
  const rmCreator = await as(admin, () => A.removeChatMember(pub, a.id));
  ok(!rmCreator.ok, "作成した人は外せない");
  const rm = await as(a, () => A.removeChatMember(pub, hq.id));
  ok(rm.ok && !ch().memberIds.includes(hq.id), "作成した人はメンバーを外せる");
  const priv = (await as(mgr, () => A.createChatChannel({ name: "非公開の相談", memberIds: [a.id], visibility: "private" }))).data.channelId;
  ok(!P.canViewChatChannel(x2, C.findChannel(db(), priv)) && !(await as(x2, () => A.joinChatChannel(priv))).ok, "非公開のチャンネルは見られない・参加できない");

  // ピン留め・後で見る
  const m1 = (await send(a, { channelId: pub, body: "*大事* な手順は _ここ_ にまとめます\n・手順 1\n・手順 2" })).data.message;
  const pinX = await as(admin, () => A.pinChatMessage(m1.id, true));
  ok(!pinX.ok, "メンバーでない人はピン留めできない");
  ok((await as(b, () => A.pinChatMessage(m1.id, true))).ok, "メンバーはピン留めできる");
  eq(R.pinnedMessages(pub).map((m) => m.id), [m1.id], "ピン留めの一覧に出る");
  ok(I.chatState(db(), b).channels.find((c) => c.id === pub).pinCount === 1, "チャンネルのピン留めの数");
  ok(R.toViews(a, [R.getMessage(m1.id)], db())[0].pinnedBy === b.id, "誰がピン留めしたか分かる");
  await as(b, () => A.pinChatMessage(m1.id, false));
  eq(R.pinnedMessages(pub).length, 0, "ピン留めを外せる");
  await as(x2, () => A.saveChatMessage(m1.id, true));
  ok(R.savedMessages(x2.id).some((m) => m.id === m1.id) && R.toViews(x2, [R.getMessage(m1.id)], db())[0].saved && !R.toViews(a, [R.getMessage(m1.id)], db())[0].saved, "「後で見る」は自分だけの保存");
  await as(x2, () => A.saveChatMessage(m1.id, false));
  eq(R.savedMessages(x2.id).length, 0, "「後で見る」から外せる");

  // 未読にする
  const m2 = (await send(a, { channelId: pub, body: "@試験次郎 明日の件" })).data.message;
  await as(b, () => A.markChatRead(pub, new Date().toISOString()));
  ok(!I.chatState(db(), b).inbox.some((i) => i.messageId === m2.id), "読むとメンションは消える");
  await as(b, () => A.markChatUnread(m2.id));
  ok(I.chatState(db(), b).inbox.some((i) => i.messageId === m2.id) && I.chatState(db(), b).channels.find((c) => c.id === pub).unread >= 1, "「ここから未読にする」でメンション・未読に戻る");

  // スター
  await as(b, () => A.starChatChannel(pub, true));
  ok(I.chatState(db(), b).channels.find((c) => c.id === pub).starred && !I.chatState(db(), a).channels.find((c) => c.id === pub).starred, "スターは自分だけ");

  // リアクション (絵文字の一覧から)
  ok((await as(b, () => A.reactChatMessage(m1.id, "🔥"))).ok, "絵文字の一覧のリアクションを付けられる");

  // 共有 (転送): DM のメッセージを公開のチャンネルへ
  const dmAB = C.directId(a.id, b.id);
  const dmMsg = (await send(a, { channelId: dmAB, body: "DM の内容です" })).data.message;
  const sh0 = await as(b, () => A.shareChatMessage(dmMsg.id, priv, "見てください"));
  ok(!sh0.ok, "参加していないチャンネルには共有できない");
  const sh = await as(b, () => A.shareChatMessage(dmMsg.id, pub, "見てください"));
  ok(sh.ok && sh.data.message.shared?.body === "DM の内容です" && sh.data.message.shared?.channelName === "DM", "共有すると写しが届く (どこからの共有か)");
  const shX = await as(x2, () => A.shareChatMessage(dmMsg.id, pub, ""));
  ok(!shX.ok, "見られないメッセージ (他人の DM) は共有できない");

  // スレッドの「チャンネルにも送信」
  const r1 = await send(b, { channelId: pub, parentId: m1.id, body: "チャンネルにも出す返信", alsoChannel: true });
  const r2 = await send(b, { channelId: pub, parentId: m1.id, body: "スレッドだけの返信" });
  const list = R.channelMessages(pub).rows.map((m) => m.id);
  ok(list.includes(r1.data.message.id) && !list.includes(r2.data.message.id), "「チャンネルにも送信」した返信だけチャンネルの流れに出る");
  const v1 = R.toViews(a, [R.getMessage(r1.data.message.id)], db())[0];
  ok(v1.alsoChannel && v1.root?.id === m1.id, "どのスレッドへの返信かが分かる");

  // 入力中・オンライン
  await as(b, () => A.chatTyping(pub));
  eq(R.typingIn(pub, a.id), [b.id], "入力中の人が分かる (自分は除く)");
  eq(R.typingIn(pub, b.id), [], "自分の入力中は出さない");
  ok(!(await as(admin, () => A.chatTyping(pub))).ok, "送れないチャンネルでは入力中を知らせない");
  R.touchPresence(a.id);
  ok(R.onlineUsers().includes(a.id), "画面を開いている人はオンライン");

  // 検索の絞り込み (送った人)
  const found = R.searchMessages([pub], "", 50, b.id);
  ok(found.length > 0 && found.every((m) => m.userId === b.id), "検索を送った人で絞れる");
}

section("8. 業務依頼 (チャットから)・スレッド・編集・削除");
{
  const r = await send(mgr, { channelId: chS, body: "合志の在庫を数えてください", task: { title: "在庫の確認", assigneeIds: [a.id], due: "tomorrow" } });
  ok(r.ok && r.data.message.task && r.data.message.task.status === "requested", "「業務依頼として送る」で業務依頼を作り、メッセージに状態を出す");
  const th = db().threads.find((t) => t.id === r.data.message.task.threadId);
  ok(th && th.kind === "request" && th.assigneeIds.includes(a.id) && Boolean(th.dueAt) && th.storeId === S, "業務依頼は従来の業務依頼 (依頼先・期限・店舗のチャンネルの店舗)");
  ok(state(a).inbox.some((i) => i.kind === "task" && i.href === `/messages/${th.id}`), "依頼先の要対応に「業務依頼」で出る");
  eq(R.taskLink(th.id)?.messageId, r.data.message.id, "業務依頼から元のメッセージに戻れる");
  // 確認しただけでは消えない
  const M = await imp("lib/actions/messages.ts");
  const runStep = async (user, step, body) => {
    globalThis.__testUser = user;
    try {
      const fd = new FormData();
      if (body) fd.set("body", body);
      await M.taskStep(th.id, step, fd);
    } catch (e) {
      if (!String(e?.digest ?? "").startsWith("NEXT_REDIRECT")) throw e;
    } finally {
      globalThis.__testUser = undefined;
    }
  };
  await runStep(a, "ack");
  ok(state(a).inbox.some((i) => i.kind === "task" && i.title.includes("対応中")), "「確認しました」では要対応から消えない (対応中)");
  await runStep(a, "report", "数えました");
  ok(!state(a).inbox.some((i) => i.kind === "task" && i.href === `/messages/${th.id}`) && state(a).waiting.some((w) => w.href === `/messages/${th.id}`), "報告すると依頼先は「完了待ち」(数字には入れない)");
  ok(state(mgr).inbox.some((i) => i.kind === "report" && i.href === `/messages/${th.id}`), "依頼した人の要対応に「報告の確認」で出る");
  await runStep(mgr, "confirm");
  ok(!state(mgr).inbox.some((i) => i.href === `/messages/${th.id}`), "依頼した人が完了にすると消える");
  const again = await as(mgr, () => A.makeChatTask(r.data.message.id, { title: "", assigneeIds: [a.id], due: "none" }));
  ok(!again.ok, "同じメッセージを 2 回業務依頼にはできない");
  const noAssignee = await send(mgr, { channelId: chS, body: "依頼先なし", task: { title: "", assigneeIds: [], due: "none" } });
  ok(!noAssignee.ok, "依頼先がないと送らない");

  // スレッド
  const root = await send(a, { channelId: chS, body: "スレッドの最初" });
  const rep = await send(b, { channelId: chS, parentId: root.data.message.id, body: "@試験花子 返信です" });
  ok(rep.ok && R.getMessage(root.data.message.id).replyCount === 1, "スレッドに返信すると返信の数が増える");
  const ia = state(a).inbox.find((i) => i.messageId === rep.data.message.id);
  ok(ia && ia.parentId === root.data.message.id, "スレッドのメンションは要対応に出る (開くとスレッドを開く)");
  await as(a, () => A.markChatRead(chS, new Date().toISOString()));
  ok(state(a).inbox.some((i) => i.messageId === rep.data.message.id), "チャンネルを読んでもスレッドのメンションは残る");
  await as(a, () => A.markChatRead(`t:${root.data.message.id}`, new Date().toISOString()));
  ok(!state(a).inbox.some((i) => i.messageId === rep.data.message.id), "スレッドを読むと消える");
  const nested = await send(a, { channelId: chS, parentId: rep.data.message.id, body: "返信の返信" });
  ok(!nested.ok, "返信にさらに返信のスレッドは作らない");

  // 編集・削除
  const e1 = await as(b, () => A.editChatMessage(root.data.message.id, "書き換え"));
  ok(!e1.ok, "ほかの人のメッセージは編集できない");
  const e2 = await as(a, () => A.editChatMessage(root.data.message.id, "スレッドの最初 (直しました) @試験店長"));
  ok(e2.ok && e2.data.message.editedAt && e2.data.message.mentions.includes(mgr.id), "自分のメッセージを編集できる (メンションも読み直す)");
  const d1 = await as(b, () => A.deleteChatMessage(root.data.message.id));
  ok(!d1.ok, "ほかの人のメッセージは消せない");
  const d2 = await as(admin, () => A.deleteChatMessage(root.data.message.id));
  ok(d2.ok && R.getMessage(root.data.message.id).deletedAt, "管理者はチャンネルの投稿を消せる");
  const dv = R.toViews(b, [R.getMessage(root.data.message.id)], db())[0];
  ok(dv.deleted && dv.body === "" && dv.replyCount === 1, "削除したメッセージは中身を消す (返信のあるときは「削除されました」を残す)");
  const re = await send(b, { channelId: chS, parentId: root.data.message.id, body: "x" });
  ok(!re.ok, "削除したメッセージには返信できない");
  const rx = await as(a, () => A.reactChatMessage(rep.data.message.id, "👍"));
  const ry = await as(a, () => A.reactChatMessage(rep.data.message.id, "🍣"));
  ok(rx.ok && rx.data.on && !ry.ok, "リアクション (決まった絵文字だけ)");
  const rz = await as(a, () => A.reactChatMessage(rep.data.message.id, "👍"));
  ok(rz.ok && !rz.data.on, "もう一度押すと外す");
}

/* ================================================================== */
section("9. 従来の社内連絡のメンションも要対応にまとめる");
{
  const tid = "th_chat_test";
  await store.mutate((x) => {
    x.threads.push({ id: tid, title: "棚の整理", kind: "notice", storeId: S, createdBy: mgr.id, participants: [mgr.id, b.id], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    x.messages.push({ id: "msg_chat_test", threadId: tid, userId: mgr.id, body: "@次郎 よろしく", at: new Date().toISOString(), mentions: [b.id] });
  });
  ok(state(b).inbox.some((i) => i.kind === "thread_mention" && i.href === `/messages/${tid}`), "社内連絡のメンションが要対応に出る");
  await as(b, () => A.markChatRead(`thread:${tid}`, new Date(Date.now() + 1000).toISOString()));
  ok(!state(b).inbox.some((i) => i.href === `/messages/${tid}`), "スレッドを開くと (既読) 消える");
  const bad = await as(x2, () => A.markChatRead(`thread:${tid}`, now));
  ok(!bad.ok, "見られない社内連絡は既読にできない");
}

/* ================================================================== */
section("9b. 書式 (Slack と同じ書き方)");
{
  eq(T.inlines("*太字* と _斜体_ と ~取り消し~ と `code` file_name_x"), [{ text: "太字", bold: true }, { text: " と " }, { text: "斜体", italic: true }, { text: " と " }, { text: "取り消し", strike: true }, { text: " と " }, { text: "code", code: true }, { text: " file_name_x" }], "太字・斜体・取り消し線・コード (単語の中の _ は斜体にしない)");
  eq(T.blocks("前\n> 引用\n・箇条\n1. 番号\n```\nx = 1\n```\n後").map((b) => b.kind), ["para", "quote", "list", "list", "code", "para"], "引用・箇条書き・番号・コードのかたまり");
}

section("10. データの置き場所");
{
  ok(fs.existsSync(path.join(work, "chat.sqlite")), "チャットは指定の SQLite (CHAT_DB_PATH) に保存する");
  ok(fs.existsSync(path.join(work, "push.sqlite")), "端末の登録は送り主の鍵と同じフォルダーの push.sqlite (試験期間と本番で同じもの)");
  const vf = JSON.parse(fs.readFileSync(path.join(work, "push-vapid.json"), "utf8"));
  ok(PC.validVapid(vf) && (fs.statSync(path.join(work, "push-vapid.json")).mode & 0o777) === 0o600, "VAPID の鍵は初めて使うときに作り、本人だけが読める (600)");
  const json = fs.readFileSync(path.join(work, "data", "chat-test-db.json"), "utf8");
  ok(!json.includes("明日の件、よろしくお願いします"), "DM の本文は業務のデータ (JSON・Supabase) に入らない");
}

DB.closeChatDb();
PU.closePushDb();
server.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
