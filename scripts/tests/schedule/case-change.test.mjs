/**
 * お客様のご要望 2026-11-25 (予定表を起点に案件の確認・変更・追加: ①〜⑩) のテスト
 *   node scripts/tests/schedule/case-change.test.mjs   (npm run test:schedule)
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)。地域・人の名前は架空のもの
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-case-change-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "case-change-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-case-change",
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
const QA = await imp("lib/actions/quotes.ts");
const OA = await imp("lib/actions/orders.ts");
const CQ = await imp("lib/actions/case-quick.ts");
const NA = await imp("lib/actions/notices.ts");
const IA = await imp("lib/actions/inquiries.ts");
const CN = await imp("lib/change-notices.ts");
const WSF = await imp("lib/work-staff.ts");
const OS = await imp("lib/order-staff.ts");
const AD = await imp("lib/approval-decide.ts");
const LBL = await imp("lib/schedule-label.ts");
const R = await imp("lib/reception.ts");
const AIR = await imp("lib/ai/reception.ts");
const hq = db().users.find((u) => u.active && u.role === "hq_staff");
const now = new Date().toISOString();

// 架空のお客様と案件 (地域・名前は架空)
await store.mutate((x) => {
  const mk = (id, code, name, storeId, type = "individual", address = "熊本県テスト市本町1-2-3") => x.customers.push({ id, code, name, kana: "", type, phone: "", postalCode: "", address, storeId, preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
  mk("c_cc_a", "C-90001", "変更 太郎", M);
  mk("c_cc_b", "C-90002", "正しい 花子", M, "individual", "熊本県テスト市北町5-6");
  mk("c_cc_corp", "C-90003", "テスト工務店", M, "corporate", "熊本県テスト市工業団地1");
  const items = [
    { id: "qi_a1", name: "畳表替え", spec: "きずな", qty: 6, unit: "枚", unitPrice: 12000, amount: 72000 },
    { id: "qi_a2", name: "襖張替え", qty: 4, unit: "枚", unitPrice: 5000, amount: 20000 },
  ];
  x.inquiries.push({ id: "inq_cc_a", number: "INQ-CC-1", customerId: "c_cc_a", contactName: "変更 太郎", channel: "phone", storeId: M, category: "tatami", summary: "表替えと襖", detail: "", status: "quoted", receivedAt: now, createdBy: staffUser.id, updatedAt: now, quoteId: "q_cc_a", media: "flyer" });
  x.quotes.push({ id: "q_cc_a", number: "Q-CC-1", version: 1, customerId: "c_cc_a", inquiryId: "inq_cc_a", storeId: M, title: "畳表替え・襖張替え", category: "tatami", items, subtotal: 92000, discount: 0, tax: 8363, total: 92000, taxIncluded: true, status: "accepted", validUntil: "2099-12-31", createdBy: staffUser.id, createdAt: now, updatedAt: now, orderId: "o_cc_a" });
  x.orders.push({ id: "o_cc_a", number: "O-CC-1", quoteId: "q_cc_a", customerId: "c_cc_a", storeId: M, title: "畳表替え・襖張替え", category: "tatami", contractDate: now.slice(0, 10), total: 92000, status: "confirmed", workerIds: [staffUser.id], siteAddress: "熊本県テスト市本町1-2-3", progressNotes: [], createdBy: staffUser.id, createdAt: now, updatedAt: now });
});

/* ================================================================== */
section("② 引取の日時を変えるときに、関連する納品予定もあわせて変える");
let r = await act(manager, () => HA.saveOrderHandovers("o_cc_a", form({ handovers: JSON.stringify([{ id: "hv_cc1", item: "tatami_omote", pickupDate: future(20), pickupStart: "09:00", deliveryDate: future(22) }]), workerIds: [staffUser.id], allowOverlap: "1" })));
const hvEv = (role) => db().schedule.find((x) => x.orderId === "o_cc_a" && (x.sourceRef ?? "").startsWith(`handover:${role}:`));
ok(hvEv("pickup") && hvEv("delivery"), `引取と納品の予定ができる (${r.msg ?? r.err})`);
const apBefore = db().approvals.length;
r = await act(staffUser, () => SA.quickUpdateScheduleEvent(hvEv("pickup").id, form({ returnTo: ret, date: future(21), timeMode: "time", startTime: "10:00", pairId: hvEv("delivery").id, pairDate: future(24), pairTimeMode: "pm", pairAssigneesSent: "1", pairAssigneeIds: [staffUser.id, manager.id], allowOverlap: "1" })));
let o = db().orders.find((x) => x.id === "o_cc_a");
const row = o.handovers[0];
eq([r.err, row.pickupDate, row.pickupStart, row.deliveryDate, row.deliverySlot], [null, future(21), "10:00", future(24), "pm"], `店舗スタッフが承認なしで引取と納品の両方を変える (${r.msg ?? r.err})`);
eq([hvEv("pickup").date, hvEv("delivery").date, hvEv("delivery").slot], [future(21), future(24), "pm"], "予定表の引取・納品の予定も動く");
eq(hvEv("delivery").assigneeIds, [staffUser.id, manager.id], "納品の担当者もこの画面で変えられる");
eq(db().approvals.length, apBefore, "承認の申請は作らない (予定の変更は承認なし)");
ok(/関連する納品の予定も/.test(r.msg ?? ""), "画面に「関連する納品の予定も…に変更しました」");
let notice = (db().changeNotices ?? []).filter((n) => n.targetId === "o_cc_a" && n.topic === "予定の変更").at(-1);
ok(notice && notice.actorId === staffUser.id && notice.lines.some((l) => /引取/.test(l.label)) && notice.lines.some((l) => /納品/.test(l.label)), "お知らせ: 引取と納品の変更前 → 変更後 (1 件にまとめる)");
ok(notice && notice.recipients.includes(manager.id) && notice.recipients.includes(admin.id) && (!hq || notice.recipients.includes(hq.id)) && !notice.recipients.includes(staffUser.id), "宛先: 担当店舗の店長・本部・管理者 (変更した本人は除く)");

// 案件のない (受注の日程と連動しない) 引取と、予定表から足した納品
r = await act(staffUser, () => SA.createScheduleEvent(form({ title: "テスト 引取", kind: "pickup", date: future(30), allDay: "1", storeId: M, customerId: "c_cc_b", assigneeIds: [staffUser.id], allowOverlap: "1", returnTo: ret })));
const plainPick = db().schedule.find((x) => x.title === "テスト 引取");
r = await act(staffUser, () => SA.addPairedDelivery(plainPick.id, form({ returnTo: ret, date: future(32), timeMode: "am", assigneeIds: [staffUser.id], allowOverlap: "1" })));
const plainDel = () => db().schedule.find((x) => x.sourceRef === `pair:${plainPick.id}`);
ok(Boolean(plainDel()), `予定表から納品の予定を足す (${r.msg ?? r.err})`);
r = await act(staffUser, () => SA.quickUpdateScheduleEvent(plainPick.id, form({ returnTo: ret, date: future(31), timeMode: "allday", pairId: plainDel().id, pairDate: future(34), pairTimeMode: "time", pairStartTime: "13:00", pairEndTime: "14:00", allowOverlap: "1" })));
eq([db().schedule.find((x) => x.id === plainPick.id).date, plainDel().date, plainDel().startTime, plainDel().endTime], [future(31), future(34), "13:00", "14:00"], `連動していない予定どうしも両方を変える (${r.msg ?? r.err})`);
r = await act(staffUser, () => SA.quickUpdateScheduleEvent(plainPick.id, form({ returnTo: ret, date: future(31), timeMode: "allday", pairId: "ev_nai", pairDate: future(34), pairTimeMode: "allday" })));
ok(/関連する予定が見つかりません/.test(r.err ?? ""), "関連する予定でない ID は断る");

/* ================================================================== */
section("① 引取の予定を削除するときに、関連する納品予定もあわせて削除");
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
let d = await getData(staffUser, plainPick.id);
eq([d.remove?.pair?.want, d.remove?.pair?.events.map((x) => x.id)], ["delivery", [plainDel().id]], "小さな画面のデータ: 「関連する納品予定も削除しますか？」の相手");
const delId = plainDel().id;
r = await act(staffUser, () => SA.deleteScheduleEvent(plainPick.id, form({ scope: "one", returnTo: ret, pairIds: delId })));
eq([db().schedule.some((x) => x.id === plainPick.id), db().schedule.some((x) => x.id === delId)], [false, true], `「引取予定のみ削除する」は納品を残す (${r.msg ?? r.err})`);
// 両方削除 (受注の日程と連動する引取と納品は、受注の日程から両方の日時を外す)
const pk = hvEv("pickup").id;
const dl = hvEv("delivery").id;
d = await getData(staffUser, pk);
ok(d.remove?.mode === "handover" && d.remove?.pair?.events.some((x) => x.id === dl), "連動する引取の予定にも、関連する納品の予定を出す");
r = await act(staffUser, () => SA.deleteScheduleEvent(pk, form({ scope: "one", returnTo: ret, withPair: "1", pairIds: dl })));
o = db().orders.find((x) => x.id === "o_cc_a");
eq([db().schedule.some((x) => x.id === pk), db().schedule.some((x) => x.id === dl), o.handovers?.[0]?.pickupDate, o.handovers?.[0]?.deliveryDate, o.handovers?.[0]?.item], [false, false, undefined, undefined, "tatami_omote"], `「両方削除する」: 引取と納品の予定が消え、受注の品目は残る (${r.msg ?? r.err})`);
ok(db().orders.some((x) => x.id === "o_cc_a") && db().quotes.some((x) => x.id === "q_cc_a"), "案件の情報 (受注・見積) は残る");
r = await act(staffUser, () => SA.deleteScheduleEvent(delId, form({ scope: "one", returnTo: ret, withPair: "1", pairIds: "ev_nai" })));
ok(/関連する予定が見つかりません/.test(r.err ?? "") && db().schedule.some((x) => x.id === delId), "関連しない予定の ID を送ったら何も消さない");

/* ================================================================== */
section("③⑥ 明細の修正・追加・部分キャンセル (差額 1 万円以下は承認なし)");
const q = () => db().quotes.find((x) => x.id === "q_cc_a");
const itemsOf = (list) => JSON.stringify(list);
let items = q().items.map((i) => ({ ...i }));
items[1].qty = 5; // 襖 4 → 5 枚 (+5,000 円)
r = await act(staffUser, () => CQ.quickAmendLines("q_cc_a", form({ items: itemsOf(items), returnTo: ret })));
eq([r.err, q().version, q().total, q().pendingChange, db().orders.find((x) => x.id === "o_cc_a").total], [null, 2, 97000, undefined, 97000], `店舗スタッフの差額 +5,000 円は承認なしで第 2 版・受注の金額も変わる (${r.msg ?? r.err})`);
eq(r.path, "/schedule", "予定表の小さな画面に戻る");
notice = (db().changeNotices ?? []).filter((n) => n.targetId === "o_cc_a" && n.topic === "明細・金額の変更").at(-1);
ok(notice && notice.lines.some((l) => /明細の変更: 襖張替え/.test(l.label)) && notice.lines.some((l) => l.label.startsWith("合計") && l.before === "¥92,000" && l.after === "¥97,000"), "お知らせ: 明細と合計の変更前 → 変更後");
items = q().items.map((i) => ({ ...i }));
items[0].spec = "さくら"; // 仕様だけ (差額 0)
r = await act(staffUser, () => CQ.quickAmendLines("q_cc_a", form({ items: itemsOf(items), returnTo: ret })));
eq([r.err, q().version, q().items[0].spec], [null, 3, "さくら"], "仕様だけの変更も承認なし");
items = q().items.filter((i) => i.name !== "襖張替え").map((i) => ({ ...i })); // 襖をキャンセル (−25,000 円)
r = await act(staffUser, () => CQ.quickAmendLines("q_cc_a", form({ items: itemsOf(items), returnTo: ret })));
ok(/理由が必要/.test(r.err ?? "") && q().version === 3, `差額が 1 万円を超えるときは理由が要る (${r.err})`);
r = await act(staffUser, () => CQ.quickAmendLines("q_cc_a", form({ items: itemsOf(items), reason: "襖はキャンセル", returnTo: ret })));
eq([r.err, Boolean(q().pendingChange), lastApproval().type, lastApproval().status], [null, true, "quote_amend", "pending"], `差額 −25,000 円 (部分キャンセル) は店長の承認待ち (${r.msg ?? r.err})`);
r = await decide(manager, lastApproval().id);
eq([q().version, q().total, q().items.length], [4, 72000, 1], "店長が承認 → 部分キャンセルを反映 (版の履歴に残る)");
ok(q().revisions.length === 3, "変更前の版はすべて残る");
// 施工完了した受注 (確定した売上) は少額でも管理者の承認
await store.mutate((x) => { x.orders.find((y) => y.id === "o_cc_a").status = "completed"; });
ok(!AD.smallAmountChange(db(), { type: "quote_amend", targetId: "q_cc_a", changes: [] }), "施工完了の案件の見積の変更は「少額の承認なし」にしない");
await store.mutate((x) => { x.orders.find((y) => y.id === "o_cc_a").status = "confirmed"; });
// 設定で使わない (0) にすると承認
await store.mutate((x) => { const s = x.settings.find((y) => y.id === "approval"); if (s) s.value = { ...s.value, smallChangeLimit: 0 }; else x.settings.push({ id: "approval", value: { smallChangeLimit: 0 }, updatedAt: now }); });
items = q().items.map((i) => ({ ...i, qty: i.qty }));
items[0].unitPrice = 12100;
r = await act(staffUser, () => CQ.quickAmendLines("q_cc_a", form({ items: itemsOf(items), reason: "単価の訂正", returnTo: ret })));
ok(Boolean(q().pendingChange), "設定で 0 円 (使わない) にすると少額の変更も承認待ち");
await store.mutate((x) => { x.approvals.find((a) => a.id === lastApproval().id).status = "cancelled"; x.quotes.find((y) => y.id === "q_cc_a").pendingChange = undefined; const s = x.settings.find((y) => y.id === "approval"); s.value = { ...s.value, smallChangeLimit: 10000 }; });

/* ================================================================== */
section("⑥ 変更のお知らせ (既読・案件ごとの履歴・本部と管理者)");
const mine = CN.unreadNotices(db(), manager);
ok(mine.length > 0 && mine.every((n) => n.recipients.includes(manager.id)), `店長に未読のお知らせ (${mine.length} 件)`);
r = await act(manager, () => NA.markNoticesRead(form({ ids: mine[0].id, returnTo: "/notices" })));
ok(!CN.isUnread(manager, db().changeNotices.find((n) => n.id === mine[0].id)), "既読にする");
r = await act(manager, () => NA.markNoticesRead(form({ all: "1", returnTo: "/notices" })));
eq(CN.unreadNotices(db(), manager).length, 0, "すべて既読にする");
const hist = CN.caseNotices(db(), ["inq_cc_a"]);
ok(hist.length >= 4 && hist.every((n) => n.caseIds.includes("inq_cc_a") || n.targetId === "inq_cc_a"), "問い合わせの ID からでも案件の変更の履歴 (受注の予定・明細の変更) を引ける");
const recips = CN.noticeRecipients(db(), M, staffUser.id);
ok(recips.includes(admin.id) && (!hq || recips.includes(hq.id)), "既定: 本部と管理者にも届く");
await store.mutate((x) => { const s = x.settings.find((y) => y.id === "approval"); s.value = { ...s.value, noticeHq: false }; });
const recips2 = CN.noticeRecipients(db(), M, staffUser.id);
ok(!recips2.includes(admin.id) && recips2.includes(manager.id), "設定で「本部と管理者にも」を外すと担当店舗だけ");
await store.mutate((x) => { const s = x.settings.find((y) => y.id === "approval"); s.value = { ...s.value, noticeHq: true }; });
const openRoute = await imp("app/(app)/notices/[id]/open/route.ts");
const last = db().changeNotices.filter((n) => n.recipients.includes(admin.id) && CN.isUnread(admin, n)).at(-1);
if (last) {
  globalThis.__testUser = admin;
  const res = await openRoute.GET(new Request("http://test.local/x"), { params: Promise.resolve({ id: last.id }) });
  globalThis.__testUser = undefined;
  eq([res.status, res.headers.get("location"), CN.isUnread(admin, db().changeNotices.find((n) => n.id === last.id))], [303, last.href, false], "ベルのお知らせを開くと既読にして案件の画面へ (相対の転送)");
}

/* ================================================================== */
section("⑤ 紐付け間違いの修正 (見積・受注のあとも、内容はそのままにお客様だけ)");
r = await act(staffUser, () => CQ.relinkCase("o_cc_a", form({ customerId: "c_cc_b", returnTo: ret })));
eq([r.err, db().orders.find((x) => x.id === "o_cc_a").customerId, q().customerId, db().inquiries.find((x) => x.id === "inq_cc_a").customerId], [null, "c_cc_b", "c_cc_b", "c_cc_b"], `受注・見積・問い合わせをまとめて付け替える (${r.msg ?? r.err})`);
ok(q().items.length === 1 && db().orders.find((x) => x.id === "o_cc_a").total === 72000, "明細・金額はそのまま");
ok((db().changeNotices ?? []).some((n) => n.topic === "お客様の付け替え" && n.lines[0].before.includes("変更 太郎") && n.lines[0].after.includes("正しい 花子")), "お知らせ: お客様の変更前 → 変更後");
r = await act(staffUser, () => CQ.relinkCase("o_cc_a", form({ customerId: "c_cc_b", returnTo: ret })));
ok(/すでに/.test(r.err ?? ""), "同じお客様には付け替えない");
await store.mutate((x) => { x.invoices.push({ id: "inv_cc", number: "INV-CC-1", orderId: "o_cc_a", customerId: "c_cc_b", storeId: M, status: "issued", issueDate: now.slice(0, 10), dueDate: "2099-12-31", items: [], subtotal: 72000, tax: 0, total: 72000, paidAmount: 0, createdBy: admin.id, createdAt: now, updatedAt: now }); });
r = await act(staffUser, () => CQ.relinkCase("o_cc_a", form({ customerId: "c_cc_a", returnTo: ret })));
ok(/請求書を発行済み/.test(r.err ?? ""), "請求書を発行した案件は付け替えない");
await store.mutate((x) => { x.invoices = x.invoices.filter((i) => i.id !== "inv_cc"); });

/* ================================================================== */
section("⑨ 依頼主の住所と施工現場の住所 / ⑩ 同じお客様の新しい案件");
r = await act(staffUser, () => CQ.quickNewCase(form({ customerId: "c_cc_corp", summary: "テスト邸 和室 表替え", siteAddress: "熊本県テスト市南町7-8-9", media: "business", category: "tatami", kind: "survey", date: future(15), timeMode: "am", assigneeIds: [staffUser.id], allowOverlap: "1", returnTo: ret })));
const newInq = db().inquiries.filter((x) => x.customerId === "c_cc_corp").at(-1);
eq([r.err, newInq?.siteAddress, newInq?.media, newInq?.status], [null, "熊本県テスト市南町7-8-9", "business", "in_progress"], `業者の新しい案件: 施工現場の住所・媒体 (${r.msg ?? r.err})`);
const newEv = db().schedule.find((x) => x.inquiryId === newInq?.id);
eq([newEv?.kind, newEv?.date, newEv?.slot, newEv?.location], ["survey", future(15), "am", "熊本県テスト市南町7-8-9"], "最初の予定も登録 (場所は現場)");
eq(LBL.eventLabeler(db()).label(newEv).area, "南町", "予定表の町名は現場 (業者の所在地ではない)");
r = await act(staffUser, () => CQ.setCaseSite(newInq.id, form({ siteAddress: "熊本県テスト市西町1-1", returnTo: ret })));
eq([r.err, db().inquiries.find((x) => x.id === newInq.id).siteAddress, db().schedule.find((x) => x.id === newEv.id).location], [null, "熊本県テスト市西町1-1", "熊本県テスト市西町1-1"], `現場の住所を直すと、問い合わせの段階の予定の場所も現場になる (${r.msg ?? r.err})`);
eq(db().customers.find((c) => c.id === "c_cc_corp").address, "熊本県テスト市工業団地1", "依頼主 (業者) の住所はそのまま");
r = await act(staffUser, () => CQ.quickNewCase(form({ customerId: "c_cc_corp", summary: "", media: "business", returnTo: ret })));
ok(/内容/.test(r.err ?? ""), "内容のない新しい案件は断る");
d = await getData(staffUser, newEv.id);
eq([d.caseEdit?.site?.address, d.caseEdit?.site?.corporate, d.caseEdit?.newCase?.media, d.caseEdit?.relink?.canRelink], ["熊本県テスト市西町1-1", true, "business", true], "小さな画面のデータ: 施工現場・新しい案件 (業者は「取引先」)・付け替え");

/* ================================================================== */
section("④ 作業の担当 (現地見積・引取・納品・施工) と施工完了の確定");
await store.mutate((x) => {
  x.schedule.push({ id: "ev_cc_sv", title: "見積", kind: "survey", date: future(-5), storeId: M, assigneeIds: [manager.id], orderId: "o_cc_a", customerId: "c_cc_b", source: "manual", createdAt: now, updatedAt: now, createdBy: manager.id });
  x.schedule.push({ id: "ev_cc_pk", title: "引取", kind: "pickup", date: future(1), storeId: M, assigneeIds: [staffUser.id], orderId: "o_cc_a", customerId: "c_cc_b", source: "manual", createdAt: now, updatedAt: now, createdBy: manager.id });
});
let ws = WSF.workStaffOf(db(), db().orders.find((x) => x.id === "o_cc_a"));
eq([ws.source, ws.survey, ws.pickup], ["auto", [manager.id], [staffUser.id]], "保存の前は予定表の予定の担当者から自動");
await store.mutate((x) => { x.surveys.push({ id: "sv_cc", receivedAt: now, storeId: M, orderId: "o_cc_a", salesUserId: staffUser.id, deliveryUserIds: [staffUser.id], source: "capture", createdAt: now, updatedAt: now }); });
// 施工完了 (売上登録) は作業ごとに担当者か「なし」とポスティングが要る (2026-11-27「■3」)
r = await act(staffUser, () => OA.completeOrder("o_cc_a", form({ completedAt: now.slice(0, 10), workStaffSent: "1", "workStaff.survey": manager.id, "workStaff.pickup": [staffUser.id], "workStaff.delivery": [staffUser.id, manager.id], "workStaff.install.none": "1", postingSent: "1", "posting.status": "none" })));
o = db().orders.find((x) => x.id === "o_cc_a");
eq([r.err, o.status, o.workStaff?.survey, o.workStaff?.delivery, Boolean(o.workStaff?.confirmedAt)], [null, "completed", [manager.id], [staffUser.id, manager.id], true], `施工完了で作業の担当を確定 (複数名) (${r.msg ?? r.err})`);
const sv = db().surveys.find((x) => x.id === "sv_cc");
eq([sv.salesUserId, sv.deliveryUserIds], [manager.id, [staffUser.id, manager.id]], "アンケートの ②③ の担当 (インセンティブの起点) も確定した担当にそろう");
const idx = OS.orderStaffIndex(db()).byOrder.get("o_cc_a");
eq([idx.sales, idx.workers], [[manager.id], [staffUser.id, manager.id]], "経営の集計の担当・施工担当も確定した担当");
r = await act(manager, () => OA.saveWorkStaff("o_cc_a", form({ returnTo: "/orders/o_cc_a", "workStaff.survey": manager.id, "workStaff.pickup": [staffUser.id], "workStaff.delivery": [manager.id] })));
eq([r.err, db().orders.find((x) => x.id === "o_cc_a").workStaff.delivery], [null, [manager.id]], `完了のあとも作業の担当を直せる (${r.msg ?? r.err})`);
ok((db().changeNotices ?? []).some((n) => n.topic === "作業の担当の変更" && n.lines.some((l) => /納品/.test(l.label))), "お知らせ: 作業の担当の変更");
eq(db().surveys.find((x) => x.id === "sv_cc").deliveryUserIds, [manager.id, staffUser.id], "直すとアンケートの担当も変わる (納品・施工・引取の人)");

/* ================================================================== */
section("⑦⑧ 受付メモの日程の読み取り");
eq(R.normalizeAppointments([{ kind: "pickup", date: "2026-12-01", time: "9:30", slot: "pm", text: "12/1 9:30 引取" }, { kind: "nope", date: "", time: "", slot: "", text: "来週あたり" }, { kind: "delivery", date: "bad", time: "", slot: "am", text: "" }]), [{ kind: "pickup", date: "2026-12-01", time: "09:30", slot: "", text: "12/1 9:30 引取" }, { kind: "survey", date: "", time: "", slot: "", text: "来週あたり" }], "日程をそろえる (時刻があれば午前午後は空・読めない日付と空の行は除く)");
eq(R.normalizeAppointments(JSON.stringify([{ kind: "survey", date: "2026-12-03", time: "", slot: "am", text: "", register: true, assigneeId: "u1" }]))[0], { kind: "survey", date: "2026-12-03", time: "", slot: "am", text: "", register: true, assigneeId: "u1" }, "画面の JSON (予定表に登録・担当) も読む");
const sch = AIR.RECEPTION_SCHEMA;
const ap = sch.properties.appointments;
ok(sch.required.includes("appointments") && sch.required.includes("siteAddress") && ap.items.required.length === Object.keys(ap.items.properties).length && ap.items.additionalProperties === false, "AI の JSON Schema: 日程と施工現場の住所 (全項目 required・additionalProperties: false)");
eq(R.normalizeReception({ siteAddress: " 熊本県テスト市南町1 " }).siteAddress, "熊本県テスト市南町1", "施工現場の住所");

/* ================================================================== */
section("⑪ 予定表からの依頼 (メンション)");
const CR = await imp("lib/case-requests.ts");
const MA = await imp("lib/actions/messages.ts");
const Q = await imp("lib/db/queries.ts");
const evReq = db().schedule.find((x) => x.id === "ev_cc_pk");
d = await getData(staffUser, evReq.id);
eq([d.request?.kinds.map((k) => k.label), d.request?.storeId], [["日程変更依頼", "仕様変更依頼", "クレーム・手直し", "その他"], M], "小さな画面のデータ: 依頼の種類の候補と宛先の店舗 (案件の店舗)");
r = await act(staffUser, () => CQ.sendCaseRequest(form({ eventId: evReq.id, kind: "schedule_change", target: "store", storeId: M, note: "引取を午後にしてほしいとのこと", due: "tomorrow", returnTo: ret })));
let th = db().threads.filter((x) => x.caseRequest).at(-1);
const members = db().users.filter((u) => u.active && u.storeId === M && (u.role === "store_manager" || u.role === "store_staff") && u.id !== staffUser.id).map((u) => u.id);
eq([r.err, th?.caseRequest, th?.relatedId, th?.eventId, th?.taskStatus, th?.assigneeStoreId], [null, "schedule_change", "o_cc_a", evReq.id, "requested", M], `店舗に日程変更依頼を送る (${r.msg ?? r.err})`);
ok(members.length > 0 && members.every((id) => th.assigneeIds.includes(id)) && !th.assigneeIds.includes(staffUser.id), "宛先: 店舗の店長・スタッフ全員 (送った本人を除く)");
const msg0 = db().messages.find((m) => m.threadId === th.id);
ok(/【日程変更依頼】/.test(msg0.body) && /O-CC-1/.test(msg0.body) && /引取を午後に/.test(msg0.body) && /案件を開く: \/orders\/o_cc_a/.test(msg0.body) && msg0.mentions.includes(manager.id), "本文: 種類・案件番号・内容・案件の画面 (メンション)");
ok(/日程変更依頼/.test(th.title) && /O-CC-1/.test(th.title), "件名で、どの案件の依頼かすぐ分かる");
ok(Boolean(th.dueDate), "期限 (明日中)");
const nt = Q.notificationsFor(manager).tasks.find((x) => x.threadId === th.id);
ok(Boolean(nt), "店長のお知らせ (業務依頼) に出る");
eq(CR.caseRequestHref(db(), th), "/orders/o_cc_a#case-requests", "お知らせを押すと案件の画面の「この案件への依頼」を開く");
ok(db().orders.find((x) => x.id === "o_cc_a").progressNotes.some((n) => /日程変更依頼を送信/.test(n.body)), "受注の経過メモに残る");
ok(db().auditLogs.some((l) => l.entity === "thread" && l.entityId === th.id && /日程変更依頼を送信/.test(l.summary)), "変更履歴に送信の記録 (日時・送信者・送信先)");
ok(CR.caseRequestsOf(db(), ["inq_cc_a"]).some((x) => x.id === th.id), "問い合わせ・見積の ID からでも「この案件への依頼」に出る");
r = await act(manager, () => MA.taskStep(th.id, "ack", form({ returnTo: "/orders/o_cc_a#case-requests" })));
eq([r.err, db().threads.find((x) => x.id === th.id).taskStatus, r.path], [null, "acknowledged", "/orders/o_cc_a"], "受けた人が案件の画面で「確認しました」→ 案件の画面に戻る");
r = await act(staffUser, () => CQ.sendCaseRequest(form({ caseId: "q_cc_a", kind: "claim", target: "users", assigneeIds: [manager.id], note: "引手がゆるい", urgent: "1", returnTo: "/quotes/q_cc_a" })));
th = db().threads.filter((x) => x.caseRequest).at(-1);
eq([r.err, th.caseRequest, th.assigneeIds, th.assigneeStoreId, /【至急】/.test(th.title)], [null, "claim", [manager.id], undefined, true], `案件の画面から担当者を選んでクレーム・手直し (至急) (${r.msg ?? r.err})`);
r = await act(staffUser, () => CQ.sendCaseRequest(form({ eventId: evReq.id, kind: "other", target: "store", note: "", returnTo: ret })));
ok(/内容を書いて/.test(r.err ?? ""), "「その他」は内容が必須");
r = await act(staffUser, () => CQ.sendCaseRequest(form({ eventId: evReq.id, kind: "spec_change", target: "users", assigneeIds: [staffUser.id], returnTo: ret })));
ok(/担当者を選んで/.test(r.err ?? ""), "自分だけを宛先にはできない");
r = await act(staffUser, () => CQ.sendCaseRequest(form({ eventId: evReq.id, kind: "bogus", target: "store", returnTo: ret })));
ok(/種類/.test(r.err ?? ""), "種類のない依頼は断る");

/* ================================================================== */
section("メンションからの日程調整・予定登録 (依頼の画面)");
const RC = await imp("lib/request-context.ts");
await store.mutate((x) => {
  const c = x.customers.find((y) => y.id === "c_cc_a");
  c.phone = "090-1111-2222";
  c.contacts = [{ id: "cc_x", relation: "ご家族 (携帯)", phone: "080-3333-4444" }];
  x.inquiries.push({ id: "inq_cc_req", number: "INQ-CC-9", customerId: "c_cc_a", contactName: "変更 太郎", channel: "phone", storeId: M, category: "fusuma", summary: "襖 4 枚の張替えの相談", detail: "2 階の和室。日中は不在が多い", status: "new", receivedAt: now, createdBy: staffUser.id, updatedAt: now, media: "repeat" });
});
r = await act(staffUser, () => CQ.sendCaseRequest(form({ caseId: "inq_cc_req", kind: "schedule_change", target: "users", assigneeIds: [manager.id], note: "お客様に電話して見積の日を決めてください", returnTo: "/inquiries/inq_cc_req" })));
let rt = db().threads.filter((x) => x.caseRequest).at(-1);
let ctx = RC.requestContext(db(), manager, rt, future(0));
eq(ctx?.phones.map((p) => p.number), ["090-1111-2222", "080-3333-4444"], "依頼の画面: お客様の電話番号 (押すと電話。ほかの電話番号も)");
eq([ctx?.visit?.address, Boolean(ctx?.visit?.directionsUrl)], ["熊本県テスト市本町1-2-3", true], "訪問先の住所と経路のリンク");
ok(ctx?.content[0]?.title === "襖 4 枚の張替えの相談" && /2 階の和室/.test(ctx?.content[0]?.text ?? ""), "問い合わせの内容");
eq([ctx?.schedule?.caseRef, ctx?.schedule?.kind, ctx?.schedule?.move], ["inquiry:inq_cc_req", "survey", undefined], "日程の登録: 問い合わせの案件・初期値は見積り");
r = await act(manager, () => CQ.scheduleFromRequest(rt.id, form({ mode: "new", kind: "survey", date: future(40), timeMode: "am", assigneeIds: [manager.id], close: "1", allowOverlap: "1" })));
const regEv = db().schedule.find((x) => x.inquiryId === "inq_cc_req");
rt = db().threads.find((x) => x.id === rt.id);
eq([r.err, r.path, regEv?.kind, regEv?.date, regEv?.slot, regEv?.assigneeIds], [null, `/messages/${rt.id}`, "survey", future(40), "am", [manager.id]], `依頼の画面から予定を登録 (${r.msg ?? r.err})`);
eq([rt.taskStatus, rt.status], ["confirmed", "done"], "予定を登録したら依頼は報告・対応完了");
const rep = db().messages.filter((m) => m.threadId === rt.id).at(-1);
ok(rep?.event === "report" && /日程を登録しました/.test(rep.body) && rep.mentions.includes(staffUser.id), "報告のメッセージ (依頼した人にメンション)");
ok(/対応完了/.test(r.msg ?? ""), "画面に「対応完了にしました」");
// 予定を送った日程変更依頼: 依頼の予定の日時を変える
r = await act(staffUser, () => CQ.sendCaseRequest(form({ eventId: regEv.id, kind: "schedule_change", target: "users", assigneeIds: [manager.id], note: "お客様の都合で日を変えたい", returnTo: ret })));
rt = db().threads.filter((x) => x.caseRequest).at(-1);
ctx = RC.requestContext(db(), manager, rt, future(0));
eq([ctx?.schedule?.preferMove, ctx?.schedule?.move?.id], [true, regEv.id], "日程変更依頼は「依頼の予定の日時を変更」が既定");
r = await act(manager, () => CQ.scheduleFromRequest(rt.id, form({ mode: "move", date: future(42), timeMode: "time", startTime: "13:00", endTime: "14:00", assigneeIds: [manager.id, staffUser.id], memo: "消さない", close: "1", allowOverlap: "1" })));
const moved = db().schedule.find((x) => x.id === regEv.id);
eq([r.err, moved.date, moved.startTime, moved.assigneeIds, db().threads.find((x) => x.id === rt.id).taskStatus], [null, future(42), "13:00", [manager.id, staffUser.id], "confirmed"], `依頼の予定の日時・担当を変えて完了 (${r.msg ?? r.err})`);
ok(db().schedule.filter((x) => x.inquiryId === "inq_cc_req").length === 1, "新しい予定は増えない (同じ予定を動かす)");
// 登録できなかったときは依頼は完了にしない
r = await act(staffUser, () => CQ.sendCaseRequest(form({ caseId: "inq_cc_req", kind: "other", target: "users", assigneeIds: [manager.id], note: "訪問の日程を", returnTo: ret })));
rt = db().threads.filter((x) => x.caseRequest).at(-1);
// 予定は担当者なしでも登録できる (2026-11-27「■2」) ので、日付の誤りで登録できないときを確かめる
r = await act(manager, () => CQ.scheduleFromRequest(rt.id, form({ mode: "new", kind: "survey", date: "2026-13-40", timeMode: "allday", assigneeIds: [manager.id], close: "1" })));
eq([Boolean(r.err), r.path, db().threads.find((x) => x.id === rt.id).taskStatus], [true, `/messages/${rt.id}`, "requested"], `日付の誤りなど登録できないときは依頼の画面に戻り、依頼はそのまま (${r.err})`);
r = await act(manager, () => CQ.scheduleFromRequest(rt.id, form({ mode: "new", kind: "survey", date: future(43), timeMode: "allday", assigneeIds: [manager.id], allowOverlap: "1" })));
eq([r.err, db().threads.find((x) => x.id === rt.id).taskStatus], [null, "requested"], "「完了にする」を外せば予定だけ登録 (依頼は対応中のまま)");
// 問い合わせの「担当へ依頼」(案件にひも付いた業務依頼) にも同じ情報を出す
r = await act(staffUser, () => IA.requestInquiry("inq_cc_req", form({ purpose: "schedule", assigneeId: manager.id, due: "today", note: "訪問日程の打ち合わせをお願いします", returnTo: "/inquiries/inq_cc_req" })));
const inqTh = db().threads.filter((x) => x.kind === "request" && x.relatedType === "inquiry" && x.relatedId === "inq_cc_req" && !x.caseRequest).at(-1);
ok(Boolean(inqTh), `問い合わせの「担当へ依頼」(${r.msg ?? r.err})`);
if (inqTh) ok(Boolean(RC.requestContext(db(), admin, inqTh, future(0))), "問い合わせの「担当へ依頼」の画面にもお客様の情報と日程の登録を出す");

/* ================================================================== */
section("予定表の検索・場所からの候補日 (お客様のご要望 2026-11-25)");
const SF = await imp("lib/schedule-find.ts");
const GEO = await imp("lib/geo/kumamoto.ts");
const today0 = future(0);
let fr = SF.searchSchedule(db(), staffUser, "変更 太郎", today0);
const hitReq = fr.events.find((e) => e.id === regEv.id);
ok(Boolean(hitReq) && hitReq.upcoming && /qe=/.test(hitReq.href) && hitReq.href.includes(`date=${hitReq.date}`), `お客様名で予定を探す → その日の予定表 (予定の小さな画面) へ (${fr.events.length} 件)`);
fr = SF.searchSchedule(db(), staffUser, "090-1111", today0);
ok(fr.mode === "phone" && fr.events.some((e) => e.id === regEv.id && e.reason === "電話番号"), "電話番号でも探せる");
fr = SF.searchSchedule(db(), staffUser, "テスト市本町", today0);
ok(fr.events.some((e) => e.id === regEv.id && /住所/.test(e.reason)) && fr.areaCount >= 1, "住所・地名で探すと、その地域の今後の予定");
ok(fr.events.every((e, i, a) => i === 0 || !e.upcoming || !a[i - 1].upcoming || a[i - 1].date <= e.date), "今後の予定は日付の近い順");
ok(SF.searchSchedule(db(), staffUser, "あ", today0).events.length === 0, "1 文字では探さない");
// 場所からの候補日
let cr = SF.placeCandidates(db(), { address: "熊本県テスト市本町1-2-3", storeId: M, today: today0, days: 60 });
const dReq = cr.days.find((d) => d.date === future(42));
eq([dReq?.tier, dReq?.same.some((e) => e.id === regEv.id)], ["same", true], "同じ町名に予定がある日 (同じ町名の予定つき)");
ok(cr.days.some((d) => d.tier === "free" && d.count === 0), "予定のない日も候補");
ok(cr.days.every((d, i, a) => i === 0 || a[i - 1].date < d.date), "日付の近い順");
await store.mutate((x) => {
  x.holidays = [...(x.holidays ?? []), { date: future(43), label: "テストの休業日" }];
});
cr = SF.placeCandidates(db(), { address: "熊本県テスト市本町1-2-3", storeId: M, today: today0, days: 60 });
ok(!cr.days.some((d) => d.date === future(43)), "休業日は候補にしない");
// 近隣 (目安の距離): 熊本の町名の位置で比べる (社内の計算。外部の地図サービスは使わない)
const a1 = "熊本県合志市須屋100-1", a2 = "熊本県合志市幾久富1909-1";
// 日曜は休業日なので候補に出ない: 今日から数えた日が日曜なら次の日にする (日付によって失敗しないように)
const notSunday = (n) => [n, n + 1].map(future).find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0);
const nearDay = notSunday(50);
const busyDay = notSunday(nearDay === future(50) ? 51 : 52);
const g1 = GEO.geocodeAddress(a1), g2 = GEO.geocodeAddress(a2);
await store.mutate((x) => {
  x.schedule.push({ id: "ev_cc_near", title: "近隣テスト", kind: "survey", date: nearDay, storeId: M, assigneeIds: [staffUser.id], location: a1, source: "manual", createdAt: now, updatedAt: now, createdBy: staffUser.id });
  for (const n of [1, 2, 3, 4]) x.schedule.push({ id: `ev_cc_busy${n}`, title: `多い日${n}`, kind: "visit", date: busyDay, storeId: M, assigneeIds: [staffUser.id], location: "熊本県玉名市岩崎1", source: "manual", createdAt: now, updatedAt: now, createdBy: staffUser.id });
});
cr = SF.placeCandidates(db(), { address: a2, storeId: M, today: today0, days: 60 });
const dNear = cr.days.find((d) => d.date === nearDay);
if (g1 && g2) {
  const km = GEO.roadKm(g1, g2);
  ok(km <= 6 ? dNear?.tier === "near" && dNear.near[0]?.id === "ev_cc_near" : dNear?.tier !== "near", `近隣の予定 (道のりの目安 ${km.toFixed(1)} km。6 km 以内なら近くに予定あり)`);
} else ok(Boolean(dNear), "位置の目安がないときも日の一覧は出す");
const dBusy = cr.days.find((d) => d.date === busyDay);
ok(dBusy && dBusy.count >= 4 && (dBusy.tier === "busy" || dBusy.tier === "near"), "予定が 4 件以上で近くに予定のない日は「予定が多い日」");
ok(SF.rankCandidates(cr.days)[0].tier !== "busy" && SF.rankCandidates(cr.days).at(-1).tier !== "same", "おすすめの順: 同じ町名 → 近く → 少ない → なし → 多い");
ok(SF.placeCandidates(db(), { address: "", today: today0 }).days.length === 0, "住所が空なら候補なし");

/* ================================================================== */
section("問い合わせ登録の顧客 (必ず顧客に紐付けて残す・問い合わせだけの付け替え)");
r = await act(staffUser, () => IA.createInquiry(form({ contactName: "変更 太郎", contactPhone: "090-1111-2222", channel: "phone", media: "repeat", summary: "畳の相談", category: "tatami", address: "熊本県テスト市本町1-2-3" })));
ok(/同じお客様の可能性/.test(r.err ?? ""), "手入力の問い合わせ: 同じお客様の候補があると「別のお客様」の確認を求める (二重登録を防ぐ)");
const cBefore = db().customers.length;
r = await act(staffUser, () => IA.createInquiry(form({ contactName: "新規 三郎", contactPhone: "090-5555-6666", channel: "phone", media: "flyer", summary: "網戸の張替え", category: "amido", address: "熊本県テスト市西町9-9" })));
const inqNew = db().inquiries.at(-1);
const custNew = db().customers.find((c) => c.id === inqNew.customerId);
eq([r.err, db().customers.length, custNew?.name, custNew?.phone, custNew?.address], [null, cBefore + 1, "新規 三郎", "090-5555-6666", "熊本県テスト市西町9-9"], `手入力の問い合わせ: 新しいお客様は顧客としても登録 (${r.msg ?? r.err})`);
ok(db().commLogs.some((l) => l.relatedType === "inquiry" && l.relatedId === inqNew.id && l.customerId === custNew.id), "問い合わせの内容はお客様の履歴 (やりとり) に残る");
// 問い合わせだけを正しいお客様へ付け替える (見積は今のお客様のまま)
const qCust = db().quotes.find((x) => x.id === "q_cc_a").customerId;
r = await act(manager, () => IA.linkInquiryFromForm(form({ inquiryId: "inq_cc_a", customerId: "c_cc_corp", scope: "inquiry", returnTo: "/inquiries/inq_cc_a" })));
eq([r.err, db().inquiries.find((x) => x.id === "inq_cc_a").customerId, db().quotes.find((x) => x.id === "q_cc_a").customerId], [null, "c_cc_corp", qCust], `「この問い合わせだけ」: 問い合わせだけを付け替え、見積・受注はそのまま (${r.msg ?? r.err})`);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
