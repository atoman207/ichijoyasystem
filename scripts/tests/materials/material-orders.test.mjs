// 実行: npm run test:materials (または node scripts/tests/materials/material-orders.test.mjs)
// 材料発注 (お客様のご要望 2026-11-27「■4〜■6」): 襖紙の必要枚数・受注から自動で出す材料・一覧の行・「発注済み」(発注者)・手入力・権限
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-materials-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "materials-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-materials",
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
      return { msg: u.searchParams.get("msg"), err: u.searchParams.get("err") };
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
const P = await imp("lib/material-orders/plan.ts");
const A = await imp("lib/actions/material-orders.ts");
const PERM = await imp("lib/auth/permissions.ts");
const db = () => store.getDb();
const today = "2031-06-10";

section("襖紙の必要枚数 (片面 1・両面 2・品番が 2 つなら各 1・中サイズ 2 枚で 1・小サイズ 3 枚で 1)");
{
  const f = (t, q, u = "枚") => P.fusumaPaper(t, q, u);
  eq([f("襖 片面 のぞみ177", 4).codes, f("襖 片面 のぞみ177", 4).sheets], [["のぞみ177"], 4], "片面 4 枚 → 紙 4 枚");
  eq(f("襖 両面 みやこ317", 4).sheets, 8, "両面 4 枚 → 紙 8 枚");
  eq([f("襖貼替え みやこ 310／306 両面", 4).codes, f("襖貼替え みやこ 310／306 両面", 4).sheets], [["みやこ310", "みやこ306"], 4], "裏表で違う紙 (310／306) → それぞれ 4 枚");
  eq(f("襖 のぞみ177+しずか381 両面", 3).codes, ["のぞみ177", "しずか381"], "「のぞみ177+しずか381」も 2 つの品番");
  eq(f("フスマ 中ウラ開 のぞみ160", 3).sheets, 2, "中サイズ 3 枚 → 紙 2 枚 (切り上げ)");
  eq(f("襖 天ウラ 326", 4).sheets, 2, "小サイズ (天ウラ) 4 枚 → 紙 2 枚");
  eq(f("襖 天袋 両面 のぞみ175", 3).sheets, 2, "小サイズの両面 3 枚 → 紙 2 枚 (倍)");
  eq(f("襖 仏一式 あかつき689", 1, "式").sheets, undefined, "仏間一式 (式) は枚数を計算しない");
  eq(f("襖 片ウラ 301/306", 2).codes, ["301", "306"], "品番の名前がない数字");
  eq(f("襖 TS-228", 1).codes, ["TS-228"], "英字の品番");
  ok(f("襖 板戸両面開き のぞみ186/在庫クロス", 1).stock && f("襖 板戸両面開き のぞみ186/在庫クロス", 1).sheets === 1, "在庫の記載 (両面の片方が在庫のクロス → 紙は 1 枚)");
  eq(P.autoMaterials({ id: "o_x" }, { items: [{ id: "a", name: "板戸ベニア交換", qty: 1, unit: "枚" }, { id: "b", name: "襖", spec: "引手回り加工代", qty: 2, unit: "枚" }] }).length, 0, "ベニアの交換・加工は襖紙にしない");
  ok(!f("襖貼替え しずか156／ごりん52 両面中抜", 4).size.includes("mid") && f("襖貼替え しずか156／ごりん52 両面中抜", 4).size === "std", "「中抜」は中サイズではない");
}

section("受注から自動で出す材料 (襖紙・カーテン・クロス。畳・障子・網戸・引手は出さない)");
const staffK = db().users.find((u) => u.active && u.role === "store_staff");
const S = staffK.storeId;
const otherStore = db().stores.find((s) => s.id !== S && s.kind !== "hq").id;
const staffO = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === otherStore);
const hq = db().users.find((u) => u.active && u.role === "hq_staff");
const now = new Date().toISOString();
await store.mutate((x) => {
  x.customers.push({ id: "c_mo", code: "C-99971", name: "架空 花子", kana: "", phone: "", postalCode: "", address: "熊本県テスト市テスト町1-2", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
  x.quotes.push({
    id: "q_mo",
    number: "Q-2031-9971",
    version: 1,
    customerId: "c_mo",
    storeId: S,
    title: "襖とカーテン",
    category: "fusuma",
    items: [
      { id: "l1", name: "襖", spec: "両面 のぞみ177", qty: 4, unit: "枚", unitPrice: 5000, amount: 20000 },
      { id: "l2", name: "襖", spec: "天袋ウラ貼り しずか164", qty: 2, unit: "枚", unitPrice: 3000, amount: 6000 },
      { id: "l3", name: "襖", spec: "引手 S-186", qty: 6, unit: "個", unitPrice: 300, amount: 1800 },
      { id: "l4", name: "畳 表替え", spec: "きずな", qty: 6, unit: "畳", unitPrice: 8000, amount: 48000 },
      { id: "l5", name: "オーダーカーテン", spec: "FT-1234 遮光", qty: 2, unit: "窓", unitPrice: 30000, amount: 60000 },
      { id: "l6", name: "クロス張替え", spec: "SP-2201", qty: 30, unit: "㎡", unitPrice: 1200, amount: 36000 },
      { id: "l7", name: "解体・下地工事", qty: 1, unit: "式", unitPrice: 50000, amount: 50000 },
    ],
    subtotal: 221800,
    discount: 0,
    tax: 0,
    total: 221800,
    taxIncluded: true,
    status: "accepted",
    createdBy: staffK.id,
    createdAt: now,
    updatedAt: now,
    orderId: "o_mo",
  });
  x.orders.push({ id: "o_mo", number: "O-2031-9971", quoteId: "q_mo", customerId: "c_mo", storeId: S, title: "襖とカーテン", category: "fusuma", contractDate: today, total: 221800, status: "scheduled", workerIds: [], siteAddress: "", progressNotes: [], createdBy: staffK.id, createdAt: now, updatedAt: now });
  x.schedule.push({ id: "ev_mo_p", title: "引取", kind: "pickup", date: "2031-06-11", storeId: S, assigneeIds: [], orderId: "o_mo", customerId: "c_mo", source: "manual", createdBy: staffK.id, createdAt: now, updatedAt: now });
  x.schedule.push({ id: "ev_mo_d", title: "納品", kind: "delivery", date: "2031-06-12", storeId: S, assigneeIds: [], orderId: "o_mo", customerId: "c_mo", source: "manual", createdBy: staffK.id, createdAt: now, updatedAt: now });
  x.materialOrders = [];
});
{
  const autos = P.autoMaterials({ id: "o_mo" }, db().quotes.find((q) => q.id === "q_mo"));
  eq(autos.map((a) => [a.category, a.code ?? "", a.qtyAuto]), [["fusuma", "のぞみ177", 8], ["fusuma", "しずか164", 1], ["curtain", "FT-1234", 2], ["cloth", "SP-2201", 30]], "襖紙 (両面 4 → 8 枚・天袋 2 → 1 枚)・カーテン・クロス。引手・畳・工事の行は出さない");
  const rows = P.materialRows(db(), today, { storeId: S }).filter((r) => r.orderId === "o_mo");
  eq(rows.length, 4, "一覧に 4 件 (未発注)");
  eq([rows[0].pickup, rows[0].delivery, rows[0].customerName, rows[0].orderNumber], ["2031-06-11", "2031-06-12", "架空 花子", "O-2031-9971"], "引取日・納品日・お客様・受注番号");
  ok(rows.every((r) => r.status === "unordered" && r.urgent), "納品が 3 日以内の未発注は「急ぎ」");
  eq(P.reformLines(db().quotes.find((q) => q.id === "q_mo")).map((l) => l.id), ["l7"], "見積の明細から手配に足せる行 (リフォーム・工事)");
}

section("「発注済み」(押した人が発注者)・状況・数量・権限");
{
  const key = "auto:o_mo:l1:0";
  const r1 = await act(staffK, () => A.setMaterialStatus(form({ key, status: "ordered", returnTo: "/material-orders" })));
  ok(/発注済み/.test(r1.msg ?? ""), `発注済みにした (${r1.msg ?? r1.err})`);
  const rec = db().materialOrders.find((m) => m.key === key);
  eq([rec?.status, rec?.orderedBy, Boolean(rec?.orderedAt), rec?.qtyAuto], ["ordered", staffK.id, true, 8], "発注者 = 押した人・発注日時・発注したときの必要数量");
  const r2 = await act(staffO, () => A.setMaterialStatus(form({ key: "auto:o_mo:l2:0", status: "ordered", returnTo: "/material-orders" })));
  ok(Boolean(r2.err) && !db().materialOrders.some((m) => m.key === "auto:o_mo:l2:0"), "ほかの店舗の店舗スタッフは変えられない");
  ok(PERM.canViewMaterialOrders(staffO), "見るのは全社員");
  const r3 = await act(hq, () => A.saveMaterialRow(form({ key: "auto:o_mo:l2:0", status: "stock", qty: "2", note: "在庫あり", returnTo: "/material-orders" })));
  ok(!r3.err, `本部は全店舗の材料を変えられる (${r3.msg ?? r3.err})`);
  const row2 = P.materialRows(db(), today, { orderIds: ["o_mo"] }).find((r) => r.key === "auto:o_mo:l2:0");
  eq([row2?.status, row2?.qty, row2?.qtyEdited, row2?.note], ["stock", 2, true, "在庫あり"], "在庫使用・発注数量を手で変える (自動の必要数量 1 → 2)");
  // まとめて発注済み
  const r4 = await act(staffK, () => A.setMaterialStatus(form({ key: ["auto:o_mo:l5:0", "auto:o_mo:l6:0"], status: "ordered", returnTo: "/material-orders" })));
  ok(/2 件/.test(r4.msg ?? ""), "案件の未発注をまとめて発注済み");
  ok(P.materialRows(db(), today, { storeId: S }).filter((r) => r.orderId === "o_mo" && r.status === "unordered").length === 0, "未発注が 0 件");
  // 見積の数量が変わったら知らせる
  await store.mutate((x) => {
    x.quotes.find((q) => q.id === "q_mo").items[0].qty = 6;
  });
  const w = P.materialRows(db(), today, { orderIds: ["o_mo"] }).find((r) => r.key === key);
  ok(w?.warnings.some((t) => /8 → 今 12/.test(t)), `発注のあとに見積の数量が変わったら知らせる (${w?.warnings.join(" / ")})`);
}

section("手で足す (在庫補充・リフォームの手配)・削除");
{
  const r1 = await act(staffK, () => A.addMaterialRow(form({ storeId: S, category: "tatami", name: "畳表 きずな", qty: "20", unit: "枚", returnTo: "/material-orders" })));
  ok(/登録/.test(r1.msg ?? ""), "案件なしの材料 (在庫補充) を足す");
  const loose = db().materialOrders.find((m) => m.name === "畳表 きずな");
  eq([loose?.orderId, loose?.status, loose?.source], [undefined, "unordered", "manual"], "案件なし・未発注・手入力");
  ok(P.materialRows(db(), today, { storeId: S }).some((r) => r.key === `mo:${loose.id}`), "一覧に出る");
  const r2 = await act(staffK, () => A.addMaterialsFromQuote(form({ orderId: "o_mo", lineId: ["l7"], returnTo: "/orders/o_mo" })));
  ok(/1 件/.test(r2.msg ?? ""), "見積の明細からリフォームの手配を足す");
  ok(P.materialRows(db(), today, { orderIds: ["o_mo"] }).some((r) => r.category === "reform" && r.name === "解体・下地工事"), "案件の材料にリフォームの手配");
  const r3 = await act(staffK, () => A.deleteMaterialRow(form({ key: "auto:o_mo:l1:0", returnTo: "/material-orders" })));
  ok(Boolean(r3.err), "見積から自動で出した材料は消せない (発注不要にする)");
  const r4 = await act(staffK, () => A.deleteMaterialRow(form({ key: `mo:${loose.id}`, returnTo: "/material-orders" })));
  ok(!r4.err && !db().materialOrders.some((m) => m.id === loose.id), "手で足した材料は消せる");
}

section("完了した受注 (自動の行は出さない・発注済みの記録は案件の画面に残る)");
{
  await store.mutate((x) => {
    x.orders.find((o) => o.id === "o_mo").status = "completed";
  });
  ok(!P.materialRows(db(), today, { storeId: S }).some((r) => r.orderId === "o_mo" && r.source === "auto"), "一覧には出さない");
  ok(P.materialRows(db(), today, { orderIds: ["o_mo"] }).some((r) => r.status === "ordered"), "案件の画面には発注済みの記録");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
