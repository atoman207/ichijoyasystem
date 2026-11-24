/**
 * お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー」①〜⑦ のテスト
 *   node scripts/tests/schedule/inquiry-flow.test.mjs   (npm run test:schedule)
 * 1. 対応期限 (本日12時まで・本日中・明日中・日時を指定) と表示 (src/lib/inquiry-flow.ts)
 * 2. 対応状況 (依頼待ち・日程調整中・期限超過・日程未定・日程確定・訪問済み・見積・受注・完了)
 * 3. 期限を過ぎた依頼の再通知の対象 (時間帯・間隔・回数・日程が決まったら送らない・日程未定の連絡予定日)
 * 4. 依頼 (店舗・担当者・期限)・日程の登録で依頼を完了・日程未定・再通知の実行 (actions/inquiries.ts・actions/schedule.ts・src/lib/inquiry-followup.ts)
 * 5. 案件の流れと次にやること (src/lib/case-flow.ts)
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-inquiry-flow-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "inquiry-flow-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-inquiry-flow",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_)/.test(k)) delete process.env[k];
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
async function act(user, fn) {
  globalThis.__testUser = user;
  try {
    await fn();
    return { msg: null, err: null };
  } catch (e) {
    if (e && typeof e.digest === "string" && e.digest.startsWith("NEXT_REDIRECT")) {
      const u = new URL(e.url, "http://test.local");
      return { path: u.pathname, msg: u.searchParams.get("msg"), err: u.searchParams.get("err") };
    }
    throw e;
  } finally {
    globalThis.__testUser = undefined;
  }
}
const form = (obj) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, String(x));
    else if (v !== undefined && v !== null) fd.set(k, String(v));
  }
  return fd;
};
const jst = (s) => new Date(`${s}+09:00`);

/* ================================================================== */
section("1. 対応期限");
const F = await imp("lib/inquiry-flow.ts");
const morning = jst("2026-11-24T09:30:00");
const afternoon = jst("2026-11-24T13:00:00");
eq(F.dueAtFrom("noon", undefined, morning).dueAt, jst("2026-11-24T12:00:00").toISOString(), "本日12時まで = 今日の 12:00");
ok(Boolean(F.dueAtFrom("noon", undefined, afternoon).error), "12 時を過ぎたら「本日12時まで」は選べない");
eq(F.dueAtFrom("today", undefined, afternoon).dueAt, jst("2026-11-24T23:59:00").toISOString(), "本日中 = 今日の 23:59");
eq(F.dueAtFrom("tomorrow", undefined, afternoon).dueAt, jst("2026-11-25T23:59:00").toISOString(), "明日中 = 明日の 23:59");
eq(F.dueAtFrom("custom", "2026-11-26T15:00", afternoon).dueAt, jst("2026-11-26T15:00:00").toISOString(), "日時を指定 (日本時間)");
ok(Boolean(F.dueAtFrom("custom", "2026-11-24T10:00", afternoon).error) && Boolean(F.dueAtFrom("custom", "", afternoon).error), "過去の日時・空の指定は断る");
eq(F.dueAtFrom("none", undefined, afternoon), {}, "期限なし");
eq([F.dueLabel(jst("2026-11-24T12:00:00").toISOString(), morning), F.dueLabel(jst("2026-11-24T23:59:00").toISOString(), morning), F.dueLabel(jst("2026-11-25T23:59:00").toISOString(), morning), F.dueLabel(jst("2026-11-27T15:00:00").toISOString(), morning)], ["本日 12:00まで", "本日中", "明日中", "11/27 15:00まで"], "期限の表示");

/* ================================================================== */
section("2. 対応状況");
const now = jst("2026-11-24T10:00:00");
const base = (o) => ({ id: "i1", number: "INQ-1", contactName: "山田", channel: "phone", storeId: "koshi", category: "tatami", summary: "表替え", detail: "", status: "new", receivedAt: "2026-11-24T00:00:00.000Z", createdBy: "u1", updatedAt: "2026-11-24T00:00:00.000Z", ...o });
const mk = (o = {}) => ({ threads: [], schedule: [], users: [{ id: "u1", name: "事務 一郎", active: true, storeId: "hq", role: "hq_staff" }, { id: "u2", name: "合志 太郎", active: true, storeId: "koshi", role: "store_manager" }], stores: [{ id: "koshi", name: "合志店", managerUserId: "u2" }], quotes: [], orders: [], ...o });
const req = (o) => ({ id: "t1", title: "依頼", kind: "request", createdBy: "u1", participants: [], relatedType: "inquiry", relatedId: "i1", status: "open", createdAt: "2026-11-24T00:10:00.000Z", updatedAt: "2026-11-24T00:10:00.000Z", assigneeIds: ["u2"], taskStatus: "requested", purpose: "schedule", ...o });
const st = (db, inq = base()) => F.inquiryFlow(inq, F.flowIndex(db), now);
eq(st(mk()).state, "request_waiting", "依頼も日程もない → 担当者への依頼待ち");
eq(st(mk(), base({ nextActionDue: "2026-11-23" })).state, "overdue", "次のアクションの期限 (昨日) を過ぎた依頼待ち → 期限超過");
eq(st(mk({ threads: [req({ dueAt: jst("2026-11-24T12:00:00").toISOString() })] })).state, "adjusting", "依頼中 (期限前) → 日程調整中");
const late = st(mk({ threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString() })] }));
eq([late.state, late.who], ["overdue", ["合志 太郎"]], "期限を過ぎて返答なし → 期限超過 (依頼先)");
eq(st(mk({ threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString(), taskStatus: "reported" })] })).state, "adjusting", "期限を過ぎても報告 (返答) があれば期限超過にしない");
eq(st(mk(), base({ scheduleHold: { at: "", by: "u1", reason: "お客様都合により日程未定", nextContact: "2026-11-30" } })).state, "on_hold", "お客様都合で日程未定 (通常の未対応と分ける)");
eq(st(mk(), base({ scheduleHold: { at: "", by: "u1", reason: "x", nextContact: "2026-11-20" } })).state, "overdue", "日程未定の次回の連絡予定日を過ぎた → 期限超過");
const ev = (o) => ({ id: "e1", title: "山田 様 見積", kind: "survey", date: "2026-11-26", storeId: "koshi", assigneeIds: ["u2"], inquiryId: "i1", ...o });
const sched = st(mk({ schedule: [ev()], threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString() })] }));
eq([sched.state, sched.nextEvent?.id], ["scheduled", "e1"], "日程が決まった (これからの予定) → 日程確定 (依頼の期限は関係ない)");
eq(st(mk({ schedule: [ev({ date: "2026-11-20" })] })).state, "visited", "予定の日が過ぎた (見積の前) → 訪問済み");
eq(st(mk({ schedule: [ev({ kind: "meeting" })] })).state, "request_waiting", "社内の予定 (会議) は日程に数えない");
eq(st(mk({ quotes: [{ id: "q1", status: "sent" }] }), base({ quoteId: "q1" })).state, "quoted", "見積を作った → 見積提出済");
eq(st(mk({ quotes: [{ id: "q1", status: "accepted" }], orders: [{ id: "o1", quoteId: "q1", status: "scheduled" }] }), base({ quoteId: "q1" })).state, "ordered", "受注した → 受注");
eq(st(mk(), base({ status: "lost" })).state, "closed", "失注 → 完了・失注");

/* ================================================================== */
section("3. 再通知の対象");
const dueDb = (o) => ({ ...mk(o), inquiries: [base()] });
const r1 = F.dueFollowups(dueDb({ threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString() })] }), now);
eq(r1.map((x) => [x.kind, x.round]), [["request", 1]], "期限を過ぎた依頼 → 1 回目");
eq(F.dueFollowups(dueDb({ threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString() })] }), jst("2026-11-24T21:30:00")).length, 0, "夜 (20 時以降) は送らない (翌朝に送る)");
eq(F.dueFollowups(dueDb({ threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString(), remindCount: 1, remindedAt: jst("2026-11-24T09:05:00").toISOString() })] }), now).length, 0, "前の再通知から 3 時間たつまで送らない");
eq(F.dueFollowups(dueDb({ threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString(), remindCount: 1, remindedAt: jst("2026-11-24T06:00:00").toISOString() })] }), now).map((x) => x.round), [2], "3 時間後に 2 回目");
eq(F.dueFollowups(dueDb({ threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString(), remindCount: 2, remindedAt: jst("2026-11-24T05:00:00").toISOString() })] }), now).length, 0, "2 回まで (そのあとは一覧の期限超過で見る)");
eq(F.dueFollowups(dueDb({ threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString() })], schedule: [ev()] }), now).length, 0, "日程が登録されたら送らない");
eq(F.dueFollowups(dueDb({ threads: [req({ dueAt: jst("2026-11-24T09:00:00").toISOString(), taskStatus: "reported" })] }), now).length, 0, "報告 (返答) があれば送らない");
eq(F.dueFollowups({ ...mk(), inquiries: [base({ assignedUserId: "u2", scheduleHold: { at: "", by: "u1", reason: "x", nextContact: "2026-11-24" } })] }, now).map((x) => x.kind), ["hold"], "日程未定の次回の連絡予定日の朝 → 担当者へ");
eq(F.dueFollowups({ ...mk(), inquiries: [base({ assignedUserId: "u2", scheduleHold: { at: "", by: "u1", reason: "x", nextContact: "2026-11-24", remindedOn: "2026-11-24" } })] }, now).length, 0, "連絡予定日の知らせは 1 回");

/* ================================================================== */
section("4. 依頼・日程の登録・日程未定・再通知の実行");
const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const fmt = await imp("lib/format.ts");
const today = fmt.toDateKey(new Date());
const d = (n) => fmt.addDays(today, n);
const admin = db().users.find((u) => u.active && u.role === "admin");
const hq = db().users.find((u) => u.active && u.role === "hq_staff") ?? admin;
const koshiStaff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");
const chuoStaff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === "chuo");
const nowIso = new Date().toISOString();
await store.mutate((x) => {
  x.inquiries.push(
    { id: "inq_f1", number: "INQ-F-1", contactName: "テスト依頼", contactPhone: "090-0000-1111", channel: "phone", storeId: "hq", category: "tatami", summary: "畳の表替え 6畳", detail: "", status: "new", receivedAt: nowIso, createdBy: hq.id, updatedAt: nowIso },
    { id: "inq_f2", number: "INQ-F-2", contactName: "テスト未定", channel: "phone", storeId: "koshi", category: "fusuma", summary: "襖の張替え", detail: "", status: "new", receivedAt: nowIso, createdBy: koshiStaff.id, assignedUserId: koshiStaff.id, updatedAt: nowIso },
  );
});
const IA = await imp("lib/actions/inquiries.ts");
let r = await act(hq, () => IA.requestInquiry("inq_f1", form({ storeId: "koshi", assigneeId: "", purpose: "schedule", note: "", due: "custom", dueCustom: `${d(1)}T12:00`, returnTo: "/inquiries/inq_f1" })));
const t1 = db().threads.filter((t) => t.relatedId === "inq_f1").at(-1);
const koshiMembers = F.storeMembers(db(), "koshi").map((u) => u.id);
eq([r.err, t1?.purpose, t1?.assigneeStoreId, t1?.dueAt, [...(t1?.assigneeIds ?? [])].sort()], [null, "schedule", "koshi", jst(`${d(1)}T12:00:00`).toISOString(), [...koshiMembers].sort()], "店舗への依頼: 合志店のメンバー全員が依頼先・期限・種類");
const m1 = db().messages.filter((m) => m.threadId === t1.id);
eq([m1.length, [...m1[0].mentions].sort()], [1, [...koshiMembers].sort()], "依頼の投稿で店舗のメンバー全員にメンション");
ok(/訪問日程の打ち合わせ/.test(m1[0].body), "依頼の内容が空なら定型文 (訪問日程の打ち合わせをお願いします)");
eq([db().inquiries.find((i) => i.id === "inq_f1").storeId, db().inquiries.find((i) => i.id === "inq_f1").status], ["koshi", "in_progress"], "ほかの店舗へ依頼したら担当店舗も移す・未対応 → 対応中");
ok(/合志店/.test(r.msg ?? "") && /自動で再通知/.test(r.msg ?? ""), "メッセージ: 依頼先と自動の再通知");
r = await act(koshiStaff, () => IA.requestInquiry("inq_f2", form({ storeId: "chuo", purpose: "contact", due: "today", returnTo: "/inquiries/inq_f2" })));
ok(/本部・店長/.test(r.err ?? ""), "店舗スタッフはほかの店舗へ依頼できない");
r = await act(koshiStaff, () => IA.requestInquiry("inq_f2", form({ storeId: "koshi", purpose: "schedule", due: "custom", dueCustom: `${d(-1)}T10:00` })));
ok(/過去/.test(r.err ?? ""), "期限に過去の日時は指定できない");
if (chuoStaff) {
  r = await act(chuoStaff, () => IA.requestInquiry("inq_f2", form({ storeId: "koshi", purpose: "schedule", due: "today" })));
  ok(Boolean(r.err), "ほかの店舗の問い合わせには依頼できない (店舗スタッフ)");
}
r = await act(hq, () => IA.requestInquiry("inq_f2", form({ storeId: "koshi", assigneeId: koshiStaff.id, purpose: "contact", note: "折返しお願いします", due: "tomorrow" })));
const t2 = db().threads.filter((t) => t.relatedId === "inq_f2").at(-1);
eq([r.err, t2.assigneeIds, t2.assigneeStoreId, t2.purpose], [null, [koshiStaff.id], undefined, "contact"], "担当者への依頼 (お客様へ連絡)");

// 日程の登録 → 日程の打ち合わせの依頼を完了
const SA = await imp("lib/actions/schedule.ts");
r = await act(koshiStaff, () => SA.createScheduleEvent(form({ caseRef: "inquiry:inq_f1", storeId: "koshi", kind: "site_survey", date: d(2), slot: "am", assigneeIds: [koshiStaff.id], locationMode: "follow", location: "", back: "/inquiries/inq_f1", returnTo: "/inquiries/inq_f1" })));
const t1b = db().threads.find((t) => t.id === t1.id);
eq([r.err, r.path, t1b.taskStatus, t1b.status], [null, "/inquiries/inq_f1", "confirmed", "done"], "問い合わせの画面で日程 (現調) を登録 → 予定表に載り、日程の打ち合わせの依頼は完了");
ok(db().messages.some((m) => m.threadId === t1.id && m.mentions.includes(hq.id) && /日程を登録/.test(m.body)), "依頼した人にメンションで知らせる");
ok(/依頼を完了/.test(r.msg ?? ""), "メッセージ: 依頼を完了にしました");
ok(db().schedule.some((e) => e.inquiryId === "inq_f1" && e.kind === "site_survey" && e.date === d(2)), "予定 (現調) が予定表に登録される");
eq(F.inquiryFlow(db().inquiries.find((i) => i.id === "inq_f1"), F.flowIndex(db()), new Date()).state, "scheduled", "対応状況 = 日程確定");

// 日程未定
await store.mutate((x) => {
  x.inquiries.push({ id: "inq_f3", number: "INQ-F-3", contactName: "テスト保留", channel: "phone", storeId: "koshi", category: "tatami", summary: "畳", detail: "", status: "new", receivedAt: nowIso, createdBy: koshiStaff.id, assignedUserId: koshiStaff.id, updatedAt: nowIso });
});
await act(hq, () => IA.requestInquiry("inq_f3", form({ storeId: "koshi", purpose: "schedule", due: "today" })));
r = await act(koshiStaff, () => IA.setInquiryScheduleHold("inq_f3", form({ reason: "", nextContact: d(5), returnTo: "/inquiries/inq_f3" })));
const inq3 = db().inquiries.find((i) => i.id === "inq_f3");
eq([r.err, inq3.scheduleHold?.reason, inq3.scheduleHold?.nextContact, inq3.nextActionDue], [null, "お客様都合により日程未定", d(5), d(5)], "お客様都合で日程未定・次回の連絡予定日");
ok(db().threads.filter((t) => t.relatedId === "inq_f3").every((t) => t.taskStatus === "confirmed"), "日程未定にしたら日程の打ち合わせの依頼は完了");
eq(F.inquiryFlow(inq3, F.flowIndex(db()), new Date()).state, "on_hold", "対応状況 = お客様都合で日程未定");
r = await act(koshiStaff, () => IA.setInquiryScheduleHold("inq_f3", form({ nextContact: d(-2) })));
ok(Boolean(r.err), "次回の連絡予定日に過去の日は入れられない");
await act(koshiStaff, () => SA.createScheduleEvent(form({ caseRef: "inquiry:inq_f3", storeId: "koshi", kind: "survey", date: d(6), slot: "pm", assigneeIds: [koshiStaff.id], locationMode: "follow", back: "/inquiries/inq_f3", returnTo: "/inquiries/inq_f3" })));
eq(db().inquiries.find((i) => i.id === "inq_f3").scheduleHold, undefined, "日程を登録したら日程未定を外す");

// 再通知の実行
await store.mutate((x) => {
  x.inquiries.push({ id: "inq_f4", number: "INQ-F-4", contactName: "テスト期限", channel: "phone", storeId: "koshi", category: "tatami", summary: "畳", detail: "", status: "in_progress", receivedAt: nowIso, createdBy: hq.id, updatedAt: nowIso });
  x.threads.push({ id: "th_late", title: "訪問日程の打ち合わせ", kind: "request", storeId: "koshi", createdBy: hq.id, participants: [hq.id, koshiStaff.id], relatedType: "inquiry", relatedId: "inq_f4", status: "open", createdAt: nowIso, updatedAt: nowIso, assigneeIds: [koshiStaff.id], purpose: "schedule", dueAt: jst("2026-11-24T09:00:00").toISOString(), taskStatus: "requested" });
});
const FU = await imp("lib/inquiry-followup.ts");
let res = await FU.runInquiryFollowups(jst("2026-11-24T10:00:00"));
const late1 = db().threads.find((t) => t.id === "th_late");
ok(res.threads.includes("th_late") && late1.remindCount === 1, "期限を過ぎた依頼に再通知 (1 回目)");
const rm = db().messages.filter((m) => m.threadId === "th_late").at(-1);
ok(rm.userId === "system" && rm.mentions.includes(koshiStaff.id) && /期限/.test(rm.body), "依頼先にメンション (システムの投稿)");
res = await FU.runInquiryFollowups(jst("2026-11-24T10:05:00"));
ok(!res.threads.includes("th_late"), "すぐには二重に送らない");
res = await FU.runInquiryFollowups(jst("2026-11-24T13:10:00"));
const rm2 = db().messages.filter((m) => m.threadId === "th_late").at(-1);
const koshiManager = db().stores.find((s) => s.id === "koshi")?.managerUserId;
ok(res.threads.includes("th_late") && db().threads.find((t) => t.id === "th_late").remindCount === 2 && rm2.mentions.includes(hq.id) && (!koshiManager || rm2.mentions.includes(koshiManager)), "3 時間後に 2 回目 (店長と依頼した人にも)");
res = await FU.runInquiryFollowups(jst("2026-11-24T17:00:00"));
ok(!res.threads.includes("th_late"), "3 回目は送らない");

/* ================================================================== */
section("5. 案件の流れと次にやること");
const CF = await imp("lib/case-flow.ts");
const f4 = CF.caseFlow(db(), { inquiryId: "inq_f4" }, jst("2026-11-24T10:00:00"));
eq([f4.badge?.label, f4.next?.button, f4.next?.tone], ["期限超過", "日程を登録", "critical"], "期限超過の案件: 次にやること = 日程を登録 (赤)");
eq(f4.steps.map((s) => s.key), ["inquiry", "request", "schedule", "quote", "order", "work", "billing", "payment"], "受付 → 依頼 → 日程 → 見積 → 受注 → 施工 → 売上・請求 → 入金");
const f1 = CF.caseFlow(db(), { inquiryId: "inq_f1" }, new Date());
eq([f1.steps.find((s) => s.key === "schedule").state, f1.badge?.label], ["done", "日程確定"], "日程を登録した案件: 日程は済み");
await store.mutate((x) => {
  x.inquiries.push({ id: "inq_f5", number: "INQ-F-5", contactName: "テスト新規", channel: "phone", storeId: "koshi", category: "tatami", summary: "畳", detail: "", status: "new", receivedAt: nowIso, createdBy: hq.id, updatedAt: nowIso });
});
const f5 = CF.caseFlow(db(), { inquiryId: "inq_f5" }, new Date());
eq([f5.next?.button, f5.steps.find((s) => s.key === "request").state], ["担当へ依頼", "current"], "新しい問い合わせ: 次にやること = 担当へ依頼");
const order = db().orders.find((o) => o.status === "completed" && o.quoteId && o.source !== "import") ?? db().orders.find((o) => o.status === "completed");
if (order) {
  const fo = CF.caseFlow(db(), { orderId: order.id }, new Date());
  eq([fo.steps.find((s) => s.key === "order").state, fo.steps.find((s) => s.key === "work").state], ["done", "done"], `完了した受注 (${order.number}): 受注・施工は済み`);
  ok(Boolean(fo.next?.text), `受注の次にやること: ${fo.next?.text}`);
}

/* ================================================================== */
section("6. 予定の種類");
const C = await imp("lib/constants.ts");
eq([C.SCHEDULE_KIND.survey.short, C.SCHEDULE_KIND.site_survey.short, C.SCHEDULE_KIND.onsite_quote.short], ["見積", "現調", "現見"], "見積・現調・現見を分ける (お客様の言い方)");
const MA = await imp("lib/actions/messages.ts");
r = await act(koshiStaff, () => MA.taskStep(t2.id, "ack", form({ returnTo: "/inquiries/inq_f2" })));
eq([r.path, db().threads.find((t) => t.id === t2.id).taskStatus], ["/inquiries/inq_f2", "acknowledged"], "問い合わせの画面の「確認しました」→ 問い合わせの画面に戻る");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
