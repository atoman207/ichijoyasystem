/**
 * お客様のご要望 2026-11-25「問い合わせを誤って登録してしまう場合の削除」のテスト
 *   node scripts/tests/schedule/inquiry-delete.test.mjs   (npm run test:schedule)
 * 店長以上は承認なしで削除・店舗スタッフは所属店舗の店長の承認・記録は残す (誰が・いつ・理由)・通常の一覧・集計に出さない・
 * 見積・受注のある問い合わせは削除できない・その問い合わせだけの予定もあわせて削除・管理者は元に戻せる (src/lib/inquiry-delete.ts)
 * データは一時フォルダーの JSON (サンプルデータ)。名前は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-inquiry-delete-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
// PDF のフォントは作業フォルダーの src/assets/fonts から読む
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.symlinkSync(path.join(root, "src/assets"), path.join(work, "src/assets"));
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "inquiry-delete-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-inquiry-delete",
  CRON_SECRET: "test-cron-inquiry-delete",
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
await store.mutate((x) => {
  // 店長は店舗にひとり (承認先が決まるように、サンプルデータの店長は外す)
  for (const u of x.users) if (u.storeId === S && u.role === "store_manager") u.active = false;
  const mk = (id, role, storeId) => x.users.push({ id, name: `試験 ${id}`, email: `${id}@example.test`, role, title: role, storeId, active: true, createdAt: now, updatedAt: now });
  mk("u_del_admin", "admin", S);
  mk("u_del_mgr", "store_manager", S);
  mk("u_del_staff", "store_staff", S);
  mk("u_del_other", "store_staff", S2);
  x.customers.push({ id: "c_del", code: "C-99901", name: "架空 太郎", kana: "", phone: "", postalCode: "", address: "", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
  const inq = (id, extra = {}) => x.inquiries.push({ id, number: `INQ-2026-${id.slice(-3)}`, customerId: "c_del", storeId: S, channel: "phone", category: "tatami", summary: `誤登録 ${id}`, detail: "", status: "new", receivedAt: now, createdBy: "u_del_staff", createdAt: now, updatedAt: now, media: "repeat", ...extra });
  inq("inq_del_a");
  inq("inq_del_b");
  inq("inq_del_q", { status: "quoted", quoteId: "q_del_q" });
  x.quotes.push({ id: "q_del_q", number: "Q-2026-9991", version: 1, customerId: "c_del", inquiryId: "inq_del_q", storeId: S, title: "見積", category: "tatami", items: [], subtotal: 1, discount: 0, tax: 0, total: 1, status: "approved", createdBy: "u_del_staff", createdAt: now, updatedAt: now });
  x.schedule.push({ id: "ev_del_a", title: "見積", kind: "survey", date: today, storeId: S, assigneeIds: ["u_del_staff"], inquiryId: "inq_del_a", customerId: "c_del", source: "manual", createdBy: "u_del_staff", createdAt: now, updatedAt: now });
});
const u = (id) => db().users.find((x) => x.id === id);
const IA = await imp("lib/actions/inquiries.ts");
const ID = await imp("lib/inquiry-delete.ts");
const AP = await imp("lib/approval-decide.ts");
const Q = await imp("lib/db/queries.ts");
const MODEL = await imp("lib/datastore/model.ts");
const inq = (id) => db().inquiries.find((x) => x.id === id);

section("1. 店長: 承認なしで削除 (記録は残す)");
{
  const r0 = await act(u("u_del_mgr"), () => IA.deleteInquiry("inq_del_a", form({ returnTo: "/inquiries" })));
  ok(/理由/.test(r0.err ?? ""), "理由がないと削除しない");
  const r = await act(u("u_del_mgr"), () => IA.deleteInquiry("inq_del_a", form({ reasonChoice: "誤って登録", reason: "", returnTo: "/inquiries" })));
  const i = inq("inq_del_a");
  eq([Boolean(i), i.status, i.deleted?.by, i.deleted?.reason, i.deleted?.prevStatus, i.deleted?.events], [true, "closed", "u_del_mgr", "誤って登録", "new", 1], "削除: 記録は残し (状態は完了)、誰が・理由・削除の前の状態・予定の件数を残す");
  ok(!db().schedule.some((e) => e.id === "ev_del_a"), "この問い合わせだけの予定もあわせて削除");
  ok(/削除しました/.test(r.msg ?? "") && r.path === "/inquiries", "一覧に戻り、削除したことを知らせる");
  ok(db().auditLogs.some((l) => l.entity === "inquiry" && l.entityId === "inq_del_a" && l.action === "delete" && l.userId === "u_del_mgr"), "変更履歴: 誰が・いつ・どの問い合わせを削除したか");
  eq([ID.isLiveInquiry(i), Q.customerTimeline(db(), "c_del").inquiries.some((x) => x.id === "inq_del_a")], [false, false], "通常の一覧・お客様の案件に出さない");
  const r2 = await act(u("u_del_mgr"), () => IA.deleteInquiry("inq_del_a", form({ reasonChoice: "誤って登録" })));
  ok(/すでに削除/.test(r2.err ?? ""), "二重には削除しない");
}

section("2. 見積・受注のある問い合わせは削除できない");
{
  const r = await act(u("u_del_admin"), () => IA.deleteInquiry("inq_del_q", form({ reasonChoice: "誤って登録" })));
  ok(/見積 \(Q-2026-9991\) のある問い合わせは削除できません/.test(r.err ?? ""), "見積のある問い合わせは断る");
  eq(inq("inq_del_q").deleted, undefined, "削除していない");
}

section("3. 店舗スタッフ: 所属店舗の店長の承認で削除");
{
  const r0 = await act(u("u_del_other"), () => IA.deleteInquiry("inq_del_b", form({ reasonChoice: "二重に登録" })));
  ok(/権限/.test(r0.err ?? ""), "ほかの店舗のスタッフは削除も申請もできない");
  const r = await act(u("u_del_staff"), () => IA.deleteInquiry("inq_del_b", form({ reasonChoice: "二重に登録", reason: "INQ-2026-xxx と同じ" })));
  const a = db().approvals.find((x) => x.type === "inquiry_delete" && x.targetId === "inq_del_b");
  eq([inq("inq_del_b").deleted, a?.status, a?.requiredRole, a?.storeId], [undefined, "pending", "store_manager", S], "申請: まだ削除しない・所属店舗の店長の承認待ち");
  ok(/店長へ申請/.test(r.msg ?? ""), "申請したことを知らせる");
  const dup = await act(u("u_del_staff"), () => IA.deleteInquiry("inq_del_b", form({ reasonChoice: "二重に登録" })));
  ok(/すでに削除を申請/.test(dup.err ?? ""), "申請中は二重に申請しない");
  const P = await imp("lib/auth/permissions.ts");
  eq([P.canApprove(u("u_del_mgr"), a), P.canApprove(u("u_del_staff"), a)], [true, false], "承認できるのは店長 (申請した本人は不可)");
  await store.mutate((x) => {
    const ap = x.approvals.find((y) => y.id === a.id);
    ap.status = "approved";
    ap.decidedBy = "u_del_mgr";
    ap.decidedAt = now;
    AP.applyDecision(x, ap, "approved", "u_del_mgr", "");
  });
  const i = inq("inq_del_b");
  eq([i.deleted?.by, i.deleted?.approvedBy, i.deleted?.reason, i.status], ["u_del_staff", "u_del_mgr", "二重に登録 / INQ-2026-xxx と同じ", "closed"], "承認で削除 (削除した人 = 申請した人、承認した人も残す)");
  ok(db().auditLogs.some((l) => l.entityId === "inq_del_b" && l.action === "delete" && l.userId === "u_del_mgr"), "変更履歴に承認して削除した記録");
  ok(/田|試験|さんが削除/.test(ID.deletedLabel(i, (id) => db().users.find((x) => x.id === id)?.name ?? "-")), "削除の表示 (日時・削除した人・承認した人・理由)");
}

section("4. 管理者は元に戻せる");
{
  const r0 = await act(u("u_del_mgr"), () => IA.restoreDeletedInquiry("inq_del_a"));
  ok(/管理者/.test(r0.err ?? ""), "店長は元に戻せない");
  await act(u("u_del_admin"), () => IA.restoreDeletedInquiry("inq_del_a"));
  eq([inq("inq_del_a").deleted, inq("inq_del_a").status], [undefined, "new"], "元に戻す: 削除の前の状態に戻る");
}

section("5. AI の SQL でも削除済みを外す");
{
  const adminScope = MODEL.scopeStatements(u("u_del_admin")).join("\n");
  const staffScope = MODEL.scopeStatements(u("u_del_staff")).join("\n");
  ok(adminScope.includes("create temp view inquiries as select * from main.inquiries where deleted is null"), "全店舗を見られる人も削除済みの問い合わせを外す");
  ok(/view inquiries as select \* from main\.inquiries where deleted is null/.test(staffScope), "店舗のロールも削除済みを外す (閲覧の範囲どおり)");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true });
