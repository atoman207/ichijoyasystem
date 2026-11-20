#!/usr/bin/env node
/**
 * 予定表スプレッド (お客様の .xlsx) から、予定の計画の設定・作業の内容・製造の予定を登録する
 *
 *   node scripts/ops/import-schedule-plan.mjs --plan "<予定表 2026.11.xlsx>" --plan "<2026.12.xlsx>" --vehicles "<車両点検表.xlsx>"          (試し: 何も書かない)
 *   node scripts/ops/import-schedule-plan.mjs ... --apply                                                                              (書き込む)
 *
 * 登録するもの (資料に書かれている値だけ。書かれていない値は今の設定のまま):
 * - 店舗の 1 日の上限 (畳・襖換算) = 人数 × 11 (「スプレッド入力ルール」と「係数・電話当番」の店舗人数)、始業・終業 8:00〜17:00 (求人票)
 * - 作業種別: 畳は当日仕上げ (製造日数 0・引き取りの当日に製造)、襖・障子・網戸 2 日 (チラシの「二日後」「2 泊 3 日」)、
 *   表替えの製造 15 分/枚 (「縁ありを 1 時間あたり 4 枚」)
 * - 製造の工程: 合志工場の畳の製造 1 日 70 枚 (「上限７０」) = 1,050 分 (縁あり 15 分/枚)。全店舗の畳を受け持つ
 * - 車両 (車両点検表の「車両情報」): 軽トラック (キャリィ・ハイゼット) = truck、乗用車 = car。工場の車両は合志店
 * - 作業の内容 (job_specs): 今日以降の取り込んだ予定 (引き取り・納品) のメモの枚数「畳 表替え6・新調2 / 襖 張替4 …」
 * - 製造の予定 (production_jobs): 今日以降の日別シートの製造の欄 (現場名・新/表・枚数・表・ヘリ・サイズ・床)。
 *   縁なし (ヘリ「無し」) は 20 分/枚 (「縁なしを 1 時間あたり 3 枚」)。現場名で引き取り・納品の予定と案件にひも付ける
 * 書き込みはアプリと同じ store.ts の mutate (変更の記録 app_changes で他のインスタンスも取り込む)。変更履歴の利用者は「system」。
 * 同じ内容を 2 回登録しない (作業の内容は予定ごと、製造の予定は シート・行 の ID で置き換え)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { loadEnv } from "../import/env.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const HISTORY = args.includes("--history");
const planDir = args.includes("--plan-dir") ? args[args.indexOf("--plan-dir") + 1] : undefined;
const monthOf = (file) => {
  const b = path.basename(file).normalize("NFKC");
  const m = b.match(/(20\d\d)\.(\d{1,2})/) ?? b.match(/(20\d\d)年(\d{1,2})月/);
  return m ? { y: m[1], m: String(Number(m[2])).padStart(2, "0") } : null;
};
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.xlsx$/i.test(e.name) ? [path.join(d, e.name)] : []));
const plans = [...args.flatMap((a, i) => (a === "--plan" ? [args[i + 1]] : [])), ...(planDir ? walk(planDir).filter((f) => monthOf(f) && !/原紙/.test(f)) : [])];
const vehiclesFile = args[args.indexOf("--vehicles") + 1];
if (!plans.length || !vehiclesFile) {
  console.error("使い方: --plan <予定表.xlsx> [--plan …] --vehicles <車両点検表.xlsx> [--apply]");
  process.exit(2);
}

loadEnv();
process.env.DB_SNAPSHOT = "off"; // 本番の控え (/srv/ichijoya/data/cache) に書かない
process.env.ICHIJOYA_DATA_DB = "off"; // VPS の写しに書かない (アプリが変更の記録から取り込む)
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") } });
const imp = (p) => jiti.import(path.join(root, "src", p));
const XLSX = createRequire(import.meta.url)("xlsx");

const store = await imp("lib/db/store.ts");
const M = await imp("lib/scheduling/masters.ts");
const CAP = await imp("lib/schedule-capacity.ts");
const SYSTEM = "system";
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const nk = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
const num = (v) => (typeof v === "number" ? v : Number(String(v ?? "").normalize("NFKC").replace(/[^\d.]/g, "")) || 0);
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const STORE = { 合志店: "koshi", 中央店: "chuo", 西店: "nishi", 玉名店: "tamana" };

console.log(`[plan] ${APPLY ? "書き込み" : "試し (書き込まない)"} / 今日 ${today} / バックエンド ${store.BACKEND}`);
const db = await store.syncDb();
console.log(`[plan] 読み込み: 予定 ${db.schedule.length} 件・受注 ${db.orders.length} 件`);

/* ---------------- 1. 設定 ---------------- */
const settingsOut = [];
const setValue = (id, value) => settingsOut.push({ id, value });
// 1 日の上限 (店舗人数 × 11) と始業・終業
const newest = [...plans].sort((a, b) => `${monthOf(a).y}${monthOf(a).m}`.localeCompare(`${monthOf(b).y}${monthOf(b).m}`)).at(-1);
const capBook = XLSX.readFile(newest, { sheets: ["係数・電話当番"] });
const capRows = XLSX.utils.sheet_to_json(capBook.Sheets["係数・電話当番"], { header: 1, defval: "" });
const people = {};
capRows[0].forEach((h, i) => {
  const id = { 合志: "koshi", 中央: "chuo", 西: "nishi", 玉名: "tamana" }[nk(h)];
  if (id && num(capRows[1][i]) > 0) people[id] = num(capRows[1][i]);
});
const capOld = (db.settings.find((s) => s.id === CAP.SCHEDULE_CAPACITY_ID)?.value ?? {});
const capStores = { ...(capOld.stores ?? {}) };
for (const [id, n] of Object.entries(people)) capStores[id] = { ...(capStores[id] ?? {}), tatamiPerDay: n * 11 };
setValue(CAP.SCHEDULE_CAPACITY_ID, { ...capOld, stores: capStores, workStart: "08:00", workEnd: "17:00" });
// 作業種別 (今の設定 or 初期値を土台に、資料にある値だけ変える)
const wts = M.readWorkTypes(db).map((w) => ({ ...w }));
for (const w of wts) {
  if (w.category === "tatami") w.leadDays = 0;
  if (["fusuma", "shoji", "amido"].includes(w.id)) w.leadDays = 2;
  if (w.id === "tatami_omote") w.processes = w.processes.map((p) => (p.processKey === "tatami" ? { ...p, minutesPerUnit: 15 } : p));
}
setValue(M.MASTER_IDS.workTypes, { items: wts });
setValue(M.MASTER_IDS.rules, { ...(db.settings.find((s) => s.id === M.MASTER_IDS.rules)?.value ?? {}), productionStartsNextDay: false });
// 製造の工程 (合志工場の畳)
const procOld = M.readProcesses(db).filter((p) => p.id !== "proc_koshi_tatami");
const factory = { id: "proc_koshi_tatami", key: "tatami", name: "合志工場 畳の製造", storeId: "koshi", servesStores: ["koshi", "chuo", "nishi", "tamana"], minutesPerDay: 70 * 15, workdays: [], staffIds: [], provisional: false, active: true };
setValue(M.MASTER_IDS.processes, { items: [...procOld, factory] });
// 車両
const vb = XLSX.readFile(vehiclesFile);
const vSheet = vb.SheetNames.find((n) => n.includes("車両情報"));
const vRows = XLSX.utils.sheet_to_json(vb.Sheets[vSheet], { header: 1, defval: "" });
const vStore = { 本部: "hq", 工場: "koshi", 合志: "koshi", 中央: "chuo", 西: "nishi", 玉名: "tamana" };
let cur = "";
const vehicles = [];
for (const r of vRows.slice(1)) {
  if (nk(r[0])) cur = nk(r[0]);
  const plate = nk(r[1]).match(/^\d{3,4}/)?.[0];
  if (!plate || !vStore[cur]) continue;
  const model = nk(r[2]) || "車両";
  vehicles.push({ id: `veh_${plate}`, name: `${model} ${plate}`, kind: "vehicle", type: /キャリ|ハイゼ|トラ/.test(model) ? "truck" : "car", storeId: vStore[cur], active: true, note: `車両点検表 (${cur})${nk(r[3]) ? `・使用者 ${nk(r[3])}` : ""}` });
}
const resOld = M.readResources(db).filter((r) => !r.id.startsWith("veh_"));
setValue(M.MASTER_IDS.resources, { items: [...resOld, ...vehicles] });

// 設定を読み直して確かめる (アプリの読み取りで同じ値になるか)
const check = { ...db, settings: [...db.settings.filter((s) => !settingsOut.some((o) => o.id === s.id)), ...settingsOut.map((o) => ({ id: o.id, value: o.value, updatedAt: new Date().toISOString() }))] };
const m2 = M.loadMasters(check);
const cap2 = CAP.readCapacitySettings(check);
const problems = [];
if (m2.workTypeById.get("tatami_omote")?.leadDays !== 0 || m2.workTypeById.get("fusuma")?.leadDays !== 2) problems.push("作業種別の製造日数");
if (!m2.processes.some((p) => p.id === factory.id && p.minutesPerDay === 1050)) problems.push("製造の工程");
if (m2.resources.filter((r) => r.id.startsWith("veh_")).length !== vehicles.length) problems.push("車両");
if (Object.entries(people).some(([id, n]) => cap2.stores[id]?.tatamiPerDay !== n * 11) || cap2.workStart !== "08:00") problems.push("1 日の上限・始業");
if (m2.rules.productionStartsNextDay !== false) problems.push("計画の基準");
if (problems.length) {
  console.error("設定を読み直すと値が合いません:", problems.join("・"));
  process.exit(1);
}
console.log(`[plan] 設定: 1 日の上限 ${Object.entries(people).map(([id, n]) => `${id} ${n}人×11=${n * 11}`).join("・")} / 始業 8:00〜17:00 / 畳 当日・襖障子網戸 2 日 / 工場 70 枚/日 / 車両 ${vehicles.length} 台 (${vehicles.map((v) => `${v.storeId}:${v.name}`).join(", ")})`);

/* ---------------- 2. 作業の内容 (今日以降の取り込んだ予定のメモの枚数) ---------------- */
const MAP = [
  [/^畳$/, { 表替え: "tatami_omote", 新調: "tatami_new" }],
  [/^襖$/, { 張替: "fusuma", 新調: "fusuma" }],
  [/^障子$/, { 張替: "shoji", 新: "shoji" }],
  [/^網戸$/, { 張替: "amido", 新: "amido" }],
];
function itemsOfMemo(memo) {
  const first = String(memo ?? "").split("\n")[0];
  const items = [];
  for (const part of first.split(" / ")) {
    const [label, rest] = part.trim().split(/\s+/, 2);
    const map = MAP.find(([re]) => re.test(label ?? ""))?.[1];
    if (!map || !rest) continue;
    for (const x of rest.split("・")) {
      const m = x.match(/^(表替え|新調|張替|新)(\d+(?:\.\d+)?)$/);
      if (m && map[m[1]]) items.push({ workTypeId: map[m[1]], qty: Number(m[2]) });
    }
  }
  const merged = new Map();
  for (const it of items) merged.set(it.workTypeId, (merged.get(it.workTypeId) ?? 0) + it.qty);
  return [...merged].map(([workTypeId, qty]) => ({ workTypeId, qty }));
}
const hasSpec = new Set((db.jobSpecs ?? []).map((s) => `${s.recordType}:${s.recordId}`));
const specs = [];
for (const e of db.schedule) {
  if (e.source !== "import" || e.date < today || !["pickup", "delivery"].includes(e.kind) || hasSpec.has(`event:${e.id}`)) continue;
  const items = itemsOfMemo(e.memo);
  if (!items.length) continue;
  specs.push({ id: `js_${hash(`event:${e.id}`)}`, recordType: "event", recordId: e.id, storeId: e.storeId, items, skills: [], resourceKinds: [], preferredDates: [], preferredWeekdays: [], avoidDates: [], preferenceStrength: "none", priority: "normal", note: "予定表 (スプレッド) の枚数から登録", updatedBy: SYSTEM, updatedAt: new Date().toISOString() });
}
console.log(`[plan] 作業の内容: ${specs.length} 件 (今日以降の引き取り・納品)`);

/* ---------------- 3. 製造の予定 (日別シートの製造の欄) ---------------- */
const byTitle = db.schedule.filter((e) => e.kind === "pickup" || e.kind === "delivery");
const jobs = [];
const unmatched = [];
const seenJobs = new Set();
const skippedLarge = [];
for (const file of plans) {
  const mo = monthOf(file);
  if (!mo) continue;
  const book = XLSX.readFile(file);
  for (const sn of book.SheetNames) {
    if (!/^\d{1,2}$/.test(sn.trim())) continue;
    const date = `${mo.y}-${mo.m}-${String(sn.trim()).padStart(2, "0")}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(sn) > 31) continue;
    if (date < today && !HISTORY) continue;
    const rows = XLSX.utils.sheet_to_json(book.Sheets[sn], { header: 1, defval: "" });
    let shop;
    let col = null;
    rows.forEach((r, i) => {
      const cells = r.map(nk);
      const storeAt = cells.findIndex((c, j) => STORE[c] && (cells[j + 1] ?? "").startsWith("枚数"));
      if (storeAt >= 0) {
        shop = STORE[cells[storeAt]];
        return;
      }
      const h = cells.findIndex((c, j) => c === "現場名" && /新･表|新・表/.test(cells[j + 1] ?? ""));
      if (h >= 0) {
        col = h;
        return;
      }
      if (col === null || !shop) return;
      const name = cells[col];
      const qty = num(r[col + 2]);
      if (!name || /^(現場名|計|無し)$/.test(name) || /^(係数|合計|上限|繰り?越)/.test(name) || qty <= 0) return;
      const kindText = cells[col + 1];
      const omote = cells[col + 3];
      const heri = cells[col + 4];
      const size = cells[col + 5];
      const toko = cells[col + 6];
      const borderless = /無し|なし/.test(heri) || /古都/.test(`${omote}${heri}`);
      const workTypeId = /新/.test(kindText) ? "tatami_new" : /裏|うら/.test(kindText) ? "tatami_ura" : "tatami_omote";
      // 1 件で 150 枚を超えるのは読み違い (合計の行など) として登録しない
      if (qty > 150) {
        skippedLarge.push(`${date} ${name} ${qty}枚`);
        return;
      }
      const key = nk(name).replace(/[（(]/g, "(").replace(/[）)]/g, ")");
      const sameName = (e) => nk(e.title).replace(/[（(]/g, "(").replace(/[）)]/g, ")").startsWith(key);
      const pickup = byTitle.filter((e) => e.kind === "pickup" && e.storeId === shop && e.date <= date && e.date >= addDays(date, -45) && sameName(e)).sort((a, b) => b.date.localeCompare(a.date))[0];
      const delivery = byTitle.filter((e) => e.kind === "delivery" && e.storeId === shop && e.date >= date && e.date <= addDays(date, 30) && sameName(e)).sort((a, b) => a.date.localeCompare(b.date))[0];
      if (!pickup) unmatched.push(`${date} ${name}`);
      // 同じ月のシートが 2 つのフォルダにあっても 1 件にする (日付・店舗・現場名・種類・枚数・表・ヘリ)
      const id = `pj_${hash([date, shop, key, kindText, qty, omote, heri].join("|"))}`;
      if (seenJobs.has(id)) return;
      seenJobs.add(id);
      const done = date < today;
      const ev = pickup ?? delivery;
      jobs.push({
        id,
        storeId: "koshi",
        orderId: ev?.orderId,
        quoteId: ev?.quoteId,
        customerId: ev?.customerId,
        title: `${name} ${kindText || "表"} ${qty}枚${borderless ? " (縁なし)" : ""}`,
        items: [{ workTypeId, qty, note: [omote && `表 ${omote}`, heri && `ヘリ ${heri}`, size && `サイズ ${size}`, toko && `床 ${toko}`].filter(Boolean).join(" / ") || undefined }],
        pickupEventId: pickup?.id,
        deliveryEventId: delivery?.id,
        steps: [{ processId: "proc_koshi_tatami", date, minutes: qty * (borderless ? 20 : 15), qty, status: done ? "done" : "planned" }],
        startDate: date,
        endDate: date,
        dueDate: delivery?.date,
        status: done ? "done" : "planned",
        note: `予定表 (${path.basename(file)} の「${sn}」) の製造の欄から登録 (${Object.keys(STORE).find((k) => STORE[k] === shop)}の分)`,
        createdBy: SYSTEM,
        createdAt: new Date().toISOString(),
      });
    });
  }
}
function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
console.log(`[plan] 製造の予定: ${jobs.length} 件 (引き取りの予定にひも付いた ${jobs.length - unmatched.length} 件)・日別: ${[...new Set(jobs.map((j) => j.startDate))].sort().map((d) => `${d.slice(5)}:${jobs.filter((j) => j.startDate === d).reduce((a, j) => a + j.steps[0].qty, 0)}枚`).join(" ")}`);
{
  const byYear = {};
  for (const j of jobs) {
    const y = j.startDate.slice(0, 4);
    const o = (byYear[y] ??= { n: 0, qty: 0, kinds: {}, max: 0 });
    o.n++;
    o.qty += j.steps[0].qty;
    o.max = Math.max(o.max, j.steps[0].qty);
    const k = j.title.replace(/^.*\s(\S+)\s[\d.]+枚.*$/, "$1");
    o.kinds[k] = (o.kinds[k] ?? 0) + 1;
  }
  for (const [y, o] of Object.entries(byYear).sort()) console.log(`[plan]   ${y}: ${o.n} 件・${o.qty} 枚 (最大 ${o.max} 枚/件)・種類 ${Object.entries(o.kinds).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}:${n}`).join(" ")}`);
}
if (skippedLarge.length) console.log(`[plan] 枚数が多すぎて登録しない行: ${skippedLarge.join("、")}`);
if (unmatched.length) console.log(`[plan] 引き取りの予定が見つからない製造: ${unmatched.slice(0, 12).join("、")}${unmatched.length > 12 ? ` ほか ${unmatched.length - 12} 件` : ""}`);

/* ---------------- 4. 仮押さえ (予定表で「仮」と書かれた今日以降の予定) ---------------- */
// 件名・メモに単独の「仮」がある予定 (例: 「(石貫) 平 仮 納品」「障子 張替4 / 仮」)。「納品11/25仮」のように別の予定の日付についた「仮」は除く
const TENTATIVE = /(^|[\s/])仮($|[\s/])/;
const tentative = db.schedule.filter((e) => e.source === "import" && e.date >= today && (TENTATIVE.test(e.title) || TENTATIVE.test(String(e.memo ?? "").split("\n").join(" / "))));
const holds = tentative.map((e) => ({
  id: `hold_${hash(e.id)}`,
  groupId: `hg_${hash(e.id)}`,
  rank: 1,
  storeId: e.storeId,
  kind: e.kind,
  title: e.title.replace(/\s*仮(?=\s|$)/, "").replace(/\s{2,}/g, " ").trim(),
  date: e.date,
  endDate: e.endDate,
  startTime: e.startTime,
  endTime: e.endTime,
  slot: e.slot,
  assigneeIds: e.assigneeIds ?? [],
  resourceIds: [],
  customerId: e.customerId,
  inquiryId: e.inquiryId,
  quoteId: e.quoteId,
  orderId: e.orderId,
  location: e.location,
  memo: [e.memo, "予定表 (スプレッド) で「仮」の予定。確定したら「予定の計画 → 仮押さえ」で確定してください"].filter(Boolean).join("\n"),
  reasons: ["予定表 (スプレッド) で「仮」と書かれた予定"],
  warnings: [],
  status: "held",
  expiresAt: new Date(`${e.endDate ?? e.date}T23:59:59+09:00`).toISOString(),
  acks: [],
  createdBy: SYSTEM,
  createdAt: new Date().toISOString(),
  _eventId: e.id,
}));
console.log(`[plan] 仮押さえ: ${holds.length} 件 (${holds.map((h) => `${h.date.slice(5)} ${h.title}`).join("、")})。元の予定は仮押さえに移す (二重に数えないため)`);

/* ---------------- 5. 車両の予約 (担当者が使用者の車両) ---------------- */
const userOfVehicle = new Map();
for (const v of vehicles) {
  const who = (v.note.match(/使用者 (.+)$/) ?? [])[1];
  if (!who) continue;
  const u = db.users.filter((x) => x.active && (nk(x.name).includes(nk(who)) || nk(x.name).split(/[・]/).some((part) => part === nk(who))));
  if (u.length === 1) userOfVehicle.set(u[0].id, v);
}
const movedEventIds = new Set(holds.map((h) => h._eventId));
const bookings = [];
const addBooking = (src, key) => {
  for (const uid of src.assigneeIds ?? []) {
    const v = userOfVehicle.get(uid);
    if (!v) continue;
    bookings.push({ id: `rb_${hash(`${key}|${v.id}`)}`, resourceId: v.id, storeId: v.storeId, date: src.date, endDate: src.endDate, startTime: src.startTime, endTime: src.endTime, slot: src.startTime ? undefined : src.slot, ...(key.startsWith("hold:") ? { holdId: src.id } : { eventId: src.id }), note: `車両点検表の使用者 (${db.users.find((x) => x.id === uid)?.name ?? uid}) の車両`, createdBy: SYSTEM, createdAt: new Date().toISOString() });
  }
};
for (const e of db.schedule) if (e.date >= today && !movedEventIds.has(e.id) && ["pickup", "delivery", "install", "survey", "measure", "visit"].includes(e.kind)) addBooking(e, `event:${e.id}`);
for (const h of holds) addBooking(h, `hold:${h.id}`);
console.log(`[plan] 車両の予約: ${bookings.length} 件 (使用者がわかる車両 ${userOfVehicle.size} 台。担当者が決まっている今日以降の予定から)`);

if (!APPLY) {
  console.log("[plan] 試しのため書き込みません。--apply で登録します。");
  process.exit(0);
}

/* ---------------- 書き込み ---------------- */
await store.mutate((d) => {
  const now = new Date().toISOString();
  for (const o of settingsOut) {
    const row = d.settings.find((s) => s.id === o.id);
    const before = row ? JSON.stringify(row.value).length : 0;
    if (row) {
      row.value = o.value;
      row.updatedBy = SYSTEM;
      row.updatedAt = now;
    } else d.settings.push({ id: o.id, value: o.value, updatedBy: SYSTEM, updatedAt: now });
    store.addAudit(d, { userId: SYSTEM, action: "update", entity: "settings", entityId: o.id, entityLabel: `予定の計画の設定 (${o.id})`, summary: `お客様の資料 (予定表・求人票・チラシ・車両点検表) の値で予定の計画の設定を登録`, storeId: "hq", changes: [{ field: o.id, before: before ? "(以前の設定)" : "", after: "(資料の値)" }] });
  }
  const specIds = new Set(specs.map((s) => s.id));
  d.jobSpecs = [...(d.jobSpecs ?? []).filter((s) => !specIds.has(s.id)), ...specs];
  // このスクリプトで前に登録した製造の予定は置き換える (ID の付け方を変えても二重にならない)
  d.productionJobs = [...(d.productionJobs ?? []).filter((j) => !(j.createdBy === SYSTEM && /^予定表 \(/.test(j.note ?? ""))), ...jobs];
  // 「仮」の予定 → 仮押さえ (元の予定は消す。削除の記録は残さず「移した」と残す: 空いた枠の前倒しの提案に出さないため)
  for (const h of holds) {
    const ev = d.schedule.find((x) => x.id === h._eventId);
    if (!ev) continue;
    d.schedule = d.schedule.filter((x) => x.id !== ev.id);
    d.jobSpecs = d.jobSpecs.filter((x) => !(x.recordType === "event" && x.recordId === ev.id));
    for (const j of d.productionJobs) {
      if (j.pickupEventId === ev.id) j.pickupEventId = undefined;
      if (j.deliveryEventId === ev.id) j.deliveryEventId = undefined;
    }
    const { _eventId, ...hold } = h;
    d.scheduleHolds = [...(d.scheduleHolds ?? []).filter((x) => x.id !== hold.id), hold];
    store.addAudit(d, { userId: SYSTEM, action: "update", entity: "schedule", entityId: ev.id, entityLabel: ev.title, summary: `予定表で「仮」の予定を仮押さえに移しました (${ev.date} ${ev.title})`, storeId: ev.storeId, changes: [{ field: "status", before: "予定", after: "仮押さえ" }] });
  }
  const bookingIds = new Set(bookings.map((b) => b.id));
  d.resourceBookings = [...(d.resourceBookings ?? []).filter((b) => !bookingIds.has(b.id)), ...bookings];
  store.addAudit(d, { userId: SYSTEM, action: "import", entity: "schedule", entityId: "plan-import", entityLabel: "予定表の製造の欄・枚数", summary: `予定表 (スプレッド) から作業の内容 ${specs.length} 件・製造の予定 ${jobs.length} 件 (${HISTORY ? "過去の分を含む" : `${today} 以降`})・仮押さえ ${holds.length} 件・車両の予約 ${bookings.length} 件を登録`, storeId: "hq" });
});
console.log(`[plan] 登録しました: 設定 ${settingsOut.length} 件・作業の内容 ${specs.length} 件・製造の予定 ${jobs.length} 件・仮押さえ ${holds.length} 件・車両の予約 ${bookings.length} 件`);
process.exit(0);
