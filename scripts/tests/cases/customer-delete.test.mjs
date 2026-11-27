/**
 * お客様のご要望 2026-11-27「誤って同じ顧客を二重に登録してしまった場合の削除」のテスト
 *   node scripts/tests/cases/customer-delete.test.mjs   (npm run test:cases)
 * 売上の紐付いたお客様は削除しない・記録のないお客様はそのまま削除・記録があれば残すほうのお客様に移して削除 (電話番号・タグ・メモも)・
 * 店長以上は承認なし・店舗スタッフは所属店舗の店長の承認・削除したお客様の画面は統合先へ (src/lib/customer-delete.ts)
 * データは一時フォルダーの JSON (サンプルデータ)。名前は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-customer-delete-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.symlinkSync(path.join(root, "src/assets"), path.join(work, "src/assets"));
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "customer-delete-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  PUSH_DB_PATH: path.join(work, "push.sqlite"),
  SESSION_SECRET: "test-secret-for-customer-delete",
  CRON_SECRET: "test-cron-customer-delete",
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
const stores = db().stores.filter((s) => s.kind === "store");
const S = stores[0].id;
const S2 = stores[1].id;
const now = new Date().toISOString();
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const cust = (id, code, extra = {}) => ({ id, code, name: "架空 花子", kana: "カクウ ハナコ", phone: "", postalCode: "", address: "", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now, ...extra });
await store.mutate((x) => {
  // 店長は店舗にひとり (承認先が決まるように、サンプルデータの店長は外す)
  for (const u of x.users) if (u.storeId === S && u.role === "store_manager") u.active = false;
  const mk = (id, role, storeId) => x.users.push({ id, name: `試験 ${id}`, email: `${id}@example.test`, role, title: role, storeId, active: true, createdAt: now, updatedAt: now });
  mk("u_cd_admin", "admin", S);
  mk("u_cd_mgr", "store_manager", S);
  mk("u_cd_staff", "store_staff", S);
  mk("u_cd_other", "store_staff", S2);
  // 記録のないお客様 (誤って登録)
  x.customers.push(cust("c_cd_empty", "C-99801", { notes: "" }));
  // 二重登録: 残すお客様 (A) と消すお客様 (B)
  x.customers.push(cust("c_cd_keep", "C-99802", { phone: "096-111-2222", address: "熊本県合志市架空1-2-3", tags: ["リピート"], notes: "犬がいます" }));
  x.customers.push(cust("c_cd_dup", "C-99803", { phone: "090-1234-5678", address: "熊本県合志市架空1-2-3", tags: ["リピート", "紹介", "予定表から登録"], notes: "午前中の連絡がよい", contacts: [{ id: "cc_x", relation: "夫 携帯", phone: "080-9999-0000" }, { id: "cc_y", relation: "自宅", phone: "096-111-2222" }] }));
  x.inquiries.push({ id: "inq_cd_1", number: "INQ-2026-9801", customerId: "c_cd_dup", storeId: S, channel: "phone", category: "tatami", summary: "表替え", detail: "", status: "in_progress", receivedAt: now, createdBy: "u_cd_staff", createdAt: now, updatedAt: now, media: "repeat" });
  x.quotes.push({ id: "q_cd_1", number: "Q-2026-9801", version: 1, customerId: "c_cd_dup", inquiryId: "inq_cd_1", storeId: S, title: "見積", category: "tatami", items: [], subtotal: 1, discount: 0, tax: 0, total: 1, status: "approved", createdBy: "u_cd_staff", createdAt: now, updatedAt: now });
  x.orders.push({ id: "o_cd_1", number: "O-2026-9801", customerId: "c_cd_dup", quoteId: "q_cd_1", storeId: S, title: "表替え", category: "tatami", total: 1, status: "confirmed", contractDate: today, progressNotes: [], workerIds: [], createdBy: "u_cd_staff", createdAt: now, updatedAt: now });
  x.schedule.push({ id: "ev_cd_1", title: "引取", kind: "pickup", date: today, storeId: S, assigneeIds: [], orderId: "o_cd_1", customerId: "c_cd_dup", source: "manual", createdBy: "u_cd_staff", createdAt: now, updatedAt: now });
  x.attachments.push({ id: "att_cd_1", parentType: "customer", parentId: "c_cd_dup", customerId: "c_cd_dup", storeId: S, kind: "photo", fileName: "a.jpg", contentType: "image/jpeg", size: 1, storageKey: "x", uploadedBy: "u_cd_staff", uploadedAt: now });
  x.commLogs.push({ id: "cl_cd_1", customerId: "c_cd_dup", storeId: S, channel: "phone", direction: "inbound", subject: "電話", body: "電話がありました", at: now, userId: "u_cd_staff" });
  x.mapLocationRefs.push({ id: "mlr_customer_c_cd_dup", recordType: "customer", recordId: "c_cd_dup", mode: "manual", locationId: "loc_x", linkedBy: "u_cd_staff", linkedAt: now });
  x.changeNotices.push({ id: "cn_cd_1", at: now, actorId: "u_cd_staff", storeId: S, targetType: "customer", targetId: "c_cd_dup", caseIds: [], title: "架空 花子 様", customerId: "c_cd_dup", topic: "お客様の変更", lines: [], href: "/customers/c_cd_dup", recipients: [], readBy: [] });
  x.approvals.push({ id: "ap_cd_view", type: "record_view", targetId: "c_cd_dup", title: "閲覧", amount: 0, storeId: S, requestedBy: "u_cd_other", requiredRole: "store_manager", status: "pending", createdAt: now });
  // 売上の紐付いたお客様
  x.customers.push(cust("c_cd_sales", "C-99804"));
  x.orders.push({ id: "o_cd_s", number: "O-2026-9804", customerId: "c_cd_sales", storeId: S, title: "施工済み", category: "tatami", total: 1, status: "completed", salesDate: today, contractDate: today, progressNotes: [], workerIds: [], createdBy: "u_cd_staff", createdAt: now, updatedAt: now });
  x.customers.push(cust("c_cd_inv", "C-99805"));
  x.invoices.push({ id: "inv_cd", number: "INV-2026-9805", customerId: "c_cd_inv", storeId: S, issueDate: today, dueDate: today, items: [], subtotal: 1, tax: 0, total: 1, paidAmount: 0, status: "issued", createdBy: "u_cd_staff", createdAt: now, updatedAt: now });
  // 店舗スタッフの申請用
  x.customers.push(cust("c_cd_keep2", "C-99806", { phone: "096-333-4444" }));
  x.customers.push(cust("c_cd_dup2", "C-99807", { phone: "096-333-4444" }));
  x.inquiries.push({ id: "inq_cd_2", number: "INQ-2026-9807", customerId: "c_cd_dup2", storeId: S, channel: "phone", category: "tatami", summary: "網戸", detail: "", status: "new", receivedAt: now, createdBy: "u_cd_staff", createdAt: now, updatedAt: now, media: "repeat" });
});
const u = (id) => db().users.find((x) => x.id === id);
const CA = await imp("lib/actions/customers.ts");
const CD = await imp("lib/customer-delete.ts");
const AP = await imp("lib/approval-decide.ts");
const P = await imp("lib/auth/permissions.ts");
const c = (id) => db().customers.find((x) => x.id === id);

section("1. 記録のないお客様: 店長がそのまま削除");
{
  eq([CD.customerDeletePlan(db(), "c_cd_empty").blockers, CD.customerDeletePlan(db(), "c_cd_empty").total], [[], 0], "売上も記録もない");
  const r0 = await act(u("u_cd_mgr"), () => CA.deleteCustomer("c_cd_empty", form({})));
  ok(/理由/.test(r0.err ?? "") && c("c_cd_empty"), "理由がないと削除しない");
  const r = await act(u("u_cd_mgr"), () => CA.deleteCustomer("c_cd_empty", form({ reasonChoice: "誤って登録" })));
  ok(!c("c_cd_empty"), "削除した");
  ok(r.path === "/customers" && /削除しました/.test(r.msg ?? ""), "顧客の一覧に戻り、削除したことを知らせる");
  const log = db().auditLogs.find((l) => l.entity === "customer" && l.entityId === "c_cd_empty" && l.action === "delete");
  ok(log && log.userId === "u_cd_mgr" && /誤って登録/.test(log.summary) && log.changes?.some((x) => x.field === "deletedRecord" && x.before?.code === "C-99801"), "変更履歴: 誰が・理由・削除の前の登録内容");
  eq(CD.deletedCustomerOf(db(), "c_cd_empty")?.mergedInto, undefined, "統合先なし (画面のリンクは顧客の一覧へ)");
}

section("2. 売上の紐付いたお客様は削除しない");
{
  const p = CD.customerDeletePlan(db(), "c_cd_sales");
  ok(p.blockers.some((b) => /売上が紐付いている受注.*O-2026-9804/.test(b)), "施工完了の受注 (売上) があれば削除できない");
  const r = await act(u("u_cd_admin"), () => CA.deleteCustomer("c_cd_sales", form({ reasonChoice: "二重に登録", targetId: "c_cd_keep" })));
  ok(/削除できません/.test(r.err ?? "") && c("c_cd_sales") && db().orders.find((o) => o.id === "o_cd_s").customerId === "c_cd_sales", "管理者でも断り、受注も動かさない");
  ok(CD.customerDeletePlan(db(), "c_cd_inv").blockers.some((b) => /請求書.*INV-2026-9805/.test(b)), "発行済みの請求書があれば削除できない");
}

section("3. 二重登録: 記録を残すほうのお客様に移して削除");
{
  const p = CD.customerDeletePlan(db(), "c_cd_dup");
  eq(p.blockers, [], "売上の前の受注は削除を止めない");
  ok(p.total >= 6 && p.records.some((r) => r.key === "inquiries") && p.records.some((r) => r.key === "schedule"), "移す記録の一覧 (問い合わせ・見積・受注・予定・資料・やりとり)");
  const r0 = await act(u("u_cd_mgr"), () => CA.deleteCustomer("c_cd_dup", form({ reasonChoice: "二重に登録" })));
  ok(/残すほうのお客様/.test(r0.err ?? "") && c("c_cd_dup"), "記録があるのに統合先がなければ断る");
  const r1 = await act(u("u_cd_mgr"), () => CA.deleteCustomer("c_cd_dup", form({ reasonChoice: "二重に登録", targetId: "c_cd_dup" })));
  ok(/別のお客様/.test(r1.err ?? ""), "自分自身には統合しない");
  const r = await act(u("u_cd_mgr"), () => CA.deleteCustomer("c_cd_dup", form({ reasonChoice: "二重に登録", reason: "C-99802 と同じ", targetId: "c_cd_keep" })));
  ok(!c("c_cd_dup"), "消すほうのお客様を削除した");
  ok(r.path === "/customers/c_cd_keep" && /記録 \d+ 件/.test(r.msg ?? ""), "残したお客様の画面へ戻り、移した件数を知らせる");
  const d = db();
  eq(
    [d.inquiries.find((x) => x.id === "inq_cd_1").customerId, d.quotes.find((x) => x.id === "q_cd_1").customerId, d.orders.find((x) => x.id === "o_cd_1").customerId, d.schedule.find((x) => x.id === "ev_cd_1").customerId, d.commLogs.find((x) => x.id === "cl_cd_1").customerId],
    ["c_cd_keep", "c_cd_keep", "c_cd_keep", "c_cd_keep", "c_cd_keep"],
    "問い合わせ・見積・受注・予定・やりとりを残すお客様に移す",
  );
  const att = d.attachments.find((x) => x.id === "att_cd_1");
  eq([att.parentId, att.customerId], ["c_cd_keep", "c_cd_keep"], "お客様の資料・写真も移す");
  const cn = d.changeNotices.find((x) => x.id === "cn_cd_1");
  eq([cn.targetId, cn.href], ["c_cd_keep", "/customers/c_cd_keep"], "変更のお知らせのリンクも残すお客様へ");
  ok(!d.mapLocationRefs.some((x) => x.recordId === "c_cd_dup"), "消したお客様の住所の場所の結び付けは外す");
  const left = [];
  for (const [k, rows] of Object.entries(d)) if (Array.isArray(rows) && !["auditLogs", "approvals"].includes(k)) for (const x of rows) if (JSON.stringify(x).includes('"c_cd_dup"')) left.push(k);
  eq(left, [], "消したお客様の ID が残っている表がない");
  const keep = c("c_cd_keep");
  eq((keep.contacts ?? []).map((x) => x.phone), ["090-1234-5678", "080-9999-0000"], "電話番号 (残すお客様にない番号だけ) を「ほかの電話番号」に足す");
  eq(keep.tags, ["リピート", "紹介"], "タグを足す (予定表から登録の印は足さない)");
  ok(keep.notes.includes("犬がいます") && keep.notes.includes("午前中の連絡がよい"), "メモも足す");
  eq([keep.name, keep.phone, keep.address], ["架空 花子", "096-111-2222", "熊本県合志市架空1-2-3"], "お名前・電話・住所は残すお客様のまま");
  eq(d.approvals.find((x) => x.id === "ap_cd_view").status, "cancelled", "消したお客様の閲覧の申請は取り下げ");
  eq(CD.deletedCustomerOf(d, "c_cd_dup")?.mergedInto, "c_cd_keep", "消したお客様の画面のリンクは残したお客様へ");
  ok(d.auditLogs.some((l) => l.entityId === "c_cd_keep" && /統合/.test(l.summary) && l.changes?.some((x) => x.field === "mergedFrom")), "残したお客様の変更履歴にも統合を残す");
}

section("4. 店舗スタッフ: 所属店舗の店長の承認で削除");
{
  ok(!P.canDeleteCustomerDirect(u("u_cd_staff"), S) && P.canRequestCustomerDelete(u("u_cd_staff"), S), "店舗スタッフは申請");
  const r0 = await act(u("u_cd_other"), () => CA.deleteCustomer("c_cd_dup2", form({ reasonChoice: "二重に登録", targetId: "c_cd_keep2" })));
  ok(/権限/.test(r0.err ?? ""), "ほかの店舗のスタッフは削除も申請もできない");
  const r = await act(u("u_cd_staff"), () => CA.deleteCustomer("c_cd_dup2", form({ reasonChoice: "二重に登録", targetId: "c_cd_keep2" })));
  const a = db().approvals.find((x) => x.type === "customer_delete" && x.targetId === "c_cd_dup2");
  eq([Boolean(c("c_cd_dup2")), a?.status, a?.requiredRole, CD.approvalMergeTarget(a)], [true, "pending", "store_manager", "c_cd_keep2"], "申請: まだ削除しない・店長の承認待ち・統合先を残す");
  ok(/店長へ申請/.test(r.msg ?? "") && r.path === "/customers/c_cd_dup2", "申請したことを知らせる");
  const dup = await act(u("u_cd_staff"), () => CA.deleteCustomer("c_cd_dup2", form({ reasonChoice: "二重に登録", targetId: "c_cd_keep2" })));
  ok(/すでに削除を申請/.test(dup.err ?? ""), "申請中は二重に申請しない");
  const other = await act(u("u_cd_mgr"), () => CA.deleteCustomer("c_cd_keep2", form({ reasonChoice: "二重に登録", targetId: "c_cd_dup2" })));
  ok(/削除の申請が出ています/.test(other.err ?? "") && c("c_cd_keep2"), "削除を申請中のお客様には統合しない");
  eq([P.canApprove(u("u_cd_mgr"), a), P.canApprove(u("u_cd_staff"), a)], [true, false], "承認できるのは店長 (申請した本人は不可)");
  await store.mutate((x) => {
    const ap = x.approvals.find((y) => y.id === a.id);
    ap.status = "approved";
    ap.decidedBy = "u_cd_mgr";
    ap.decidedAt = now;
    AP.applyDecision(x, ap, "approved", "u_cd_mgr", "", "/approvals");
  });
  ok(!c("c_cd_dup2") && db().inquiries.find((x) => x.id === "inq_cd_2").customerId === "c_cd_keep2", "承認で記録を移して削除");
  eq(db().approvals.find((x) => x.id === a.id).status, "approved", "承認した申請は承認済みのまま (取り下げにしない)");
  ok(db().auditLogs.some((l) => l.entityId === "c_cd_dup2" && l.action === "delete" && l.userId === "u_cd_mgr" && /申請/.test(l.summary)), "変更履歴: 承認した人・申請した人");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true });
