import "server-only";
import type { Database } from "@/lib/db/types";
import { addDays, toDateKey } from "@/lib/format";
import { readCapacitySettings, scheduleStats, SUGGEST_KINDS } from "@/lib/schedule-capacity";
import { routingStatus } from "@/lib/geo/routing";
import { loadMasters, MASTER_IDS } from "./masters";

/**
 * 一畳屋に用意していただく情報の状況 (予定表 →「仕事量と提案の設定」の「準備の状況」)
 * done = 登録済み / provisional = 暫定の値で動いている (確認が必要) / missing = 未登録 (その条件は確かめていない)
 */

export type ReadyStatus = "done" | "provisional" | "missing";

export interface ReadyItem {
  key: string;
  label: string;
  status: ReadyStatus;
  detail: string;
  /** 設定の画面 (タブ) */
  tab: string;
}

export function readiness(db: Database, now = new Date()): ReadyItem[] {
  const m = loadMasters(db);
  const cap = readCapacitySettings(db);
  const stats = scheduleStats(db, now);
  const has = (id: string) => (db.settings ?? []).some((s) => s.id === id);
  const stores = db.stores.filter((s) => s.kind === "store" && !s.closedOn);
  const capStores = stores.filter((s) => cap.stores[s.id]?.jobsPerDay || cap.stores[s.id]?.visitsPerDay || cap.stores[s.id]?.tatamiPerDay);
  const field = db.users.filter((u) => u.active && (u.role === "store_staff" || u.role === "store_manager"));
  const profiled = field.filter((u) => m.profiles.has(u.id));
  const withSkills = field.filter((u) => Object.keys(m.profiles.get(u.id)?.skills ?? {}).length > 0);
  const withHours = field.filter((u) => m.profiles.get(u.id)?.workStart);
  const resStores = stores.filter((s) => m.resources.some((r) => r.active && r.storeId === s.id));
  const vehicles = m.resources.filter((r) => r.active && r.kind === "vehicle").length;
  const machines = m.resources.filter((r) => r.active && r.kind !== "vehicle").length;
  const provisionalWt = m.workTypes.filter((w) => w.active && w.provisional).length;
  const procSet = m.processes.filter((p) => p.active && p.minutesPerDay !== undefined && !p.provisional).length;
  const today = toDateKey(now);
  const upcoming = db.schedule.filter((e) => SUGGEST_KINDS.includes(e.kind) && e.date >= today && e.date <= addDays(today, 60));
  const specd = upcoming.filter((e) => (db.jobSpecs ?? []).some((s) => (s.recordType === "event" && s.recordId === e.id) || (s.recordType === "order" && s.recordId === e.orderId)));
  const past = db.schedule.filter((e) => SUGGEST_KINDS.includes(e.kind) && e.date < today && e.date >= addDays(today, -365));
  const pastAssigned = past.filter((e) => e.assigneeIds.length);
  const leaves = db.schedule.filter((e) => e.kind === "leave" && e.date >= today && e.date <= addDays(today, 30)).length;
  const route = routingStatus(m.routing);
  const rules = has(MASTER_IDS.rules);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const S = (done: boolean, some: boolean): ReadyStatus => (done ? "done" : some ? "provisional" : "missing");
  return [
    { key: "capacity", label: "店舗別の 1 日の処理上限", status: S(capStores.length === stores.length, true), detail: `${capStores.length}/${stores.length} 店舗を設定済み (未設定の店舗は過去 1 年の実績から自動: ${stores.filter((s) => !cap.stores[s.id]).map((s) => `${s.shortName} ${stats.stores[s.id]?.jobsPerDay ?? "-"} 件`).join("・") || "なし"})`, tab: "capacity" },
    { key: "workTypes", label: "商品・作業別の標準工数", status: S(provisionalWt === 0 && m.configured.workTypes, true), detail: provisionalWt ? `${provisionalWt} 種類が暫定の値です (現場の時間・1 枚あたりの製造時間・人数)` : "確認済み", tab: "work" },
    { key: "production", label: "畳・襖・障子・網戸の製造能力", status: S(procSet > 0 && m.processes.every((p) => !p.active || !p.provisional), procSet > 0), detail: procSet ? `${procSet} 工程の 1 日の能力を設定済み` : "未設定 (畳は店舗の「引き取る畳の枚数」× 30 分、ほかは 1 日 4 時間で仮に計算)", tab: "production" },
    { key: "leadDays", label: "工程ごとの所要日数・引取から納品までの日数", status: S(provisionalWt === 0 && rules, rules || provisionalWt === 0), detail: `製造日数: ${m.workTypes.filter((w) => w.active).map((w) => `${w.name} ${w.leadDays} 日`).join("・")} / 標準 ${m.rules.standardTurnaroundDays} 日`, tab: "work" },
    { key: "skills", label: "社員ごとの技能・担当可能業務", status: S(withSkills.length === field.length && field.length > 0, withSkills.length > 0), detail: `${withSkills.length}/${field.length} 人を登録 (未登録の人は肩書きから推定。技能の条件は登録した人だけで確かめます)`, tab: "staff" },
    { key: "hours", label: "勤務時間・休暇", status: S(withHours.length === field.length && field.length > 0, profiled.length > 0 || leaves > 0), detail: `勤務時間を登録: ${withHours.length}/${field.length} 人・今後 30 日の休暇の予定 ${leaves} 件`, tab: "staff" },
    { key: "resources", label: "使用車両と設備", status: S(resStores.length === stores.length, resStores.length > 0), detail: `車両 ${vehicles} 台・設備 ${machines} 件 (${resStores.length}/${stores.length} 店舗)`, tab: "resources" },
    { key: "preference", label: "お客様の希望を優先する基準・緊急の判断基準", status: S(rules, false), detail: `希望の日から ${m.rules.preferenceToleranceDays} 日以内を「近い」・期限まで ${m.rules.urgentWithinDays} 日以内を「緊急」${rules ? "" : " (初期値)"}`, tab: "rules" },
    { key: "specs", label: "予定・案件の作業の内容 (作業種別と数量・希望・期限)", status: S(upcoming.length > 0 && specd.length === upcoming.length, specd.length > 0), detail: `今後 60 日の案件の予定 ${upcoming.length} 件のうち ${specd.length} 件 (${pct(specd.length, upcoming.length)}%) に登録。ほかは件名・メモ・明細から推定`, tab: "capacity" },
    { key: "history", label: "過去の予定と実績", status: S(past.length >= 200 && pct(pastAssigned.length, past.length) >= 50, past.length > 0), detail: `過去 1 年の案件の予定 ${past.length} 件・担当者の記録あり ${pct(pastAssigned.length, past.length)}%`, tab: "backtest" },
    { key: "travel", label: "実際の移動時間", status: route.ready ? "done" : "provisional", detail: route.ready ? `Google の経路 (今月 ${route.usedThisMonth}/${route.limit} 件)` : `社内の計算 (距離からの目安)。${route.reason ?? ""}`, tab: "routing" },
    { key: "focus", label: "最適化で最も重視する指標", status: S(m.configured.weights, false), detail: `いまの設定: ${{ balanced: "バランス", travel: "移動の少なさ", speed: "早さ", deadline: "期限", revenue: "売上・粗利" }[m.weights.focus]}${m.configured.weights ? "" : " (初期値)"}`, tab: "weights" },
  ];
}
