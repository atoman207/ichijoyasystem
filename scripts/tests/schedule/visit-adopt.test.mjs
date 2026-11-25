/**
 * お客様のご連絡 2026-11-25「予定表からの見積取込・受注登録」のテスト
 *   node scripts/tests/schedule/visit-adopt.test.mjs   (npm run test:schedule)
 * 見積の訪問がその場で現見になったとき、受注の作業 (引き取り・1 日の施工) が訪問と同じ日なら、新しい予定を足さずにその訪問の予定を「現見」に切り替える。
 * 作業が別の日なら訪問の予定は残して作業の予定を足す (src/lib/visit-adopt.ts・handover-events.ts・schedule.ts の syncOrderEvent)。
 * これまでに二重になった予定のまとめ (data-fix の visit-merge) も。データは一時フォルダーの JSON (サンプルデータ)。名前は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-visit-adopt-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
// PDF のフォントは作業フォルダーの src/assets/fonts から読む
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.symlinkSync(path.join(root, "src/assets"), path.join(work, "src/assets"));
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "visit-adopt-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-visit-adopt",
  CRON_SECRET: "test-cron-visit-adopt",
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
      return { path: u.pathname, url: e.url, msg: u.searchParams.get("msg"), err: u.searchParams.get("err"), sp: u.searchParams };
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
const S = db().stores.find((s) => s.kind === "store").id;
const now = new Date().toISOString();
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const plus = (d, n) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const day = today;
const later = plus(today, 7);
await store.mutate((x) => {
  const mk = (id, role) => x.users.push({ id, name: `試験 ${id}`, email: `${id}@example.test`, role, title: role, storeId: S, active: true, createdAt: now, updatedAt: now });
  mk("u_va_mgr", "store_manager");
  mk("u_va_staff", "store_staff");
  const cust = (id) => x.customers.push({ id, code: `C-9${id.slice(-4)}`, name: `架空 ${id}`, kana: "", phone: "", postalCode: "", address: "熊本県テスト市テスト町1", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
  const quote = (id, cid, inq, items, extra = {}) => x.quotes.push({ id, number: `Q-2026-${id.slice(-4)}`, version: 1, customerId: cid, inquiryId: inq, storeId: S, title: `工事 ${id}`, category: "tatami", items, subtotal: 40000, discount: 0, tax: 0, total: 40000, taxIncluded: true, status: "approved", createdBy: "u_va_staff", createdAt: now, updatedAt: now, ...extra });
  const inq = (id, cid) => x.inquiries.push({ id, number: `INQ-2026-${id.slice(-4)}`, customerId: cid, storeId: S, channel: "phone", category: "tatami", summary: "見積の依頼", detail: "", status: "quoted", receivedAt: now, createdBy: "u_va_staff", createdAt: now, updatedAt: now, media: "repeat" });
  const ev = (id, kind, extra) => x.schedule.push({ id, title: `（テスト町）架空 ${id}`, kind, date: day, storeId: S, assigneeIds: ["u_va_staff"], source: "manual", startTime: "14:00", memo: "2 階の和室", createdBy: "u_va_staff", createdAt: now, updatedAt: now, ...extra });
  const tatami = [{ id: "qi", name: "畳 表替え", qty: 4, unit: "畳", unitPrice: 10000, amount: 40000 }];
  // A: 見積の訪問 (問い合わせの予定) → その場で現見
  cust("c_va_a1"); inq("inq_va_a1", "c_va_a1"); quote("q_va_a1", "c_va_a1", "inq_va_a1", tatami); ev("ev_va_a1", "survey", { inquiryId: "inq_va_a1", customerId: "c_va_a1" });
  // B: 見積だけの訪問、作業は 1 週間後
  cust("c_va_b1"); inq("inq_va_b1", "c_va_b1"); quote("q_va_b1", "c_va_b1", "inq_va_b1", tatami); ev("ev_va_b1", "survey", { inquiryId: "inq_va_b1", customerId: "c_va_b1" });
  // C: 現見として入れていた予定 (お客様だけにひも付いた予定) + リフォーム (施工予定日の受注)
  cust("c_va_c1"); quote("q_va_c1", "c_va_c1", undefined, [{ id: "qr", name: "クロス張替え", qty: 1, unit: "式", unitPrice: 40000, amount: 40000 }], { category: "reform" }); ev("ev_va_c1", "onsite_quote", { customerId: "c_va_c1" });
  // D: ほかの案件の訪問は切り替えない
  cust("c_va_d1"); inq("inq_va_d1", "c_va_d1"); inq("inq_va_d2", "c_va_d1"); quote("q_va_d1", "c_va_d1", "inq_va_d1", tatami); ev("ev_va_d2", "survey", { inquiryId: "inq_va_d2", customerId: "c_va_d1" });
});
const u = (id) => db().users.find((x) => x.id === id);
const QA = await imp("lib/actions/quotes.ts");
const HA = await imp("lib/actions/handovers.ts");
const VA = await imp("lib/visit-adopt.ts");
const evOf = (orderId) => db().schedule.filter((e) => e.orderId === orderId);

section("1. 同じ日の作業: 見積の訪問を「現見」に切り替える (予定は増えない)");
{
  const before = db().schedule.length;
  const plan = [{ id: "hv_a1", item: "tatami_omote", label: "畳 表替え 4枚", pickupDate: day, deliveryDate: day }];
  const r = await act(u("u_va_mgr"), () => QA.convertQuoteToOrder("q_va_a1", form({ handovers: JSON.stringify(plan), returnTo: "/schedule?qe=ev_va_a1" })));
  const o = db().orders.find((x) => x.quoteId === "q_va_a1");
  const v = db().schedule.find((e) => e.id === "ev_va_a1");
  eq([v.kind, v.source, v.orderId, v.startTime, v.assigneeIds, v.memo], ["onsite_quote", "order", o.id, "14:00", ["u_va_staff"], "2 階の和室"], "見積の予定が受注の「現見」になる (時間・担当者・メモはそのまま)");
  eq(evOf(o.id).map((e) => e.kind).sort(), ["delivery", "onsite_quote"], "受注の予定は 現見 + 当日の納品 (引き取りの予定は増やさない)");
  eq(db().schedule.length, before + 1, "増えた予定は納品の 1 件だけ");
  ok(/訪問の予定を「現見」に切り替えました/.test(r.msg ?? ""), "切り替えたことを知らせる");
  eq(o.handovers[0].pickupStart, "14:00", "受注の日程にも訪問の時間を入れる (次の保存で時間が消えない)");
  ok(db().auditLogs.some((l) => l.entity === "schedule" && l.entityId === "ev_va_a1" && /現見/.test(l.summary)), "切り替えは変更履歴に残る");
  // もう一度保存しても現見のまま・増えない
  await act(u("u_va_mgr"), () => HA.saveOrderHandovers(o.id, form({ handovers: JSON.stringify(o.handovers), workerIds: o.workerIds })));
  eq([db().schedule.find((e) => e.id === "ev_va_a1")?.kind, evOf(o.id).length], ["onsite_quote", 2], "受注の画面で保存し直しても現見のまま (二重にならない)");
  // 作業を別の日に動かすと、訪問の予定は見積に戻し、引き取りの予定を作る
  const moved = o.handovers.map((h) => ({ ...h, pickupDate: later, pickupStart: undefined, deliveryDate: later }));
  await act(u("u_va_mgr"), () => HA.saveOrderHandovers(o.id, form({ handovers: JSON.stringify(moved), workerIds: o.workerIds })));
  const back = db().schedule.find((e) => e.id === "ev_va_a1");
  eq([back?.kind, back?.source, back?.orderId ?? null, back?.date], ["survey", "manual", null, day], "作業を別の日にすると、訪問の予定は見積の予定に戻る (消さない)");
  eq(evOf(o.id).map((e) => `${e.kind}:${e.date}`).sort(), [`delivery:${later}`, `pickup:${later}`], "作業の日に引き取り・納品の予定を作る");
}

section("2. 見積だけの訪問で、作業は別の日: 訪問の予定は残して作業の予定を足す");
{
  const plan = [{ id: "hv_b1", item: "tatami_omote", pickupDate: later, deliveryDate: later }];
  await act(u("u_va_mgr"), () => QA.convertQuoteToOrder("q_va_b1", form({ handovers: JSON.stringify(plan) })));
  const o = db().orders.find((x) => x.quoteId === "q_va_b1");
  const v = db().schedule.find((e) => e.id === "ev_va_b1");
  eq([v.kind, v.source, v.orderId ?? null], ["survey", "manual", null], "見積の予定はそのまま");
  eq(evOf(o.id).map((e) => `${e.kind}:${e.date}`).sort(), [`delivery:${later}`, `pickup:${later}`], "別の日の引き取り・納品の予定を追加");
}

section("3. 現見として入れた予定 (お客様だけにひも付いた予定) + 施工予定日の受注");
{
  await act(u("u_va_mgr"), () => QA.convertQuoteToOrder("q_va_c1", form({ scheduledStart: day })));
  const o = db().orders.find((x) => x.quoteId === "q_va_c1");
  const v = db().schedule.find((e) => e.id === "ev_va_c1");
  eq([v.kind, v.source, v.orderId, v.startTime], ["onsite_quote", "order", o.id, "14:00"], "現見の予定が受注の予定になる (施工の予定を増やさない)");
  eq(evOf(o.id).length, 1, "受注の予定は 1 件");
}

section("4. ほかの案件の訪問は切り替えない");
{
  const plan = [{ id: "hv_d1", item: "tatami_omote", pickupDate: day, deliveryDate: day }];
  await act(u("u_va_mgr"), () => QA.convertQuoteToOrder("q_va_d1", form({ handovers: JSON.stringify(plan) })));
  const o = db().orders.find((x) => x.quoteId === "q_va_d1");
  eq(db().schedule.find((e) => e.id === "ev_va_d2").kind, "survey", "同じお客様でも別の問い合わせの訪問はそのまま");
  eq(evOf(o.id).map((e) => e.kind).sort(), ["delivery", "pickup"], "引き取り・納品の予定を作る");
  eq(VA.isCaseVisit({ kind: "survey", source: "manual", customerId: "c_va_d1" }, { quoteId: "q", inquiryId: "inq_va_d1", customerId: "c_va_d1" }), true, "案件にひも付いていないお客様の訪問は同じ案件とみなす");
  eq(VA.isCaseVisit({ kind: "visit", source: "manual", customerId: "c_va_d1" }, { customerId: "c_va_d1" }), false, "顧客訪問・会議などは切り替えない (見積・現調・現見だけ)");
}

section("5. 受注を取り消すと、切り替えた予定は訪問の予定に戻す");
{
  const SC = await imp("lib/db/schedule.ts");
  const o = db().orders.find((x) => x.quoteId === "q_va_c1");
  await store.mutate((x) => {
    const oo = x.orders.find((y) => y.id === o.id);
    oo.status = "cancelled";
    SC.removeUpcomingOrderEvents(x, oo.id);
  });
  const v = db().schedule.find((e) => e.id === "ev_va_c1");
  eq([v?.kind, v?.source, v?.orderId ?? null], ["survey", "manual", null], "取り消し: 予定は消さずに訪問の予定に戻す");
}

section("6. これまでに二重になった予定をまとめる (data-fix の visit-merge)");
{
  await store.mutate((x) => {
    x.customers.push({ id: "c_va_e1", code: "C-99e1", name: "架空 e1", kana: "", phone: "", postalCode: "", address: "", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
    x.quotes.push({ id: "q_va_e1", number: "Q-2026-e001", version: 1, customerId: "c_va_e1", storeId: S, title: "床の工事", category: "reform", items: [], subtotal: 1, discount: 0, tax: 0, total: 1, status: "accepted", createdBy: "u_va_mgr", createdAt: now, updatedAt: now, orderId: "o_va_e1" });
    x.orders.push({ id: "o_va_e1", number: "O-2026-e001", quoteId: "q_va_e1", customerId: "c_va_e1", storeId: S, title: "床の工事", category: "reform", contractDate: day, total: 1, status: "scheduled", scheduledStart: day, workerIds: ["u_va_mgr"], siteAddress: "", progressNotes: [], createdBy: "u_va_mgr", createdAt: now, updatedAt: now });
    x.schedule.push({ id: "ev_va_e1v", title: "（テスト町）架空 e1", kind: "onsite_quote", date: day, storeId: S, assigneeIds: ["u_va_staff"], source: "manual", startTime: "14:00", customerId: "c_va_e1", createdBy: "u_va_staff", createdAt: now, updatedAt: now });
    x.schedule.push({ id: "ev_va_e1o", title: "架空 e1 様 床の工事 施工", kind: "install", date: day, storeId: S, assigneeIds: ["u_va_mgr"], source: "order", startTime: "09:00", endTime: "15:00", orderId: "o_va_e1", quoteId: "q_va_e1", customerId: "c_va_e1", createdBy: "u_va_mgr", createdAt: now, updatedAt: now });
  });
  const DF = await imp("app/api/cron/data-fix/route.ts");
  const call = async (q) => (await DF.POST(new Request(`http://test.local/api/cron/data-fix?task=visit-merge&${q}`, { method: "POST", headers: { authorization: "Bearer test-cron-visit-adopt" } }))).json();
  const dry = await call("from=2026-11-01");
  ok(dry.pairs.some((p) => p.visitId === "ev_va_e1v" && p.dupId === "ev_va_e1o"), "確認: 現見の予定と同じ日の施工の予定の組を見つける");
  ok(db().schedule.some((e) => e.id === "ev_va_e1o"), "確認だけでは書かない");
  await call("from=2026-11-01&apply=1");
  const v = db().schedule.find((e) => e.id === "ev_va_e1v");
  eq([v.kind, v.source, v.orderId, v.startTime, db().schedule.some((e) => e.id === "ev_va_e1o")], ["onsite_quote", "order", "o_va_e1", "14:00", false], "まとめる: 現見の予定が受注の予定になり、施工の予定は消える (時間は訪問のまま)");
  ok(db().auditLogs.some((l) => l.entityId === "ev_va_e1o" && l.action === "delete"), "消した予定は変更履歴に残る");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true });
