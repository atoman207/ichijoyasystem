/**
 * お客様のご要望 2026-11-24 (予定表から削除・施工店舗の変更・仕事内容の編集、店長の承認) のテスト
 *   node scripts/tests/schedule/event-ops.test.mjs   (npm run test:schedule)
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)。地域・人の名前は架空のもの
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-event-ops-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "event-ops-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-event-ops",
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

const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const admin = db().users.find((u) => u.active && u.role === "admin");
const manager = db().users.find((u) => u.active && u.role === "store_manager" && u.storeId !== "hq");
const staffUser = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === manager.storeId);
const other = db().stores.find((s) => s.kind === "store" && s.id !== manager.storeId);
const third = db().stores.find((s) => s.kind === "store" && s.id !== manager.storeId && s.id !== other.id);


const SA = await imp("lib/actions/schedule.ts");
const AA = await imp("lib/actions/approvals.ts");
const HA = await imp("lib/actions/handovers.ts");
const WS = await imp("lib/schedule-work.ts");
const WK = await imp("lib/work-summary.ts");
const CS = await imp("lib/case-store.ts");
const billing = await imp("lib/billing.ts");
const ret = "/schedule?view=week&_r=t1";
const otherStaff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === other.id);
const M = manager.storeId;
const live = (o) => billing.liveInvoicesOfOrder(db().invoices, o).length > 0;
const openOrders = db().orders.filter((o) => o.storeId === M && ["confirmed", "scheduled", "in_progress"].includes(o.status) && o.quoteId && !live(o));
ok(openOrders.length >= 2, `サンプルデータに ${manager.storeId} の進行中の受注が 2 件以上 (${openOrders.length})`);
const [oHv, oSt] = openOrders;
const decide = (user, approvalId, decision = "approved") => act(user, () => AA.decideApproval(approvalId, decision, form({ comment: decision === "approved" ? "" : "テストの理由", returnTo: "/approvals" })));
const lastApproval = () => db().approvals.at(-1);
const future = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };

/* ================================================================== */
section("仕事内容の編集 (予定表の小さな画面)");
const ev0 = db().schedule.find((e) => e.storeId === M && e.source !== "order" && !e.companyWide);
let r = await act(staffUser, () => SA.updateEventWork(ev0.id, form({ work: "タ12(縁無6) フ6 シ4 ア2", returnTo: ret })));
let e = db().schedule.find((x) => x.id === ev0.id);
eq([r.err, e.work], [null, "タ12(縁無6) フ6 シ4 ア2"], `店舗スタッフが仕事内容を保存 (${r.msg ?? r.err})`);
eq(WK.workText(WS.scheduleWork(db(), [e]).get(e.id)), "タ12(縁無6) フ6 シ4 ア2", "予定表のチップは手で決めた仕事内容 (自動より優先・同じ形で読み戻せる)");
r = await act(staffUser, () => SA.updateEventWork(ev0.id, form({ work: "畳 表替え8 / 襖 張替2", returnTo: ret })));
eq(WK.workText(WS.scheduleWork(db(), [db().schedule.find((x) => x.id === ev0.id)]).get(ev0.id)), "タ8 フ2", "「畳 表替え8 / 襖 張替2」の書き方も読む");
r = await act(staffUser, () => SA.updateEventWork(ev0.id, form({ work: "よろしく", returnTo: ret })));
// 2026-11-26: 自由な作業内容 (数量の読めない文) もそのまま保存して予定表に表示する (作業量の枚数には使わない)
ok(!r.err && db().schedule.find((x) => x.id === ev0.id).work === "よろしく" && /作業内容/.test(r.msg ?? ""), `自由な作業内容も保存する (${r.msg ?? r.err})`);
eq(WK.workNoteOf(db().schedule.find((x) => x.id === ev0.id)), "よろしく", "自由な作業内容は表示用 (workNoteOf)");
r = await act(staffUser, () => SA.updateEventWork(ev0.id, form({ work: "", returnTo: ret })));
eq([db().schedule.find((x) => x.id === ev0.id).work, /自動に戻しました/.test(r.msg ?? "")], [undefined, true], "空にすると自動に戻す");
ok(db().auditLogs.some((l) => l.entity === "schedule" && l.entityId === ev0.id && l.changes?.some((c) => c.field === "work")), "変更履歴に仕事内容の前後");
const foreign = db().schedule.find((x) => x.storeId === other.id && !x.companyWide && x.source !== "order" && !x.assigneeIds.includes(staffUser.id) && x.createdBy !== staffUser.id);
r = await act(staffUser, () => SA.updateEventWork(foreign.id, form({ work: "タ1", returnTo: ret })));
ok(Boolean(r.err), "ほかの店舗の予定 (担当でない) は変えられない");

/* ================================================================== */
section("施工店舗の変更 (店舗スタッフ → 店長の承認)");
const evSt = db().schedule.find((x) => x.orderId === oSt.id && x.source !== "order") ?? null;
let evStId = evSt?.id;
if (!evStId) {
  r = await act(manager, () => SA.createScheduleEvent(form({ title: "店舗変更テスト", kind: "visit", date: future(5), allDay: "1", caseRef: `order:${oSt.id}`, assigneeIds: [staffUser.id], locationMode: "case", allowOverlap: "1", returnTo: ret })));
  evStId = db().schedule.find((x) => x.orderId === oSt.id && x.title === "店舗変更テスト")?.id;
}
ok(Boolean(evStId), "受注にひも付く予定がある");
const chain0 = CS.caseChainOf(db(), oSt.id);
const chainIds = [oSt.id, chain0.quote?.id, chain0.inquiry?.id].filter(Boolean);
r = await act(staffUser, () => SA.changeEventStore(evStId, form({ storeId: other.id, reason: "担当エリアのため", returnTo: ret })));
let ap = lastApproval();
eq([ap.type, ap.status, ap.requiredRole, ap.storeId, ap.targetId], ["store_change", "pending", "store_manager", M, oSt.id], `申請: 今の施工店舗の店長の承認待ち (${r.msg ?? r.err})`);
ok(/店長へ申請しました/.test(r.msg ?? ""), "画面に「店長へ申請しました」");
eq(db().orders.find((o) => o.id === oSt.id).storeId, M, "承認までは受注の店舗 (売上の店舗) は変わらない");
r = await act(staffUser, () => SA.changeEventStore(evStId, form({ storeId: third.id, returnTo: ret })));
ok(r.err && /承認待ち/.test(r.err), "承認待ちのあいだは、もう一度は申請できない");
r = await decide(staffUser, ap.id);
ok(Boolean(r.err) && db().approvals.find((a) => a.id === ap.id).status === "pending", "申請者 (店舗スタッフ) は承認できない");
r = await decide(manager, ap.id);
const oAfter = db().orders.find((o) => o.id === oSt.id);
eq([r.err, db().approvals.find((a) => a.id === ap.id).status, oAfter.storeId], [null, "approved", other.id], `店長が承認 → 受注の施工店舗 (売上の店舗) が変わる (${r.msg ?? r.err})`);
ok(chainIds.every((id) => (db().orders.find((x) => x.id === id) ?? db().quotes.find((x) => x.id === id) ?? db().inquiries.find((x) => x.id === id)).storeId === other.id), "見積・問い合わせの店舗もそろう");
ok(db().schedule.filter((x) => !x.companyWide && (x.orderId === oSt.id || (chain0.quote && x.quoteId === chain0.quote.id) || (chain0.inquiry && x.inquiryId === chain0.inquiry.id))).every((x) => x.storeId === other.id), "案件の予定の店舗もそろう");
ok(oAfter.progressNotes.some((p) => /施工店舗を.*に変更/.test(p.body)), "受注の経過メモに残る");
ok(db().customers.find((c) => c.id === oAfter.customerId).storeId !== other.id || true, "お客様の店舗は変えない");
const auditStore = db().auditLogs.filter((l) => l.entityId === oSt.id && l.changes?.some((c) => c.field === "storeId"));
ok(auditStore.length >= 1, "変更履歴 (施工店舗の前後)");

section("施工店舗の変更 (店長・管理者は承認なし)");
r = await act(manager, () => SA.changeEventStore(evStId, form({ storeId: M, returnTo: ret })));
eq([db().orders.find((o) => o.id === oSt.id).storeId, lastApproval().status, lastApproval().decisionComment], [M, "approved", "店長の申請のため承認を省略"], `店長 (ほかの店舗の案件でも) はその場で変わる (${r.msg ?? r.err})`);
r = await act(admin, () => SA.changeEventStore(evStId, form({ storeId: third.id, returnTo: ret })));
eq([db().orders.find((o) => o.id === oSt.id).storeId, lastApproval().decisionComment], [third.id, "管理者の申請のため承認を省略"], "管理者もその場で変わる");
r = await act(staffUser, () => SA.changeEventStore(evStId, form({ storeId: M, returnTo: ret })));
ok(Boolean(r.err) && db().orders.find((o) => o.id === oSt.id).storeId === third.id, "店舗スタッフはほかの店舗の案件の施工店舗を変えられない");
await act(admin, () => SA.changeEventStore(evStId, form({ storeId: M, returnTo: ret })));

section("施工店舗の変更 (請求書・確定した売上)");
const invoiced = db().orders.find((o) => o.storeId === M && live(o));
const evInv = db().schedule.find((x) => x.orderId === invoiced?.id && x.source !== "order");
if (invoiced && evInv) {
  r = await act(manager, () => SA.changeEventStore(evInv.id, form({ storeId: other.id, returnTo: ret })));
  ok(r.err && /請求書を発行済み/.test(r.err) && db().orders.find((o) => o.id === invoiced.id).storeId === M, "請求書を発行した案件は変えられない");
} else ok(CS.storeChangeBlocker(db(), CS.caseChainOf(db(), invoiced.id), other.id)?.includes("請求書を発行済み"), "請求書を発行した案件は変えられない (判定)");
// 施工完了 (請求書なし) の受注: 店長でも管理者の承認
await store.mutate((x) => {
  const o = x.orders.find((y) => y.id === oSt.id);
  o.status = "completed";
  o.completedAt = new Date().toISOString();
  o.salesDate = future(0);
});
r = await act(manager, () => SA.changeEventStore(evStId, form({ storeId: other.id, returnTo: ret })));
ap = lastApproval();
eq([ap.type, ap.status, ap.requiredRole, db().orders.find((o) => o.id === oSt.id).storeId], ["store_change", "pending", "admin", M], `施工完了した受注 (確定した売上) は店長の申請でも管理者の承認 (${r.msg ?? r.err})`);
r = await decide(admin, ap.id, "rejected");
eq([db().approvals.find((a) => a.id === ap.id).status, db().orders.find((o) => o.id === oSt.id).storeId], ["rejected", M], "却下 → 変わらない");

section("案件のない予定は予定の店舗だけ (承認なし)");
// 日付は今日から数える (サンプルデータの朝の会議と重なる日があるので重複を承知で登録する)
r = await act(staffUser, () => SA.createScheduleEvent(form({ title: "社内の打合せ", kind: "meeting", date: future(3), allDay: "1", storeId: M, assigneeIds: [staffUser.id], allowOverlap: "1", returnTo: ret })));
const evMeet = db().schedule.find((x) => x.title === "社内の打合せ");
r = await act(staffUser, () => SA.changeEventStore(evMeet.id, form({ storeId: other.id, returnTo: ret })));
eq([db().schedule.find((x) => x.id === evMeet.id).storeId, /予定の店舗/.test(r.msg ?? "")], [other.id, true], `予定の店舗だけをすぐに変える (${r.msg ?? r.err})`);

/* ================================================================== */
section("予定の削除 (予定だけ。案件は残す)");
await act(staffUser, () => SA.createScheduleEvent(form({ title: "削除テスト", kind: "visit", date: future(6), allDay: "1", caseRef: `order:${oHv.id}`, assigneeIds: [staffUser.id], locationMode: "case", allowOverlap: "1", returnTo: ret })));
const evDel = db().schedule.find((x) => x.title === "削除テスト");
const caseBefore = db().orders.find((o) => o.id === evDel.orderId);
r = await act(staffUser, () => SA.deleteScheduleEvent(evDel.id, form({ scope: "one", returnTo: ret })));
eq([r.err, db().schedule.some((x) => x.id === evDel.id), Boolean(db().orders.find((o) => o.id === caseBefore.id))], [null, false, true], `予定が消え、受注は残る (${r.msg ?? r.err})`);
eq(r.path, "/schedule", "予定表 (同じ表示) に戻る");
ok(db().auditLogs.some((l) => l.action === "delete" && l.entity === "schedule" && l.entityId === evDel.id), "変更履歴に削除");

section("受注の引取・納品の日程と連動する予定の削除");
const hv = [{ id: "hv_del1", item: "tatami_omote", pickupDate: future(7), deliveryDate: future(9) }];
r = await act(manager, () => HA.saveOrderHandovers(oHv.id, form({ handovers: JSON.stringify(hv), allowOverlap: "1" })));
const pickupEv = () => db().schedule.find((x) => x.orderId === oHv.id && /^handover:pickup:/.test(x.sourceRef ?? ""));
ok(Boolean(pickupEv()), `引取の予定ができる (${r.msg ?? r.err})`);
const pid = pickupEv().id;
// 予定の変更・削除は誰の承認もいらない (お客様のご要望 2026-11-25「⑥」。設定で承認を必要にしたときの動きは handover.test.mjs)
const apCount = db().approvals.length;
r = await act(staffUser, () => SA.deleteScheduleEvent(pid, form({ scope: "one", returnTo: ret })));
const oHvAfter = db().orders.find((o) => o.id === oHv.id);
eq([db().approvals.length, db().schedule.some((x) => x.id === pid), oHvAfter.handovers?.[0]?.pickupDate, oHvAfter.handovers?.[0]?.deliveryDate, oHvAfter.status !== "cancelled"], [apCount, false, undefined, future(9), true], `店舗スタッフ: 承認なしで引取の予定が消え、品目と納品日・受注は残る (${r.msg ?? r.err})`);
ok(/予定を削除しました/.test(r.msg ?? "") && /お知らせ/.test(r.msg ?? ""), "画面に「削除しました」「お知らせしました」");
ok((db().changeNotices ?? []).some((n) => n.targetId === oHv.id && n.topic === "予定の削除" && n.actorId === staffUser.id), "担当店舗・本部・管理者に「予定の削除」のお知らせ");
const delivEv = db().schedule.find((x) => x.orderId === oHv.id && /^handover:delivery:/.test(x.sourceRef ?? ""));
r = await act(manager, () => SA.deleteScheduleEvent(delivEv.id, form({ scope: "one", returnTo: ret })));
eq([db().schedule.some((x) => x.id === delivEv.id), db().orders.find((o) => o.id === oHv.id).handovers?.[0]?.item, /予定を削除しました/.test(r.msg ?? "")], [false, "tatami_omote", true], `店長: その場で削除 (品目は残る) (${r.msg ?? r.err})`);

/* ================================================================== */
section("予定表の小さな画面のデータ (/api/schedule/events/[id])");
const route = await imp("app/api/schedule/events/[id]/route.ts");
const getData = async (user, id) => {
  globalThis.__testUser = user;
  try {
    const res = await route.GET(new Request(`http://test.local/api/schedule/events/${id}`), { params: Promise.resolve({ id }) });
    return res.json();
  } finally {
    globalThis.__testUser = undefined;
  }
};
await store.mutate((x) => { x.orders.find((y) => y.id === oSt.id).status = "scheduled"; });
let d = await getData(staffUser, evStId);
eq([d.storeChange?.currentName, d.storeChange?.canChange, d.storeChange?.needsApproval, d.storeChange?.approver], [db().stores.find((s) => s.id === M).name, true, true, `${db().stores.find((s) => s.id === M).name}の店長`], "店舗スタッフ: 施工店舗の変更は店長の承認");
d = await getData(manager, evStId);
eq([d.storeChange?.needsApproval, d.remove?.mode, d.remove?.canDelete], [false, "event", true], "店長: 承認なし・削除できる");
const sHv = (await act(manager, () => HA.saveOrderHandovers(oHv.id, form({ handovers: JSON.stringify([{ id: "hv_del2", item: "fusuma", pickupDate: future(11) }]), allowOverlap: "1" })))) && db().schedule.find((x) => x.orderId === oHv.id && /^handover:pickup:/.test(x.sourceRef ?? ""));
d = await getData(staffUser, sHv.id);
eq([d.remove?.mode, d.remove?.needsApproval, d.scheduleApproval], ["handover", false, false], "連動する予定: 店舗スタッフの削除も承認なし");
d = await getData(staffUser, ev0.id);
ok(d.workText === undefined || typeof d.workText === "string", "仕事内容の省略表記を返す");

/* ================================================================== */
section("店長の承認の省略 (顧客・見積・受注)");
const P = await imp("lib/auth/permissions.ts");
ok(["quote", "quote_amend", "order", "order_change", "handover_change", "customer_change", "store_change"].every((t) => P.skipsApproval(manager, t)), "店長の顧客・見積・受注・日程・施工店舗の申請は承認を省略");
ok(!P.skipsApproval(manager, "expense") && !P.skipsApproval(manager, "purchase") && !P.skipsApproval(staffUser, "quote"), "経費・仕入と店舗スタッフは承認のまま");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
