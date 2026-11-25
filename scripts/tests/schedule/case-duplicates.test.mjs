/**
 * お客様のご連絡 2026-11-26「問い合わせから顧客・日程を登録すると、予定表に二重に表示される」のテスト
 *   node scripts/tests/schedule/case-duplicates.test.mjs   (npm run test:schedule)
 * 同じ案件・同じ日・同じ種類のまとまりの予定があるときは、「既存の予定をこの内容に直す」か「別の予定として追加する」を選ぶまで登録しない
 * (src/lib/case-duplicates.ts・actions/schedule.ts の createScheduleEvent・checkScheduleConflicts、問合せ登録のメモの日程の登録)。
 * データは一時フォルダーの JSON (サンプルデータ)。名前は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-case-dup-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
// PDF のフォントは作業フォルダーの src/assets/fonts から読む
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.symlinkSync(path.join(root, "src/assets"), path.join(work, "src/assets"));
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "case-dup-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-case-dup",
  CRON_SECRET: "test-cron-case-dup",
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
const day = "2030-01-15";
await store.mutate((x) => {
  x.users.push({ id: "u_dup_mgr", name: "試験 店長", email: "u_dup_mgr@example.test", role: "store_manager", title: "店長", storeId: S, active: true, createdAt: now, updatedAt: now });
  x.users.push({ id: "u_dup_staff", name: "試験 太郎", email: "u_dup_staff@example.test", role: "store_staff", title: "施工", storeId: S, active: true, createdAt: now, updatedAt: now });
  x.customers.push({ id: "c_dup", code: "C-99911", name: "架空 花子", kana: "", phone: "", postalCode: "", address: "熊本県テスト市テスト町1", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
  x.inquiries.push({ id: "inq_dup", number: "INQ-2026-9911", customerId: "c_dup", storeId: S, channel: "phone", category: "tatami", summary: "現場見積", detail: "", status: "in_progress", receivedAt: now, createdBy: "u_dup_staff", createdAt: now, updatedAt: now, media: "repeat" });
  // 問合せ登録のメモの日程から自動で入った予定 (終日)
  x.schedule.push({ id: "ev_dup_memo", title: "架空 現見", kind: "onsite_quote", date: day, storeId: S, assigneeIds: ["u_dup_staff"], inquiryId: "inq_dup", customerId: "c_dup", memo: "メモの日程: 1/15 現場見積", source: "manual", createdBy: "u_dup_staff", createdAt: now, updatedAt: now });
});
const u = (id) => db().users.find((x) => x.id === id);
const CD = await imp("lib/case-duplicates.ts");
const SA = await imp("lib/actions/schedule.ts");
const base = { caseRef: "inquiry:inq_dup", kind: "onsite_quote", date: day, startTime: "10:00", endTime: "12:00", assigneeIds: ["u_dup_staff", "u_dup_mgr"], assigneesSent: "1", storeId: S, title: "現見", returnTo: "/inquiries/inq_dup", back: "/inquiries/inq_dup", locationMode: "follow" };
const count = () => db().schedule.filter((e) => e.inquiryId === "inq_dup" && e.date === day).length;

section("1. 同じ案件・同じ日の予定を見つける");
{
  eq(CD.sameCaseSameDay(db(), { date: day, kind: "survey", inquiryId: "inq_dup" }).map((e) => e.id), ["ev_dup_memo"], "見積 と 現見 は同じまとまり (見積・現調・現見・採寸・訪問)");
  eq(CD.sameCaseSameDay(db(), { date: day, kind: "delivery", inquiryId: "inq_dup" }).length, 0, "納品は別の種類 (引取と納品が同じ日は二重ではない)");
  eq(CD.sameCaseSameDay(db(), { date: "2030-01-16", kind: "survey", inquiryId: "inq_dup" }).length, 0, "別の日は二重ではない");
  eq(CD.sameCaseSameDay(db(), { date: day, kind: "survey", customerId: "c_dup" }).length, 0, "案件にひも付いた予定は、案件のない予定 (お客様だけ) とは比べない");
  const rep = await act(u("u_dup_mgr"), async () => {
    globalThis.__rep = await SA.checkScheduleConflicts({ date: day, kind: "onsite_quote", caseRef: "inquiry:inq_dup", assigneeIds: ["u_dup_staff"], storeId: S });
  });
  const items = globalThis.__rep?.caseDuplicates ?? [];
  eq([rep.err ?? null, items.length, items[0]?.replaceable, /メモの日程/.test(items[0]?.note ?? "")], [null, 1, true, true], "入力の画面の確かめにも出す (問合せ登録のメモから自動で登録した予定と分かる)");
}

section("2. 選ぶまで登録しない (サーバー)");
{
  const r = await act(u("u_dup_mgr"), () => SA.createScheduleEvent(form(base)));
  ok(/同じ案件の同じ日に予定がすでにあります/.test(r.err ?? ""), "既存の予定があると、選ぶまで登録しない");
  eq(count(), 1, "予定は増えていない");
}

section("3. 既存の予定をこの内容に直す (予定は増えない)");
{
  const r = await act(u("u_dup_mgr"), () => SA.createScheduleEvent(form({ ...base, caseDuplicate: "replace:ev_dup_memo" })));
  const list = db().schedule.filter((e) => e.inquiryId === "inq_dup" && e.date === day);
  eq([list.length, list[0]?.startTime, list[0]?.assigneeIds.sort().join(",")], [1, "10:00", "u_dup_mgr,u_dup_staff"], "既存の予定を新しい日時・担当者にする (1 件のまま)");
  ok(!db().schedule.some((e) => e.id === "ev_dup_memo"), "置き換えた予定は外す");
  ok(/直しました/.test(r.msg ?? ""), "直したことを知らせる");
  ok(db().auditLogs.some((l) => l.entityId === "ev_dup_memo" && l.action === "delete" && /置き換え/.test(l.summary)), "変更履歴に置き換えを残す");
}

section("4. 別の予定として追加する");
{
  await act(u("u_dup_mgr"), () => SA.createScheduleEvent(form({ ...base, startTime: "15:00", endTime: "16:00", caseDuplicate: "add" })));
  eq(count(), 2, "別の予定として追加を選べば 2 件にできる");
}

section("5. 問合せ登録のメモの日程: 同じ案件・同じ日の予定があれば登録しない");
{
  const DB = db();
  const before = DB.schedule.length;
  const RA = await imp("lib/actions/reception.ts");
  ok(typeof RA.registerReception === "function", "受付の登録の処理がある");
  // registerAppointments は内部の関数のため、同じ判定 (sameCaseSameDay) を直接確かめる
  eq(CD.sameCaseSameDay(DB, { date: day, kind: "onsite_quote", inquiryId: "inq_dup", customerId: "c_dup" }).length > 0, true, "メモの日程と同じ日の予定があれば、メモの日程からは登録しない");
  eq(DB.schedule.length, before, "確かめるだけでは予定を増やさない");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true });
