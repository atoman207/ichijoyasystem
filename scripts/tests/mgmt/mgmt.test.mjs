// 実行: npm run test:mgmt (または node scripts/tests/mgmt/mgmt.test.mjs)
// 管理会計 (店舗別独立採算・売上配分・材料原価・在庫・仕入明細の振り分け・共通経費の案分・月次確定) の計算のテスト。
// 2031 年の日付のテスト用の記録だけを使い、サンプルデータの数字に左右されないようにする。単価・金額はすべてテスト用の架空の値
import { imp, ok, eq, section, summary } from "./harness.mjs";

const store = await imp("lib/db/store.ts");
const D = await imp("lib/mgmt/decimal.ts");
const R = await imp("lib/mgmt/rules.ts");
const A = await imp("lib/mgmt/areas.ts");
const AT = await imp("lib/mgmt/attribution.ts");
const C = await imp("lib/mgmt/costing.ts");
const ST = await imp("lib/mgmt/stock.ts");
const PL = await imp("lib/mgmt/purchase-lines.ts");
const AL = await imp("lib/mgmt/allocation.ts");
const P = await imp("lib/mgmt/pnl.ts");
const CL = await imp("lib/mgmt/close.ts");
const CAT = await imp("lib/mgmt/categories.ts");

const db = store.getDb();
const admin = db.users.find((u) => u.role === "admin");
const now = new Date().toISOString();
let seq = 0;
const id = (p) => `${p}_t${++seq}`;
const num = (p) => `${p}-2031-${String(++seq).padStart(4, "0")}`;
const M = "2031-03";
const day = (d) => `${M}-${String(d).padStart(2, "0")}`;

const cust = (name, address, storeId = "koshi") => ({ id: id("cust"), code: `C-9${seq}`, name, kana: "テスト", type: "individual", phone: "", postalCode: "", address, storeId, preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
const order = (customerId, storeId, total, category = "tatami", extra = {}) => ({ id: id("o"), number: num("OR"), customerId, storeId, title: "テスト工事", category, contractDate: day(1), salesDate: day(10), total, status: "completed", workerIds: [], siteAddress: "", progressNotes: [], createdBy: admin.id, createdAt: now, updatedAt: now, ...extra });
const pnl = (from = day(1), to = day(31)) => P.storePnl(store.getDb(), from, to);
const storeOf = (res, sid) => res.stores.find((s) => s.storeId === sid);

/* ------------------------------------------------------------------ */
section("数値計算 (浮動小数点を使わない)");
eq(D.qtyTimesCost("0.1", "3"), 0, "0.1 × 3 円 = 0.3 → 四捨五入で 0 円");
eq(D.qtyTimesCost(0.5, 4720), 2360, "0.5 × 4720 = 2360");
eq(D.applyBp(100000, 2000, "floor"), 20000, "100,000 × 20% = 20,000");
eq(D.applyBp(99999, 2000, "floor"), 19999, "99,999 × 20% 切り捨て = 19,999");
eq(D.apportion(1000001, [3, 3, 4]), [300000, 300000, 400001], "按分の合計は元の金額と一致 (残りの 1 円は端数の一番大きい先)");
eq(D.apportion(10, [1, 1, 1]).reduce((a, b) => a + b, 0), 10, "10 円を 3 等分しても合計 10");
eq(D.percent1(0, 0), null, "分母 0 の原価率は計算不能 (null)");
eq(D.percent1(100, -5), null, "売上がマイナスの原価率も計算不能 (null。例外にしない)");
eq(String(D.divRound(BigInt(7), BigInt(-2), "floor")), "-4", "負の分母でも丸められる");
eq(D.exTax(110000, 10), 100000, "税込 110,000 → 税抜 100,000");

/* ------------------------------------------------------------------ */
section("Test 1: 通常の売上帰属 (営業エリアは合志店、施工は西店 → 西店の売上)");
await store.mutate((d) => {
  d.salesAreas.push({ id: id("sa"), municipality: "", town: "テスト町", storeId: "koshi", validFrom: "2000-01-01", source: "manual", createdBy: admin.id, createdAt: now });
  d.salesAreas.push({ id: id("sa"), municipality: "", town: "テスト二丁町", storeId: "chuo", validFrom: "2000-01-01", source: "manual", createdBy: admin.id, createdAt: now });
});
const c1 = cust("帰属 太郎", "熊本県合志市テスト町1-2");
const o1 = order(c1.id, "nishi", 55000, "tatami", { siteAddress: "熊本県合志市テスト町1-2" });
await store.mutate((d) => { d.customers.push(c1); d.orders.push(o1); });
{
  const d = store.getDb();
  const att = AT.attributionOf(d, d.orders.find((o) => o.id === o1.id), "tatami");
  eq(att.area.storeId, "koshi", "住所の営業エリアは合志店");
  eq(att.attributionStoreId, "nishi", "売上帰属店舗は施工した西店");
  const r = pnl();
  eq(storeOf(r, "nishi").externalSales, 50000, "西店の外部売上 (税抜) 50,000");
  eq(storeOf(r, "koshi").externalSales, 0, "合志店の外部売上は 0 (営業エリアだけでは帰属しない)");
  eq(A.matchArea(d, "熊本県合志市テスト二丁町3", "2031-03-01").storeId, "chuo", "長く一致した町名 (テスト二丁町) を優先");
  eq(A.matchArea(d, "熊本県どこか町1", "2031-03-01").status, "unmatched", "一致しない住所は判定しない (要確認)");
}

/* ------------------------------------------------------------------ */
section("Test 2: 通常工事の内部受注 (合志店 → 中央店 100,000 円)");
await store.mutate((d) => {
  // 金額を税込のままで見る (例の数字と同じ)。設定は 2031-01-01 から
  R.setRule(d, { key: "pnl.basis", value: "tax_included", validFrom: "2031-01-01", status: "confirmed" }, admin.id, id("rule"), now);
});
const c2 = cust("内部 次郎", "熊本県合志市テスト町5");
const o2 = order(c2.id, "chuo", 100000, "tatami");
let adj2;
await store.mutate((d) => {
  d.customers.push(c2);
  d.orders.push(o2);
  const calc = AT.calcInternalOrder(d, o2, "normal");
  adj2 = { id: id("adj"), number: num("SA"), kind: "internal_order", orderId: o2.id, fromStoreId: "koshi", toStoreId: "chuo", workKind: "normal", base: calc.base, baseAmount: calc.baseAmount, rateBp: calc.rateBp, rateSource: calc.rateSource, ruleIds: calc.ruleIds, rounding: calc.rounding, amount: calc.amount, provisional: calc.provisional, status: "active", createdBy: admin.id, createdAt: now };
  d.salesAdjustments.push(adj2);
});
{
  eq(adj2.amount, 20000, "配分額 20,000 円 (税込 × 20% 切り捨て)");
  const r = pnl();
  const koshi = storeOf(r, "koshi"), chuo = storeOf(r, "chuo");
  eq(chuo.externalSales, 100000, "中央店の初期計上 (外部売上) 100,000");
  eq(koshi.adjInternal, 20000, "合志店 +20,000");
  eq(chuo.adjInternal, -20000, "中央店 −20,000");
  eq(koshi.mgmtSales - koshi.externalSales, 20000, "合志店の管理売上の増分 20,000");
  eq(chuo.mgmtSales, 80000, "中央店の管理売上 80,000");
  eq(r.total.externalSales, 100000 + 55000, "全社の外部売上は増えない (内部受注を足さない)");
  eq(r.stores.reduce((a, s) => a + s.adjInternal, 0), 0, "店舗間の調整の合計は 0");
}

/* ------------------------------------------------------------------ */
section("Test 3: リフォーム工事の内部受注 (5%)");
{
  const o3 = order(c2.id, "chuo", 100000, "cloth");
  const calc = AT.calcInternalOrder(store.getDb(), o3, "reform");
  eq(calc.amount, 5000, "依頼元 5,000 円");
  eq(100000 - calc.amount, 95000, "施工店舗 95,000 円");
  ok(calc.provisional, "5% は社内資料にないため暫定として印が付く");
  const special = AT.calcInternalOrder(store.getDb(), o3, "reform", 1500);
  eq([special.amount, special.rateSource], [15000, "override"], "管理者の特例の率 (15%) も計算できる");
}

/* ------------------------------------------------------------------ */
section("Test 4: 半畳の材料原価 (主材料は係数 0.5、副資材は 1 枚 100 円)");
const mOmote = { id: "mat_omote", code: "T-OMOTE", name: "テスト畳表", kind: "omote", unit: "枚", itemCategory: "tatami", active: true, createdAt: now, updatedAt: now };
const mHeri = { id: "mat_heri", code: "T-HERI", name: "テスト縁", kind: "heri", unit: "枚分", itemCategory: "tatami", active: true, createdAt: now, updatedAt: now };
const mDoko55 = { id: "mat_doko55", code: "T-DOKO55", name: "テスト床55 五八", kind: "doko", unit: "枚", thickness: 55, size: "gohachi", itemCategory: "tatami", active: true, createdAt: now, updatedAt: now };
const mDoko60 = { id: "mat_doko60", code: "T-DOKO60", name: "テスト床60 本間", kind: "doko", unit: "枚", thickness: 60, size: "honma", itemCategory: "tatami", active: true, createdAt: now, updatedAt: now };
await store.mutate((d) => {
  d.materials.push(mOmote, mHeri, mDoko55, mDoko60);
  C.setMaterialCost(d, { materialId: mOmote.id, unitCost: 1000, kind: "provisional", validFrom: "2030-01-01" }, admin.id, id("mc"), now);
  C.setMaterialCost(d, { materialId: mHeri.id, unitCost: 200, kind: "standard", validFrom: "2030-01-01" }, admin.id, id("mc"), now);
  C.setMaterialCost(d, { materialId: mDoko55.id, unitCost: 3000, kind: "standard", validFrom: "2030-01-01" }, admin.id, id("mc"), now);
  C.setMaterialCost(d, { materialId: mDoko60.id, unitCost: 3600, kind: "standard", validFrom: "2030-01-01" }, admin.id, id("mc"), now);
  d.boms.push({ id: "bom_full", matchName: "テスト表替え", name: "テスト表替え (1 枚)", lines: [{ materialId: mOmote.id, materialKind: "omote", qty: 1 }, { materialId: mHeri.id, materialKind: "heri", qty: 1 }, { materialKind: "sub", qty: 1 }], validFrom: "2000-01-01", createdBy: admin.id, createdAt: now });
  d.boms.push({ id: "bom_half", matchName: "テスト半畳", name: "テスト半畳 (1 枚)", lines: [{ materialId: mOmote.id, materialKind: "omote", qty: 0.5 }, { materialId: mHeri.id, materialKind: "heri", qty: 0.5 }, { materialKind: "doko", qty: 0.5 }, { materialKind: "sub", qty: 1 }], validFrom: "2000-01-01", createdBy: admin.id, createdAt: now });
  d.boms.push({ id: "bom_new", matchName: "テスト新調", name: "テスト新調 (1 枚)", lines: [{ materialId: mOmote.id, materialKind: "omote", qty: 1 }, { materialKind: "doko", qty: 1 }, { materialKind: "sub", qty: 1 }], validFrom: "2000-01-01", createdBy: admin.id, createdAt: now });
});
{
  const d = store.getDb();
  const half = C.planUsage(d, [{ key: "h", label: "畳 テスト半畳", qty: 2, itemCategory: "tatami" }], day(5), { "h:2": { materialId: mDoko55.id } });
  const by = (k) => half.usages.find((u) => u.materialKind === k);
  eq(by("omote").qty, 1, "半畳 2 枚の畳表は通常の 1 枚分 (2 × 0.5)");
  eq(by("omote").amount, 1000, "畳表の原価 1,000 円 (通常 1 枚分)");
  eq(by("doko").amount, 3000, "畳床も 1 枚分 (2 × 0.5 × 3,000)");
  eq(by("sub").amount, 200, "副資材 200 円 (100 円 × 2 枚)");
  const full = C.planUsage(d, [{ key: "f", label: "畳 テスト表替え", qty: 6, itemCategory: "tatami" }], day(5));
  eq(full.usages.reduce((a, u) => a + (u.amount ?? 0), 0), (1000 + 200 + 100) * 6, "表替え 6 枚 = (表 + 縁 + 副) × 6");
}

/* ------------------------------------------------------------------ */
section("Test 5: 単価を変えても、確定済みの原価は書き換わらない");
const c5 = cust("原価 三郎", "熊本県合志市テスト町7");
const o5 = order(c5.id, "koshi", 66000, "tatami");
await store.mutate((d) => {
  d.customers.push(c5);
  d.orders.push(o5);
  const plan = C.planUsage(d, [{ key: "f", label: "テスト表替え", qty: 6, itemCategory: "tatami" }], day(10));
  C.recordUsages(d, o5, "koshi", "actual", plan.usages, { userId: admin.id, now, date: day(10), source: "bom", makeId: () => id("mu") });
});
const before5 = store.getDb().materialUsages.filter((u) => u.orderId === o5.id).map((u) => u.amount);
await store.mutate((d) => { C.setMaterialCost(d, { materialId: mOmote.id, unitCost: 1500, kind: "provisional", validFrom: "2031-02-01" }, admin.id, id("mc"), now); });
{
  const d = store.getDb();
  const after = d.materialUsages.filter((u) => u.orderId === o5.id).map((u) => u.amount);
  eq(after, before5, "確定した使用の行の金額は当時の単価のまま");
  eq(C.costAt(d, mOmote.id, "2031-01-15").unitCost, 1000, "変更前の日付は前の単価");
  eq(C.costAt(d, mOmote.id, day(10)).unitCost, 1500, "変更後の日付は新しい単価");
  ok(d.materialCosts.filter((c) => c.materialId === mOmote.id).length === 2, "単価の履歴が残る (行は消さない)");
  const r = pnl();
  eq(storeOf(r, "koshi").material, 8580, "合志店の材料費は確定した実績 (税抜 7,800 → この期間は税込の表示で 8,580)");
}

/* ------------------------------------------------------------------ */
section("Test 6: 畳床の仕様 (厚み・規格) で単価が変わる / 仕様がなければ要確認");
{
  const d = store.getDb();
  const lines = [{ key: "a", label: "テスト新調", qty: 2, itemCategory: "tatami" }];
  const p55 = C.planUsage(d, lines, day(5), { "a:1": { materialId: mDoko55.id } }).usages.find((u) => u.materialKind === "doko");
  const p60 = C.planUsage(d, lines, day(5), { "a:1": { materialId: mDoko60.id } }).usages.find((u) => u.materialKind === "doko");
  eq([p55.amount, p55.spec.thickness, p55.spec.size], [6000, 55, "gohachi"], "55mm 五八間は 3,000 × 2");
  eq([p60.amount, p60.spec.thickness, p60.spec.size], [7200, 60, "honma"], "60mm 本間は 3,600 × 2");
  const none = C.planUsage(d, lines, day(5)).usages.find((u) => u.materialKind === "doko");
  ok(none.needsReview && none.amount === undefined, "仕様を選んでいない畳床は要確認 (推測の金額を入れない)");
  const nob = C.planUsage(d, [{ key: "x", label: "材料構成のない畳", qty: 1, itemCategory: "tatami" }], day(5));
  eq(nob.unmatched.length, 1, "材料構成のない畳の明細は要確認の一覧に出る");
}

/* ------------------------------------------------------------------ */
section("Test 7: 1 枚の請求書に複数の店舗・品目 → 明細ごとに振り分け、合計が一致");
const sup = { id: "sup_t", name: "テスト材料店", category: "材料", paymentTerms: "月末締め", closingDay: 31, kind: "supplier", active: true };
const mCloth = { id: "mat_cloth", code: "T-CLOTH", name: "テストクロス紙", kind: "cloth", unit: "m", itemCategory: "reform", supplierCode: "SP7566", active: true, createdAt: now, updatedAt: now };
const pu7 = { id: "pu_t7", number: "AP-2031-9001", supplierId: sup.id, storeId: "hq", invoiceDate: day(20), dueDate: day(31), amount: 33000, taxAmount: 3000, description: "テスト", status: "received", source: "ocr", registeredBy: admin.id, createdAt: now, updatedAt: now, items: [{ id: "i1", name: "テスト材料 A", qty: 1, unit: "式", unitPrice: 11000, amount: 11000 }, { id: "i2", name: "テスト材料 B", qty: 2, unit: "式", unitPrice: 11000, amount: 22000 }], account: "仕入高", documentId: "doc_t7" };
const doc7 = { id: "doc_t7", kind: "supplier_invoice", status: "confirmed", extracted: { items: [{ name: "テスト材料 A", storeName: "合志店" }, { name: "テスト材料 B", storeName: "西店" }] }, uploadedBy: admin.id, createdAt: now, updatedAt: now };
await store.mutate((d) => { d.suppliers.push(sup); d.materials.push(mCloth); d.documents.push(doc7); d.purchases.push(pu7); PL.upsertLineAllocs(d, PL.buildLineAllocs(d, pu7, now)); });
{
  const d = store.getDb();
  const rows = d.purchaseLineAllocs.filter((a) => a.purchaseId === pu7.id);
  eq(rows.map((r) => r.ocr.amountExTax), [10000, 20000], "明細の税抜 (消費税を明細の金額の割合で配分)");
  eq(rows.map((r) => r.ai.storeId), ["koshi", "nishi"], "明細の店舗名から店舗を推定");
  const a2 = rows[1];
  const bad = PL.validateSplits(a2, [{ storeId: "nishi", itemCategory: "tatami", costType: "material", amount: 12000 }, { storeId: "tamana", itemCategory: "fusuma", costType: "material", amount: 7000 }], d);
  ok(bad && bad.includes("一致しません"), "分割の合計が明細と合わなければ確定できない");
}
await store.mutate((d) => {
  const rows = d.purchaseLineAllocs.filter((a) => a.purchaseId === pu7.id);
  const opts = { userId: admin.id, now, today: day(25), makeMove: () => ({ id: id("sm"), number: num("SM") }), closed: () => null };
  eq(PL.confirmLineAlloc(d, rows[0], [{ storeId: "koshi", itemCategory: "tatami", costType: "material", amount: 10000 }], opts), null, "1 行目: 合志店 畳 材料費 で確定");
  eq(PL.confirmLineAlloc(d, rows[1], [{ storeId: "nishi", itemCategory: "tatami", costType: "material", amount: 12000 }, { storeId: "tamana", itemCategory: "fusuma", costType: "material", amount: 8000 }], opts), null, "2 行目: 西店と玉名店に分割して確定");
});
{
  const r = pnl();
  eq([storeOf(r, "koshi").material - 8580, storeOf(r, "nishi").material, storeOf(r, "tamana").material], [11000, 13200, 8800], "店舗ごとの材料費に入る (税込の表示: 税抜 × 1.1)");
  const tam = r.categories.find((c) => c.storeId === "tamana" && c.itemCategory === "fusuma");
  eq(tam.material, 8800, "玉名店 × 襖 の材料費");
}

/* ------------------------------------------------------------------ */
section("Test 8: 同じ品番 (SP7566) でも使い道で品目が変わる");
const cF = cust("襖 太郎", "熊本県合志市テスト町9"), cW = cust("壁紙 花子", "熊本県合志市テスト町10");
const oF = order(cF.id, "koshi", 30000, "fusuma"), oW = order(cW.id, "koshi", 80000, "cloth");
const pu8 = { ...pu7, id: "pu_t8", number: "AP-2031-9002", documentId: "doc_t8", amount: 11000, taxAmount: 1000, items: [{ id: "j1", name: "クロス紙", qty: 10, unit: "m", unitPrice: 550, amount: 5500 }, { id: "j2", name: "クロス紙", qty: 10, unit: "m", unitPrice: 550, amount: 5500 }] };
const doc8 = { ...doc7, id: "doc_t8", extracted: { items: [{ name: "クロス紙", code: "SP7566", siteName: "襖 太郎様" }, { name: "クロス紙", code: "SP7566", siteName: "壁紙 花子様" }] } };
await store.mutate((d) => { d.customers.push(cF, cW); d.orders.push(oF, oW); d.documents.push(doc8); d.purchases.push(pu8); PL.upsertLineAllocs(d, PL.buildLineAllocs(d, pu8, now)); });
{
  const rows = store.getDb().purchaseLineAllocs.filter((a) => a.purchaseId === pu8.id);
  eq(rows.map((r) => r.ai.materialId), ["mat_cloth", "mat_cloth"], "品番 SP7566 で同じ材料と判定");
  eq(rows.map((r) => r.ai.orderId), [oF.id, oW.id], "現場名で案件を判定");
  eq(rows.map((r) => r.ai.itemCategory), ["fusuma", "reform"], "襖の工事は襖材料費、壁紙の工事はリフォーム材料費");
}

/* ------------------------------------------------------------------ */
section("Test 9: 根拠が足りない明細は要確認 (勝手に確定しない)");
const pu9 = { ...pu7, id: "pu_t9", number: "AP-2031-9003", documentId: undefined, amount: 1100, taxAmount: 100, items: [{ id: "k1", name: "よく分からない品", qty: 1, unit: "式", unitPrice: 1100, amount: 1100 }] };
await store.mutate((d) => { d.purchases.push(pu9); PL.upsertLineAllocs(d, PL.buildLineAllocs(d, pu9, now)); });
{
  const a = store.getDb().purchaseLineAllocs.find((x) => x.purchaseId === pu9.id);
  ok(a.ai.needsReview && a.status === "needs_review", "要確認になる");
  eq(a.splits.length, 0, "振り分け先は空のまま (担当者が決める)");
  ok(a.ai.reason.includes("要確認"), `理由が残る: ${a.ai.reason.slice(0, 60)}…`);
  const r = pnl();
  ok(r.rows.some((x) => x.source.id === pu9.id && x.provisional), "振り分け前の仕入は勘定科目で仮に入り、暫定の印が付く");
}

/* ------------------------------------------------------------------ */
section("Test 10: 共通経費の案分の合計が共通経費と一致");
await store.mutate((d) => {
  for (const s of ["koshi", "chuo", "nishi", "tamana"]) d.mgmtEntries.push({ id: id("me"), month: "2031-04", storeId: s, kind: "labor", amount: 1, status: "active", createdBy: admin.id, createdAt: now });
  d.mgmtEntries.push({ id: id("me"), month: "2031-04", storeId: "hq", kind: "common_expense", amount: 1000001, note: "テストの共通広告", status: "active", createdBy: admin.id, createdAt: now });
  const mk = (sid, total) => { const o = order(c2.id, sid, total, "tatami", { contractDate: "2031-04-01", salesDate: "2031-04-10" }); d.orders.push(o); };
  mk("koshi", 300000); mk("chuo", 300000); mk("nishi", 200000); mk("tamana", 200000);
});
{
  const p = AL.previewAllocation(store.getDb(), "2031-04");
  eq(p.status, "ok", "粗利益がすべて正なので案分できる");
  eq(p.results.reduce((a, r) => a + r.amount, 0), 1000001, "案分額の合計 = 1,000,001 (端数も一致)");
  eq(p.results.find((r) => r.storeId === "koshi").ratePpm, 300000, "合志店の率 30% (粗利益 3/10)");
  ok(!p.targetStoreIds.includes("hq"), "本部は既定で対象外 (設定で変えられる・暫定)");
  let run;
  await store.mutate((d) => { run = AL.confirmAllocation(d, p, { id: id("ar"), number: num("AR"), userId: admin.id, now }); });
  ok(typeof run !== "string" && run.status === "confirmed", "確定できる");
  const r = P.storePnl(store.getDb(), "2031-04-01", "2031-04-30");
  eq(r.stores.reduce((a, s) => a + s.allocated, 0), 1000001, "店舗別損益の案分額の合計も一致");
  eq(r.allocations[0].status, "confirmed", "確定した案分を使う");
}

/* ------------------------------------------------------------------ */
section("Test 11: 粗利益がゼロ・マイナスなら保留");
await store.mutate((d) => {
  d.mgmtEntries.push({ id: id("me"), month: "2031-05", storeId: "hq", kind: "common_expense", amount: 50000, status: "active", createdBy: admin.id, createdAt: now });
});
{
  const p0 = AL.previewAllocation(store.getDb(), "2031-05");
  eq(p0.status, "held", "粗利益の合計が 0 → 保留 (ゼロ除算しない)");
  await store.mutate((d) => {
    d.orders.push(order(c2.id, "koshi", 100000, "tatami", { contractDate: "2031-05-01", salesDate: "2031-05-10" }));
    d.mgmtEntries.push({ id: id("me"), month: "2031-05", storeId: "chuo", kind: "material_adjust", itemCategory: "tatami", amount: 30000, status: "active", createdBy: admin.id, createdAt: now });
  });
  const p1 = AL.previewAllocation(store.getDb(), "2031-05");
  ok(p1.status === "held" && p1.holdReason.includes("マイナス"), "一部の店舗がマイナス → 保留");
  let res;
  await store.mutate((d) => { res = AL.confirmAllocation(d, p1, { id: id("ar"), number: num("AR"), userId: admin.id, now }); });
  ok(typeof res === "string", "保留の計算は確定できない");
  const pm = AL.previewAllocation(store.getDb(), "2031-05", { manual: { koshi: 1, chuo: 1, nishi: 1, tamana: 1 } });
  eq([pm.status, pm.results.reduce((a, r) => a + r.amount, 0)], ["ok", 50000], "管理者が比率を指定すれば案分できる (合計一致)");
  let res2;
  await store.mutate((d) => { res2 = AL.confirmAllocation(d, pm, { id: id("ar"), number: num("AR"), userId: admin.id, now }); });
  ok(typeof res2 === "string" && res2.includes("理由"), "指定の比率は理由がないと確定できない");
}

/* ------------------------------------------------------------------ */
section("Test 12: 店舗間の材料移動で全社の在庫・原価は増えない");
await store.mutate((d) => {
  ST.postMove(d, { id: id("sm"), number: num("SM"), date: day(2), kind: "receive", materialId: mOmote.id, qty: 10, unitCost: 1000, fromLoc: "supplier", toLoc: "store:hq", createdBy: admin.id, createdAt: now });
});
const before12 = ST.stockTotals(store.getDb()).amount;
const mat12 = pnl().total.material;
await store.mutate((d) => {
  ST.postMove(d, { id: id("sm"), number: num("SM"), date: day(3), kind: "transfer", materialId: mOmote.id, qty: 4, unitCost: 1000, fromLoc: "store:hq", toLoc: "store:koshi", createdBy: admin.id, createdAt: now });
});
{
  const d = store.getDb();
  eq(ST.stockTotals(d).amount, before12, "全社の在庫金額は変わらない");
  eq(ST.stockTotals(d).qty.get(mOmote.id), 10, "全社の在庫数量も変わらない");
  eq(ST.stockBalances(d).filter((b) => b.materialId === mOmote.id).map((b) => [b.storeId, b.qty]).sort(), [["hq", 6], ["koshi", 4]], "本部 6 枚・合志店 4 枚");
  eq(pnl().total.material, mat12, "材料費 (原価) も増えない");
  eq(ST.validateMove({ kind: "transfer", fromLoc: "store:koshi", toLoc: "store:koshi", qty: 1, unitCost: 1 }), "移動は 店舗 → 別の店舗 です。", "同じ店舗への移動は断る");
  const mv = d.stockMoves.find((m) => m.kind === "transfer" && m.toLoc === "store:koshi");
  let rev;
  await store.mutate((dd) => { rev = ST.reverseMove(dd, dd.stockMoves.find((m) => m.id === mv.id), { id: id("sm"), number: num("SM"), userId: admin.id, now, today: day(4), reason: "テストの取消し" }); });
  ok(typeof rev !== "string" && rev.reversalOf === mv.id, "取消しは逆向きの移動 (元の行は残る)");
  eq(ST.stockBalances(store.getDb()).find((b) => b.storeId === "koshi" && b.materialId === mOmote.id).qty, 0, "取消し後の合志店の在庫 0");
}

/* ------------------------------------------------------------------ */
section("Test 13: 本部の特殊売上 (本部 450,000 円のうち 240,000 円を中央店へ)");
const c13 = cust("特殊 案件", "海外");
const o13 = order(c13.id, "hq", 450000, "tatami", { contractDate: "2031-06-01", salesDate: "2031-06-15" });
await store.mutate((d) => {
  d.customers.push(c13);
  d.orders.push(o13);
  d.salesAdjustments.push({ id: id("adj"), number: num("SA"), kind: "hq_special", orderId: o13.id, fromStoreId: "chuo", toStoreId: "hq", base: "tax_included", amount: 240000, treatment: "sales_transfer", provisional: false, status: "active", reason: "本部売上のうち中央店の作業分", createdBy: admin.id, createdAt: now });
});
{
  const r = P.storePnl(store.getDb(), "2031-06-01", "2031-06-30");
  eq(r.total.externalSales, 450000, "全社の外部売上は 450,000 のまま (690,000 にならない)");
  eq([storeOf(r, "hq").mgmtSales, storeOf(r, "chuo").mgmtSales], [210000, 240000], "本部 210,000・中央店 240,000");
  eq(P.reconcile(store.getDb(), "2031-06").checks[0].ok, true, "月次の照合: 外部売上 = 店舗別の管理売上の合計");
}

/* ------------------------------------------------------------------ */
section("Test 14: 確定した売上の調整の訂正 (履歴が残る)");
{
  let rev;
  await store.mutate((d) => { rev = AT.reverseAdjustment(d, d.salesAdjustments.find((a) => a.id === adj2.id), { id: id("adj"), number: num("SA"), userId: admin.id, now, today: day(20), reason: "依頼元の誤り" }); });
  const d = store.getDb();
  const orig = d.salesAdjustments.find((a) => a.id === adj2.id);
  ok(typeof rev !== "string", "取り消せる");
  eq([orig.status, orig.amount, orig.reversedBy], ["reversed", 20000, rev.id], "元の行は金額のまま残り、取り消した行が分かる");
  eq([rev.amount, rev.reversalOf, rev.reason], [-20000, adj2.id, "依頼元の誤り"], "取消しの行は逆の金額・元の行・理由を持つ");
  const r = pnl();
  eq([storeOf(r, "koshi").adjInternal, storeOf(r, "chuo").adjInternal], [0, 0], "取消し後の内部受注の配分は 0");
  ok(typeof AT.reverseAdjustment(d, orig, { id: "x", number: "x", userId: admin.id, now, today: day(20), reason: "" }) === "string", "取消し済みの行はもう一度取り消せない");
}

/* ------------------------------------------------------------------ */
section("月次確定: 確定した月には入れられない");
await store.mutate((d) => { d.periodCloses.push({ id: "2031-06", month: "2031-06", status: "closed", history: [{ action: "close", by: admin.id, at: now }], updatedAt: now }); });
{
  const d = store.getDb();
  ok(CL.closedReason(d, "2031-06-20") !== null, "2031-06 の日付は断る");
  eq(CL.closedReason(d, "2031-07-01"), null, "開いている月は入れられる");
  eq(CL.correctionDate(d, "2031-06-20", "2031-07-02"), null, "解除して訂正する設定 (既定) では、確定した月の訂正は断る");
}

/* ------------------------------------------------------------------ */
section("Test 16: 月次の照合 (外部売上と店舗の配分の合計・案分・振り分け)");
{
  const rc = P.reconcile(store.getDb(), "2031-04");
  ok(rc.checks.filter((c) => c.label.startsWith("全社") || c.label.startsWith("店舗間") || c.label.startsWith("共通経費の案分額")).every((c) => c.ok), "2031-04: 外部売上・調整の合計・案分額の合計がすべて一致");
  const rc3 = P.reconcile(store.getDb(), M);
  eq(rc3.externalSales, rc3.storeMgmtSalesSum, "2031-03: 全社の外部売上 = 店舗別の管理売上の合計");
  ok(rc3.checks.find((c) => c.label.startsWith("仕入明細")).ok, "仕入明細の振り分けの合計 = 明細の金額");
  const src = P.pnlSources(pnl(), { storeId: "koshi", metric: "material" });
  ok(src.count > 0 && src.rows.every((r) => r.source.label), "数字の根拠 (元帳の行と元の記録) を出せる");
}

/* ------------------------------------------------------------------ */
section("Test 17: 再取り込み・二重登録の防止");
{
  const countBefore = store.getDb().purchaseLineAllocs.length;
  await store.mutate((d) => { PL.upsertLineAllocs(d, PL.buildLineAllocs(d, d.purchases.find((p) => p.id === pu7.id), now)); });
  eq(store.getDb().purchaseLineAllocs.length, countBefore, "同じ請求書を読み直しても明細の振り分けの行は増えない");
  ok(store.getDb().purchaseLineAllocs.filter((a) => a.purchaseId === pu7.id).every((a) => a.status === "confirmed"), "確定した振り分けは読み直しで変わらない");
  ok(PL.duplicatePurchase(store.getDb(), sup.id, " ap-2031-9001 ".toUpperCase()) === undefined, "請求書番号がなければ二重とは判定しない");
  await store.mutate((d) => { d.purchases.find((p) => p.id === pu7.id).supplierInvoiceNo = "INV-777"; });
  ok(PL.duplicatePurchase(store.getDb(), sup.id, "inv-777")?.id === pu7.id, "同じ仕入先・同じ請求書番号は二重登録として見つける");
  // 在庫の振り分けの確定し直しで受入が増えない
  const pu17 = { ...pu7, id: "pu_t17", number: "AP-2031-9017", documentId: undefined, amount: 11000, taxAmount: 1000, items: [{ id: "m1", name: "テスト畳表", qty: 10, unit: "枚", unitPrice: 1100, amount: 11000 }], supplierInvoiceNo: undefined };
  await store.mutate((d) => { d.purchases.push(pu17); PL.upsertLineAllocs(d, PL.buildLineAllocs(d, pu17, now)); });
  const opts = { userId: admin.id, now, today: day(25), makeMove: () => ({ id: id("sm"), number: num("SM") }), closed: () => null };
  const split = [{ storeId: "hq", itemCategory: "tatami", costType: "inventory", materialId: mOmote.id, qty: 10, amount: 10000 }];
  for (let k = 0; k < 2; k++) await store.mutate((d) => { PL.confirmLineAlloc(d, d.purchaseLineAllocs.find((a) => a.purchaseId === pu17.id), split, opts); });
  const recv = store.getDb().stockMoves.filter((m) => m.purchaseId === pu17.id);
  eq(recv.length, 1, "同じ内容で 2 回確定しても在庫の受入は 1 回");
  const auto = store.getDb().purchaseLineAllocs.find((a) => a.purchaseId === pu17.id);
  eq(auto.ai.costType, "inventory", "本部の一括仕入の畳表は「在庫」と判定 (使ったときに原価)");
  const r = pnl();
  ok(!r.rows.some((x) => x.source.id === auto.id), "在庫の受入は材料費に入らない (二重に原価にしない)");
}

/* ------------------------------------------------------------------ */
section("設定の履歴 (変更前の期間は前の値)");
{
  const d = store.getDb();
  eq(R.ruleAt(d, "pnl.basis", "2030-12-31").value, "tax_excluded", "変更前の日付は既定値 (税抜)");
  eq(R.ruleAt(d, "pnl.basis", "2031-01-01").value, "tax_included", "変更後の日付は新しい値");
  eq(R.ruleAt(d, "alloc.basis", "2025-06-30").value, "sales", "共通経費の案分の基準: 2025-06 までは売上比");
  eq(R.ruleAt(d, "alloc.basis", "2025-07-01").value, "gross", "2025-07 からは粗利比 (議事録)");
  eq(R.validateRule("internal.rate.normal", "20000"), "率は 100% (10000) 以下にしてください。", "100% を超える率は断る");
  const cats = CAT.orderCategorySales(d, { total: 110000, category: "tatami", amounts: { tatami: 60000, fusuma: 40000, shoji: 0, amido: 0, curtain: 10000, cloth: 0, own: 0, misc: 10000, discount: -10000 } }, { amounts: { tatami: 60000, fusuma: 40000, shoji: 0, amido: 0, curtain: 10000, cloth: 0, own: 0, misc: 10000, discount: -10000 }, items: [], itemSource: "ledger" }, "2031-03-01");
  eq(cats, { tatami: 54000, fusuma: 36000, curtain: 10000, misc: 10000 }, "値引は 畳・襖・リフォーム・自社商品 の割合で案分 (カーテン・諸経費には案分しない)");
}

summary();
