"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Material, User } from "@/lib/db/types";
import { addAudit, diffChanges, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { canAccessStore, canManageHeriStock, canRecordHeriMove, canReverseHeriMove, type HeriOp } from "@/lib/auth/permissions";
import { officeCtx } from "@/lib/office";
import { heriTablesMissing } from "@/lib/office-tables";
import { COMMON_LOC, HERI_OP_LABEL, applyHeriImport, heriAlertNotice, heriCode, heriLabel, heriName, planHeriImport, readHeriUpload, recordHeriOp, reverseHeriMove, type HeriAlert } from "@/lib/heri-stock";
import { mentionNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";
import { round4 } from "@/lib/mgmt/decimal";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 縁在庫の操作 (入庫・振り分け・使用・棚卸・取消し・品番の設定・縁在庫表の取込)
 * 順序: requireActionUser → 権限 (permissions.ts の canRecordHeriMove など) → 店舗スコープ (案件の店舗) → 表の有無 →
 * mutate (src/lib/heri-stock.ts) → addAudit → 規定量を下回ったら社内連絡 (保存の後にメール・Chatwork は各自の設定のとき) → revalidatePath → redirect
 * 原価・単価は受け取らない (管理会計と同じ順に自動で入れる)
 */

const BASE = "/heri";
const today = () => toDateKey(new Date());
const OPS: HeriOp[] = ["receive", "transfer", "use", "count"];

const num = (v: string) => {
  const s = v.normalize("NFKC").replace(/[,\s帖枚本m]/g, "");
  return /^\d+(\.\d{1,4})?$/.test(s) ? Number(s) : NaN;
};

async function start(fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), BASE);
  return { user, back, ctx: officeCtx(getDb()) };
}

async function tablesOk(back: string) {
  const missing = await heriTablesMissing();
  if (missing) fail(back, missing);
}

/** 規定量を下回ったときの社内連絡の通知 (メール・Chatwork は各自の設定のとき。画面のお知らせは常に) */
async function notifyAlert(user: User, notice: ReturnType<typeof heriAlertNotice>) {
  if (!notice) return;
  const db = getDb();
  const t = db.threads.find((x) => x.id === notice.thread.id);
  if (t) await sendAndRecord(mentionNotices(db, t, notice.message), user.id);
}

function done(back: string, msg: string): never {
  revalidatePath(BASE);
  revalidatePath("/messages");
  redirect(withMsg(back, msg));
}

/** 入庫・振り分け・使用・棚卸 (1 件) */
export async function recordHeriAction(fd: FormData) {
  const { user, back, ctx } = await start(fd);
  const op = str(fd, "op") as HeriOp;
  if (!OPS.includes(op)) fail(back, "操作の種類を選んでください。");
  const from = op === "transfer" || op === "use" ? str(fd, "from") || COMMON_LOC : undefined;
  const to = op === "receive" || op === "transfer" || op === "count" ? str(fd, "to") || (op === "transfer" ? "" : COMMON_LOC) : undefined;
  if (!canRecordHeriMove(user, op, { from, to }, ctx)) fail(back, op === "use" ? "使用は所属店舗の在庫か共通在庫から登録できます。" : op === "receive" ? "入庫は事務担当・本部スタッフ・管理者が登録します。" : `この場所の${HERI_OP_LABEL[op]}を登録する権限がありません (店長は共通在庫と所属店舗の間・所属店舗の棚卸)。`);
  const qty = num(str(fd, "qty"));
  if (!Number.isFinite(qty)) fail(back, "数量を数で入力してください (小数 4 桁まで)。");
  const orderRef = str(fd, "order");
  const order = orderRef ? getDb().orders.find((o) => o.id === orderRef || o.number === orderRef) : undefined;
  if (orderRef && !order) fail(back, `受注番号「${orderRef}」の案件が見つかりません。`);
  if (order && !canAccessStore(user, order.storeId)) fail(back, "この案件の店舗の情報を操作する権限がありません。");
  await tablesOk(back);
  let msg = "";
  let notice: ReturnType<typeof heriAlertNotice> = undefined;
  await mutate((db) => {
    const r = recordHeriOp(db, user, { op, materialId: str(fd, "materialId"), qty, date: str(fd, "date") || today(), from, to, orderId: op === "use" ? order?.id : undefined, note: str(fd, "note").slice(0, 150) });
    if (typeof r === "string") fail(back, r);
    msg = r.message;
    if (r.alert) notice = heriAlertNotice(db, user, [r.alert], [from, to].map((l) => l?.replace(/^store:/, "") ?? ""));
  });
  await notifyAlert(user, notice);
  done(back, notice ? `${msg} 共通在庫が規定量を下回りました (本部スタッフ・店長に社内連絡で知らせました)。` : msg);
}

/** まとめて棚卸 (1 つの場所で、数えた数量を入れた品番だけ) */
export async function countHeriAction(fd: FormData) {
  const { user, back, ctx } = await start(fd);
  const loc = str(fd, "loc") || COMMON_LOC;
  if (!canRecordHeriMove(user, "count", { to: loc }, ctx)) fail(back, "この場所の棚卸を登録する権限がありません (店長は所属店舗)。");
  const date = str(fd, "date") || today();
  const entries: [string, number][] = [];
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("count_") || typeof v !== "string" || !v.trim()) continue;
    const q = num(v);
    if (!Number.isFinite(q)) fail(back, `数えた数量「${v}」を数で入力してください。`);
    entries.push([k.slice(6), q]);
  }
  if (!entries.length) fail(back, "数えた数量を 1 つ以上入力してください (空欄の品番は変えません)。");
  await tablesOk(back);
  let changed = 0;
  const alerts: HeriAlert[] = [];
  let notice: ReturnType<typeof heriAlertNotice> = undefined;
  await mutate((db) => {
    for (const [materialId, qty] of entries) {
      const r = recordHeriOp(db, user, { op: "count", materialId, qty, date, to: loc });
      if (typeof r === "string") fail(back, `${heriLabel(db.materials.find((m) => m.id === materialId) ?? { name: materialId })}: ${r}`);
      if (r.move) changed++;
      if (r.alert) alerts.push(r.alert);
    }
    notice = heriAlertNotice(db, user, alerts, [loc.replace(/^store:/, "")]);
  });
  await notifyAlert(user, notice);
  done(back, `棚卸を登録しました (${entries.length} 品番のうち数量が変わったもの ${changed} 件)。${notice ? " 共通在庫が規定量を下回った品番があります (社内連絡で知らせました)。" : ""}`);
}

/** 登録の取消し (逆向きの行を追加) */
export async function reverseHeriAction(fd: FormData) {
  const { user, back, ctx } = await start(fd);
  const id = str(fd, "id");
  const reason = str(fd, "reason").slice(0, 150);
  const m = getDb().stockMoves.find((x) => x.id === id);
  if (!m) fail(back, "登録が見つかりません。");
  if (!canReverseHeriMove(user, m, ctx)) fail(back, "取り消せるのは、登録した本人・事務担当・本部スタッフ・管理者です。");
  if (!reason) fail(back, "取消しの理由を入力してください。");
  await tablesOk(back);
  let notice: ReturnType<typeof heriAlertNotice> = undefined;
  await mutate((db) => {
    const r = reverseHeriMove(db, user, id, reason, today());
    if (typeof r === "string") fail(back, r);
    if (r.alert) notice = heriAlertNotice(db, user, [r.alert], [m.fromLoc, m.toLoc].map((l) => l?.replace(/^store:/, "") ?? ""));
  });
  await notifyAlert(user, notice);
  done(back, "登録を取り消しました (逆向きの行を追加。元の行は残ります)。");
}

/* ================================================================== */
/* 品番の設定 (発注先・単位・規定量)                                         */
/* ================================================================== */

const MATERIAL_FIELDS: (keyof Material)[] = ["code", "name", "series", "supplierCode", "unit", "supplierId", "reorderLevel", "lineup", "active", "note"];

export async function saveHeriMaterial(fd: FormData) {
  const { user, back, ctx } = await start(fd);
  if (!canManageHeriStock(user, ctx)) fail(back, "品番の登録・変更は事務担当・本部スタッフ・管理者が行います。");
  const id = str(fd, "id");
  const series = str(fd, "series").normalize("NFKC").trim().slice(0, 40);
  const no = str(fd, "no").normalize("NFKC").trim().slice(0, 40);
  if (!no) fail(back, "品番を入力してください (例: 410・笹 黒)。");
  const levelRaw = str(fd, "reorderLevel");
  const reorderLevel = levelRaw ? num(levelRaw) : undefined;
  if (levelRaw && !Number.isFinite(reorderLevel)) fail(back, "規定量を数で入力してください (空欄 = 設定なし)。");
  const supplierId = str(fd, "supplierId") || undefined;
  if (supplierId && !getDb().suppliers.some((s) => s.id === supplierId)) fail(back, "発注先が見つかりません。");
  await tablesOk(back);
  const row = {
    code: heriCode(series || "その他", no),
    name: (str(fd, "name").slice(0, 80) || `縁 ${heriName(series, no)}`).trim(),
    series: series || undefined,
    supplierCode: no,
    unit: str(fd, "unit").slice(0, 10) || "帖",
    supplierId,
    reorderLevel: reorderLevel === undefined ? undefined : round4(reorderLevel),
    lineup: str(fd, "lineup") === "1" || undefined,
    active: str(fd, "active") !== "0",
    note: str(fd, "note").slice(0, 300) || undefined,
  };
  let msg = "";
  await mutate((db) => {
    const now = nowIso();
    const dup = db.materials.find((m) => m.code === row.code && m.id !== id);
    if (dup) fail(back, `${heriName(series, no)} はもう登録されています。`);
    if (id) {
      const m = db.materials.find((x) => x.id === id && x.kind === "heri");
      if (!m) fail(back, "縁の品番が見つかりません。");
      const changes = diffChanges(m, { ...m, ...row }, MATERIAL_FIELDS);
      if (!changes.length) {
        msg = "変更はありません。";
        return;
      }
      Object.assign(m, row, { updatedAt: now });
      addAudit(db, { userId: user.id, action: "update", entity: "material", entityId: m.id, entityLabel: heriLabel(m), summary: `縁の品番を変更 (${heriLabel(m)})`, changes });
      msg = `${heriLabel(m)} を保存しました。`;
    } else {
      const m: Material = { id: newId("mat"), ...row, kind: "heri", itemCategory: "tatami", createdAt: now, updatedAt: now };
      db.materials.push(m);
      addAudit(db, { userId: user.id, action: "create", entity: "material", entityId: m.id, entityLabel: heriLabel(m), summary: `縁の品番を登録 (${heriLabel(m)}${m.reorderLevel !== undefined ? `・規定量 ${m.reorderLevel} ${m.unit}` : ""})` });
      msg = `${heriLabel(m)} を登録しました。`;
    }
  });
  done(`${BASE}?tab=master`, msg);
}

/* ================================================================== */
/* 縁在庫表 (.xlsx・CSV) の取込                                            */
/* ================================================================== */

export async function importHeriAction(fd: FormData) {
  const { user, back, ctx } = await start(fd);
  if (!canManageHeriStock(user, ctx)) fail(back, "縁在庫表の取込は事務担当・本部スタッフ・管理者が行います。");
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) fail(back, "縁在庫表 (.xlsx) か CSV を選んでください。");
  if (file.size > 30 * 1024 * 1024) fail(back, "ファイルが大きすぎます (30 MB まで)。");
  const loc = str(fd, "loc") || COMMON_LOC;
  if (!getDb().stores.some((s) => `store:${s.id}` === loc)) fail(back, "数量を合わせる場所を選んでください。");
  const date = str(fd, "date") || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(back, "棚卸日を入力してください。");
  let items: ReturnType<typeof readHeriUpload>;
  try {
    items = readHeriUpload(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    fail(back, `ファイルを読み取れませんでした: ${(e as Error).message}`);
  }
  if (typeof items === "string") fail(back, items);
  if (!items.length) fail(back, "品番と数量の行が見つかりません (シートに「品番 | 帖」の見出しが必要です)。");
  const plan0 = planHeriImport(getDb(), items, loc, date);
  const errors = plan0.lines.filter((l) => l.status === "error").slice(0, 3).map((l) => `${l.ref} ${l.label}: ${l.message}`);
  const tail = errors.length ? ` 確認: ${errors.join(" / ")}` : "";
  if (str(fd, "mode") !== "commit") {
    done(back, `確認 (まだ登録していません): ${plan0.items.length} 品番 (新しい品番 ${plan0.newMaterials} 件・数量を合わせる品番 ${plan0.counts} 件・変更なし ${plan0.lines.filter((l) => l.status === "same").length} 件)。${tail} よければ「取り込む」を押してください。`);
  }
  await tablesOk(back);
  let res = { materials: 0, moves: 0 };
  await mutate((db) => {
    const plan = planHeriImport(db, items, loc, date);
    res = applyHeriImport(db, user, plan, { loc, date, sourceLabel: file.name.slice(0, 60) });
  });
  done(back, `縁在庫表を取り込みました (品番の登録 ${res.materials} 件・数量の調整 ${res.moves} 件。${date} の棚卸として数量だけを登録)。${tail}`);
}
