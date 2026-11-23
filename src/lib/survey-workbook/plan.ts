import { createHash } from "node:crypto";
import type { Database, GoogleReview, QualityIssue, SurveyHistoryRow } from "@/lib/db/types";
import { addAudit, newId, nextNumber, nowIso } from "@/lib/db/store";
import { QUALITY_KIND_LABEL, kpiSettings } from "@/lib/kpi-settings";
import { buildClaimRecords, matchOrder, orderIndex, parseClaimTab, type ClaimRecord } from "./claims";
import { buildReviewRecords, parseReviewTab, type ReviewRecord } from "./reviews";
import { parseHistoryTab } from "./history";
import { parseKpiTab, reconcileKpi, type ReconYear } from "./kpi-sheet";
import { staffMatcher, type StaffAliases } from "./staff";
import { TAB_KIND_LABEL, detectTab, type TabKind, type WorkbookTab } from "./tabs";

/**
 * スプレッドシート「お客様アンケート集計表」の取込 (確認 → 取り込む)
 * ------------------------------------------------------------
 * - planWorkbook: タブを読み、いまのデータと比べて 新規・更新・変更なし を決める (書き込まない)
 * - applyWorkbook: mutate の中で計画を作り直して書き込む (確認のあとに増えた記録と重ならないように)
 * 一方向 (シート → システム)。シートから消えた行はシステムで消さない。システムで変えた項目 (案件のひも付け・担当者・状態) は上書きしない:
 * シートの行が前回の取込から変わったときだけ、シートの項目 (区分・内容・原因・対策・現場名など) を書き直す (前回の行の印は設定 survey_workbook の state)
 */

export const WORKBOOK_SETTINGS_ID = "survey_workbook";
export const WORKBOOK_NAME = "お客様アンケート集計表";

export interface WorkbookSettings {
  /** Google スプレッドシートの URL (サービスアカウントで全タブを読む) */
  sheetUrl?: string;
  /** サービスアカウントがないとき: タブごとの共有リンク (リンクを知っている全員が閲覧できる設定) */
  tabUrls: string[];
  /** シートの担当者の名前 → 社員 ID / name:<名前> / "-" */
  staffAliases: StaffAliases;
  /** 定期の同期 (毎日。/api/cron/survey-workbook) */
  autoSync: boolean;
  /** 口コミのシートの最初の行の年 (空 = 自動) */
  startYear?: number;
  /** 前回取り込んだ行の印 (key → hash) */
  state: { claims: Record<string, string>; reviews: Record<string, string> };
  lastImport?: { at: string; by: string; label: string; summary: string };
  lastSync?: { at: string; ok: boolean; message: string };
  preview?: { hash: string; at: string; by: string; label: string };
}

export function workbookSettings(db: Pick<Database, "settings">): WorkbookSettings {
  const v = ((db.settings ?? []).find((s) => s.id === WORKBOOK_SETTINGS_ID)?.value ?? {}) as Partial<WorkbookSettings>;
  const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, string>) : {});
  return {
    sheetUrl: typeof v.sheetUrl === "string" && v.sheetUrl ? v.sheetUrl : undefined,
    tabUrls: Array.isArray(v.tabUrls) ? v.tabUrls.filter((x): x is string => typeof x === "string" && Boolean(x)) : [],
    staffAliases: obj(v.staffAliases),
    autoSync: v.autoSync === true,
    startYear: typeof v.startYear === "number" && v.startYear >= 2000 && v.startYear <= 2100 ? v.startYear : undefined,
    state: { claims: obj(v.state?.claims), reviews: obj(v.state?.reviews) },
    lastImport: v.lastImport,
    lastSync: v.lastSync,
    preview: v.preview,
  };
}

/** 設定を書く (mutate の中で呼ぶ) */
export function writeWorkbookSettings(db: Database, next: WorkbookSettings, by: string): void {
  const now = nowIso();
  const row = db.settings.find((s) => s.id === WORKBOOK_SETTINGS_ID);
  const value = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
  if (row) {
    row.value = value;
    row.updatedBy = by;
    row.updatedAt = now;
  } else db.settings.push({ id: WORKBOOK_SETTINGS_ID, value, updatedBy: by, updatedAt: now });
}

/** タブの中身の印 (確認と取込で同じ内容か) */
export function tabsHash(tabs: WorkbookTab[]): string {
  const h = createHash("sha256");
  for (const t of [...tabs].sort((a, b) => a.title.localeCompare(b.title))) {
    h.update(t.title);
    h.update("\u0000");
    for (const r of t.rows) h.update(`${r.join("\u0001")}\u0002`);
  }
  return h.digest("hex").slice(0, 24);
}

export type PlanAction = "create" | "update" | "unchanged";

export interface ClaimPlanItem {
  rec: ClaimRecord;
  action: PlanAction;
  existingId?: string;
  /** ひも付ける案件 (新規、または今は案件のない記録) */
  order?: { id: string; number: string };
  candidates: number;
}

export interface ReviewPlanItem {
  rec: ReviewRecord;
  action: PlanAction;
  existingId?: string;
}

export interface WorkbookPlan {
  hash: string;
  tabs: { title: string; source: string; kind: TabKind; label: string; rows: number }[];
  claims: { items: ClaimPlanItem[]; create: number; update: number; unchanged: number; linked: number; notCounted: number; review: number; overlapSkipped: number; emptyRows: number };
  reviews: { items: ReviewPlanItem[]; create: number; update: number; unchanged: number; startYear?: number; unmatched: { name: string; count: number }[]; ignored: number };
  history: { rows: SurveyHistoryRow[]; create: number; update: number; unchanged: number; blocks: { fiscalLabel: string; storeId?: string; questions: number }[] };
  kpi: ReconYear[];
  problems: string[];
  warnings: string[];
}

const claimFields = (q: Pick<QualityIssue, "occurredOn" | "storeId" | "attribution" | "kind" | "category" | "description" | "cause" | "countermeasure" | "siteName" | "origin" | "counted">) =>
  JSON.stringify([q.occurredOn, q.storeId, q.attribution ?? "store", q.kind, q.category ?? "", q.description, q.cause ?? "", q.countermeasure ?? "", q.siteName ?? "", q.origin ?? "", q.counted !== false]);

const reviewFields = (r: Pick<GoogleReview, "postedOn" | "userId" | "points" | "reviewerName" | "note">) => JSON.stringify([r.postedOn, r.userId, r.points, r.reviewerName ?? "", r.note ?? ""]);

type PlanDb = Pick<Database, "orders" | "customers" | "users" | "qualityIssues" | "reviews" | "surveys" | "settings" | "surveyHistory"> & Partial<Pick<Database, "stores">>;

export function planWorkbook(db: PlanDb, tabs: WorkbookTab[], opts: { today: string; startYear?: number; importedAt?: string }): WorkbookPlan {
  const settings = workbookSettings(db);
  const match = staffMatcher(db.users, settings.staffAliases);
  const problems: string[] = [];
  const warnings: string[] = [];
  const kinds = tabs.map((t) => ({ t, kind: detectTab(t.title, t.rows) }));
  const plan: WorkbookPlan = {
    hash: tabsHash(tabs),
    tabs: kinds.map(({ t, kind }) => ({ title: t.title, source: t.source, kind, label: TAB_KIND_LABEL[kind], rows: t.rows.length })),
    claims: { items: [], create: 0, update: 0, unchanged: 0, linked: 0, notCounted: 0, review: 0, overlapSkipped: 0, emptyRows: 0 },
    reviews: { items: [], create: 0, update: 0, unchanged: 0, unmatched: [], ignored: 0 },
    history: { rows: [], create: 0, update: 0, unchanged: 0, blocks: [] },
    kpi: [],
    problems,
    warnings,
  };
  if (!kinds.some((k) => ["claims", "reviews", "history", "kpi"].includes(k.kind))) problems.push(`取り込めるタブがありません (${WORKBOOK_NAME} の「クレーム手直し内容」「Google口コミ集計」「KPI」「H26集計〜R4集計」)`);

  /* ---- クレーム・手直し ---- */
  const claimTabs = kinds.filter((k) => k.kind === "claims").map(({ t }) => {
    const p = parseClaimTab(t);
    problems.push(...p.problems);
    plan.claims.emptyRows += p.empty;
    return { title: t.title, rows: p.rows, start: p.start };
  });
  if (claimTabs.length) {
    const { records, overlapSkipped } = buildClaimRecords(claimTabs);
    plan.claims.overlapSkipped = overlapSkipped;
    const idx = orderIndex(db);
    const bySource = new Map(db.qualityIssues.filter((q) => q.sourceRef).map((q) => [q.sourceRef!, q]));
    for (const rec of records) {
      const existing = bySource.get(rec.sourceRef);
      const m = !existing || !existing.orderId ? matchOrder(idx, rec) : { candidates: 0 };
      const order = m.order ? { id: m.order.id, number: m.order.number } : undefined;
      let action: PlanAction = "create";
      if (existing) {
        const prev = settings.state.claims[rec.key];
        const sheetSame = prev ? prev === rec.hash : claimFields(existing) === claimFields({ ...rec, attribution: rec.attribution });
        action = sheetSame && !(order && !existing.orderId) ? "unchanged" : "update";
      }
      plan.claims.items.push({ rec, action, existingId: existing?.id, order, candidates: m.candidates });
      plan.claims[action]++;
      if (order) plan.claims.linked++;
      if (!rec.counted) plan.claims.notCounted++;
      if (rec.review) plan.claims.review++;
    }
    // 画面で登録した記録と重なるかもしれないもの (移行の期間に、シートとシステムの両方に書いたとき)
    const manual = db.qualityIssues.filter((q) => !q.sourceRef);
    const overlaps = plan.claims.items.filter((i) => i.action === "create" && manual.some((q) => q.storeId === i.rec.storeId && q.occurredOn.slice(0, 7) === i.rec.occurredOn.slice(0, 7) && q.kind === i.rec.kind && (!i.order || q.orderId === i.order.id))).length;
    if (overlaps) warnings.push(`画面で登録したクレーム・手直しと、同じ月・店舗・区分の行が ${overlaps} 件あります。シートとシステムの両方に書いた記録は、取り込んだ後にどちらかを削除してください`);
    const ambiguous = plan.claims.items.filter((i) => i.candidates > 1).length;
    if (ambiguous) warnings.push(`現場名に当たるお客様が 2 人以上いて、案件を決めなかった行が ${ambiguous} 件あります (取り込んだ後に詳細の画面で受注番号を入れてください)`);
  }

  /* ---- Google 口コミ ---- */
  const reviewTabs = kinds.filter((k) => k.kind === "reviews");
  if (reviewTabs.length > 1) warnings.push("Google口コミ集計のタブが 2 つあります。最初のタブだけを読みます");
  if (reviewTabs.length) {
    const p = parseReviewTab(reviewTabs[0].t);
    problems.push(...p.problems);
    const built = buildReviewRecords(p.rows, match, { today: opts.today, startYear: opts.startYear ?? settings.startYear });
    problems.push(...built.problems);
    plan.reviews.startYear = built.startYear;
    plan.reviews.ignored = built.ignored;
    const bySource = new Map(db.reviews.filter((r) => r.sourceRef).map((r) => [r.sourceRef!, r]));
    const unmatched = new Map<string, number>();
    for (const rec of built.records) {
      if (!rec.staff.userId) unmatched.set(rec.staff.raw, (unmatched.get(rec.staff.raw) ?? 0) + 1);
      const existing = bySource.get(rec.sourceRef);
      let action: PlanAction = "create";
      if (existing) {
        const prev = settings.state.reviews[rec.key];
        action = (prev ? prev === rec.hash : reviewFields(existing) === reviewFields({ postedOn: rec.postedOn, userId: rec.staff.key, points: rec.points, reviewerName: rec.reviewerName, note: rec.note })) ? "unchanged" : "update";
      }
      plan.reviews.items.push({ rec, action, existingId: existing?.id });
      plan.reviews[action]++;
    }
    plan.reviews.unmatched = [...unmatched.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    if (plan.reviews.unmatched.length) warnings.push(`口コミの担当者のうち、社員のアカウントが見つからない名前があります: ${plan.reviews.unmatched.map((u) => `${u.name} (${u.count} 件)`).join("・")}。「担当者の名前の対応」で社員を選ぶか「アカウントなし」「数えない」にしてください`);
  }

  /* ---- アンケートの過去の集計 ---- */
  const importedAt = opts.importedAt ?? nowIso();
  const existingHistory = new Map((db.surveyHistory ?? []).map((h) => [h.id, h]));
  const histRows = new Map<string, SurveyHistoryRow>();
  for (const { t } of kinds.filter((k) => k.kind === "history")) {
    const p = parseHistoryTab(t, importedAt);
    problems.push(...p.problems);
    plan.history.blocks.push(...p.blocks);
    for (const r of p.rows) histRows.set(r.id, r);
  }
  for (const r of histRows.values()) {
    const e = existingHistory.get(r.id);
    if (!e) plan.history.create++;
    else if (e.count !== r.count || e.period !== r.period || e.fiscalLabel !== r.fiscalLabel) plan.history.update++;
    else plan.history.unchanged++;
  }
  plan.history.rows = [...histRows.values()];

  /* ---- KPI (照合だけ) ---- */
  const kpiTab = kinds.find((k) => k.kind === "kpi");
  if (kpiTab) {
    const p = parseKpiTab(kpiTab.t);
    problems.push(...p.problems);
    // 照合は「取り込んだ後」の値で比べる (この計画のクレーム・口コミを足した仮のデータ)
    plan.kpi = reconcileKpi(previewDb(db, plan), p.years, match);
  }
  return plan;
}

/** 照合用: いまのデータに計画の新規・更新を重ねた仮のデータ (書き込まない) */
function previewDb(db: PlanDb, plan: WorkbookPlan): Parameters<typeof reconcileKpi>[0] {
  const qp = kpiSettings(db).qualityPoints;
  const byId = new Map(plan.claims.items.filter((i) => i.existingId).map((i) => [i.existingId!, i]));
  const issues: QualityIssue[] = db.qualityIssues.map((q) => {
    const i = byId.get(q.id);
    return i && i.action === "update" ? { ...q, ...claimFromRecord(i.rec, qp), id: q.id, number: q.number } : q;
  });
  for (const i of plan.claims.items.filter((x) => x.action === "create")) issues.push({ ...claimFromRecord(i.rec, qp), id: `preview_${i.rec.key}`, number: "", status: "open", responsibleUserIds: [], reportedBy: "system", createdAt: "", updatedAt: "" } as QualityIssue);
  const rById = new Map(plan.reviews.items.filter((i) => i.existingId).map((i) => [i.existingId!, i]));
  const reviews: GoogleReview[] = db.reviews.map((r) => {
    const i = rById.get(r.id);
    return i && i.action === "update" ? { ...r, ...reviewFromRecord(i.rec) } : r;
  });
  for (const i of plan.reviews.items.filter((x) => x.action === "create")) reviews.push({ ...reviewFromRecord(i.rec), id: `preview_${i.rec.key}`, createdBy: "system", createdAt: "", updatedAt: "" } as GoogleReview);
  return { orders: db.orders, customers: db.customers, surveys: db.surveys, users: db.users, qualityIssues: issues, reviews, settings: db.settings, stores: db.stores };
}

function claimFromRecord(rec: ClaimRecord, qp: Record<QualityIssue["kind"], number>): Pick<QualityIssue, "occurredOn" | "storeId" | "attribution" | "kind" | "points" | "category" | "description" | "cause" | "countermeasure" | "siteName" | "origin" | "counted" | "sourceRef"> {
  return { occurredOn: rec.occurredOn, storeId: rec.storeId, attribution: rec.attribution, kind: rec.kind, points: qp[rec.kind], category: rec.category, description: rec.description, cause: rec.cause, countermeasure: rec.countermeasure, siteName: rec.siteName, origin: rec.origin, counted: rec.counted, sourceRef: rec.sourceRef };
}

function reviewFromRecord(rec: ReviewRecord): Pick<GoogleReview, "postedOn" | "storeId" | "userId" | "points" | "reviewerName" | "note" | "sourceRef"> {
  return { postedOn: rec.postedOn, storeId: rec.storeId, userId: rec.staff.key, points: rec.points, reviewerName: rec.reviewerName, note: rec.note, sourceRef: rec.sourceRef };
}

export interface ApplyResult {
  plan: WorkbookPlan;
  claims: { created: number; updated: number; linked: number };
  reviews: { created: number; updated: number };
  history: { written: number; removed: number };
  summary: string;
}

/** 取り込む (mutate の中で呼ぶ)。計画はここで作り直す */
export function applyWorkbook(db: Database, tabs: WorkbookTab[], opts: { today: string; startYear?: number; userId: string; label: string }): ApplyResult {
  const now = nowIso();
  const plan = planWorkbook(db, tabs, { today: opts.today, startYear: opts.startYear, importedAt: now });
  const settings = workbookSettings(db);
  const qp = kpiSettings(db).qualityPoints;
  const res: ApplyResult = { plan, claims: { created: 0, updated: 0, linked: 0 }, reviews: { created: 0, updated: 0 }, history: { written: 0, removed: 0 }, summary: "" };
  if (plan.problems.length && !plan.claims.items.length && !plan.reviews.items.length && !plan.history.rows.length) {
    res.summary = "取り込めるものがありませんでした";
    return res;
  }

  /* クレーム・手直し (発生日の古い順に番号を付ける) */
  for (const item of [...plan.claims.items].sort((a, b) => a.rec.occurredOn.localeCompare(b.rec.occurredOn))) {
    const rec = item.rec;
    settings.state.claims[rec.key] = rec.hash;
    if (item.action === "unchanged") continue;
    const order = item.order ? db.orders.find((o) => o.id === item.order!.id) : undefined;
    if (item.action === "create") {
      const resolved = Boolean(rec.cause && rec.countermeasure);
      const q: QualityIssue = {
        id: newId("qc"),
        number: nextNumber(db, "QC", db.qualityIssues, rec.occurredOn),
        ...claimFromRecord(rec, qp),
        orderId: order?.id,
        customerId: order?.customerId,
        responsibleUserIds: [],
        status: resolved ? "resolved" : "open",
        resolvedOn: resolved ? rec.occurredOn : undefined,
        reportedBy: opts.userId,
        createdAt: now,
        updatedAt: now,
      };
      db.qualityIssues.push(q);
      res.claims.created++;
      if (order) res.claims.linked++;
      continue;
    }
    const q = db.qualityIssues.find((x) => x.id === item.existingId);
    if (!q) continue;
    const before = claimFields(q);
    const kindChanged = q.kind !== rec.kind;
    Object.assign(q, { ...claimFromRecord(rec, qp), points: kindChanged ? qp[rec.kind] : q.points });
    if (!q.orderId && order) {
      q.orderId = order.id;
      q.customerId = order.customerId;
      res.claims.linked++;
    }
    if (q.status === "open" && q.cause && q.countermeasure) {
      q.status = "resolved";
      q.resolvedOn = q.occurredOn;
    }
    q.updatedAt = now;
    if (before !== claimFields(q) || order) {
      res.claims.updated++;
      addAudit(db, { userId: opts.userId, action: "update", entity: "quality", entityId: q.id, entityLabel: q.number, summary: `${QUALITY_KIND_LABEL[q.kind]} ${q.number} をスプレッドシートの内容で更新 (${opts.label})`, storeId: q.storeId, changes: [{ field: "sheet", before: "(前回のシートの内容)", after: "(今回のシートの内容)" }] });
    }
  }

  /* Google 口コミ */
  for (const item of plan.reviews.items) {
    const rec = item.rec;
    settings.state.reviews[rec.key] = rec.hash;
    if (item.action === "unchanged") continue;
    if (item.action === "create") {
      db.reviews.push({ id: newId("rv"), ...reviewFromRecord(rec), createdBy: opts.userId, createdAt: now, updatedAt: now });
      res.reviews.created++;
      continue;
    }
    const r = db.reviews.find((x) => x.id === item.existingId);
    if (!r) continue;
    Object.assign(r, reviewFromRecord(rec), { updatedAt: now });
    res.reviews.updated++;
  }

  /* アンケートの過去の集計 (同じタブの行は置き換え。シートから消えた行は消す) */
  if (plan.history.rows.length) {
    db.surveyHistory ??= [];
    const sheets = new Set(plan.history.rows.map((r) => r.sourceRef.split(":").slice(0, 3).join(":")));
    const keep = new Set(plan.history.rows.map((r) => r.id));
    const before = db.surveyHistory.length;
    db.surveyHistory = db.surveyHistory.filter((h) => keep.has(h.id) || !sheets.has(h.sourceRef.split(":").slice(0, 3).join(":")));
    res.history.removed = before - db.surveyHistory.length;
    const byId = new Map(db.surveyHistory.map((h, i) => [h.id, i]));
    for (const r of plan.history.rows) {
      const i = byId.get(r.id);
      if (i === undefined) db.surveyHistory.push(r);
      else db.surveyHistory[i] = r;
      res.history.written++;
    }
  }

  const parts = [
    plan.claims.items.length ? `クレーム・手直し 新規 ${res.claims.created} 件・更新 ${res.claims.updated} 件 (案件にひも付け ${res.claims.linked} 件)` : "",
    plan.reviews.items.length ? `Google 口コミ 新規 ${res.reviews.created} 件・更新 ${res.reviews.updated} 件` : "",
    plan.history.rows.length ? `アンケートの過去の集計 ${res.history.written} 行` : "",
  ].filter(Boolean);
  res.summary = parts.join(" / ") || "変更はありませんでした";
  settings.lastImport = { at: now, by: opts.userId, label: opts.label, summary: res.summary };
  settings.preview = undefined;
  writeWorkbookSettings(db, settings, opts.userId);
  addAudit(db, { userId: opts.userId, action: "import", entity: "kpi", entityId: WORKBOOK_SETTINGS_ID, entityLabel: WORKBOOK_NAME, summary: `${WORKBOOK_NAME} を取り込み (${opts.label}): ${res.summary}`, storeId: "hq" });
  return res;
}
