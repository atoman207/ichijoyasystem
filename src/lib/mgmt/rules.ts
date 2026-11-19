import type { Database, MgmtRule } from "@/lib/db/types";

/**
 * 管理会計の設定マスタ (適用期間つき)
 * ------------------------------------------------------------
 * - 値はコードに固定しない。設定の行 (db.mgmtRules) を足して変える。行には適用開始日があり、前の行は終了日で閉じる (履歴が残る)
 * - 行がない期間は、下の既定値を使う。既定値には根拠 (社内資料) と状態 (確認済み / 暫定) を書く
 * - 暫定 (provisional) の設定を使って計算した結果は「暫定」と表示する (税理士・社内の確認待ちの項目)
 */

export type RuleType = "bp" | "yen" | "enum";

export interface RuleDef {
  group: string;
  label: string;
  type: RuleType;
  options?: Record<string, string>;
  /** 既定値 (期間ごと。古い順) */
  defaults: { validFrom: string; value: string; status: MgmtRule["status"] }[];
  /** 根拠・未確定の理由 */
  basis: string;
}

const ROUND_OPTIONS = { floor: "切り捨て", round: "四捨五入", ceil: "切り上げ" };

export const RULE_DEFS: Record<string, RuleDef> = {
  "internal.rate.normal": {
    group: "売上配分",
    label: "内部受注の配分率 (通常工事)",
    type: "bp",
    defaults: [{ validFrom: "2000-01-01", value: "2000", status: "confirmed" }],
    basis: "売上シートの内部受注の欄「発生条件：担当エリアの仕事を他店舗に割り振った場合 / 税込売上の20% 小数点切り捨て」、議事録「内部受注20％に変更」。以前のシートは 30% (変更日は資料にないため、20% を全期間に適用。過去の率は設定で期間を指定して登録できる)",
  },
  "internal.rate.reform": {
    group: "売上配分",
    label: "内部受注の配分率 (リフォーム工事)",
    type: "bp",
    defaults: [{ validFrom: "2000-01-01", value: "500", status: "provisional" }],
    basis: "ご依頼の仕様 (リフォーム工事 5%)。社内資料 (売上シート・材料移動・議事録) には 5% の記載がないため暫定",
  },
  "internal.base": {
    group: "売上配分",
    label: "内部受注の配分の基準額",
    type: "enum",
    options: { tax_included: "税込の売上", tax_excluded: "税抜の売上" },
    defaults: [{ validFrom: "2000-01-01", value: "tax_included", status: "confirmed" }],
    basis: "売上シート「税込売上の20%」・社内の覚書「該当売上（税込）の20％」。材料移動表では税別に直して記入する (店舗別損益では税抜に換算して表示)",
  },
  "internal.rounding": {
    group: "売上配分",
    label: "内部受注の配分額の端数",
    type: "enum",
    options: ROUND_OPTIONS,
    defaults: [{ validFrom: "2000-01-01", value: "floor", status: "confirmed" }],
    basis: "売上シート「小数点切り捨て」",
  },
  "hq.treatment": {
    group: "売上配分",
    label: "本部売上の特殊配分の会計上の扱い (既定)",
    type: "enum",
    options: { unset: "未確定 (登録ごとに選ぶ)", sales_transfer: "店舗への売上の配分 (内部受注と同じ)", cost_only: "店舗には原価のみ計上 (売上は本部)" },
    defaults: [{ validFrom: "2000-01-01", value: "unset", status: "provisional" }],
    basis: "例: 本部で売上を計上し、作業した店舗へ金額を指定して配分した案件 (材料移動の内部受注の欄に、畳の税別売上の全額を記入した例がある)。本部売上の振替と「原価のみ」の関係は資料で確定できないため未確定",
  },
  "pnl.basis": {
    group: "損益の表示",
    label: "店舗別損益の金額",
    type: "enum",
    options: { tax_excluded: "税抜", tax_included: "税込" },
    defaults: [{ validFrom: "2000-01-01", value: "tax_excluded", status: "confirmed" }],
    basis: "売上シートの集計は税別売上 (税込 ÷ 1.1)、材料移動は税別",
  },
  "tax.exclusion_rounding": {
    group: "損益の表示",
    label: "税込から税抜に直すときの端数",
    type: "enum",
    options: ROUND_OPTIONS,
    defaults: [{ validFrom: "2000-01-01", value: "round", status: "provisional" }],
    basis: "売上シートは ÷1.1 を丸めずに使っている (円未満が残る)。システムは円で持つため、端数の方法は暫定",
  },
  "category.discount": {
    group: "品目",
    label: "値引 (品目の指定がない値引) の品目",
    type: "enum",
    options: { share4: "畳・襖・リフォーム・自社商品の売上の割合で案分", other: "「その他」に入れる" },
    defaults: [{ validFrom: "2000-01-01", value: "share4", status: "confirmed" }],
    basis: "売上シートの集計 (値引案分): 値引は 畳・襖・リフォーム・自社商品 の割合で案分し、カーテン・諸経費には案分しない",
  },
  "sub_material.unit_cost": {
    group: "材料原価",
    label: "副資材 (畳 1 枚あたり・半畳も 1 枚)",
    type: "yen",
    defaults: [{ validFrom: "2000-01-01", value: "100", status: "confirmed" }],
    basis: "社内総合マニュアル・売上シートの原価計算「副 100」(半畳も 1 枚として数える)",
  },
  "omote.diff_method": {
    group: "材料原価",
    label: "畳表の仮原価と実仕入の差額",
    type: "enum",
    options: { unset: "未確定 (自動で計算しない。担当者が差額を手入力)", manual: "担当者が期間・在庫を確かめて差額を登録" },
    defaults: [{ validFrom: "2000-01-01", value: "unset", status: "provisional" }],
    basis: "売上シートの畳表の原価は実際の仕入の平均より高い。差額の期間・在庫評価の方法は資料にないため未確定 (仕入 − 使用分の仮原価 の単純な差額は在庫の増減で不正確になるため使わない)",
  },
  "alloc.basis": {
    group: "共通経費の案分",
    label: "共通経費の案分の基準",
    type: "enum",
    options: { gross: "粗利益の比率", sales: "売上の比率" },
    defaults: [
      { validFrom: "2000-01-01", value: "sales", status: "confirmed" },
      { validFrom: "2025-07-01", value: "gross", status: "confirmed" },
    ],
    basis: "議事録 (2025-09-19)「費用按分を今期から売上比から粗利比に変更」「粗利＝売上－材料原価－リフォーム外注費」。今期 = 2025 年 7 月からの年度 (売上シートの年度は 7 月〜6 月) として適用",
  },
  "alloc.include_hq": {
    group: "共通経費の案分",
    label: "本部を案分の対象に含める",
    type: "enum",
    options: { no: "含めない (4 店舗で案分)", yes: "含める" },
    defaults: [{ validFrom: "2000-01-01", value: "no", status: "provisional" }],
    basis: "税理士の処理が資料にないため暫定",
  },
  "alloc.nonpositive": {
    group: "共通経費の案分",
    label: "粗利益がゼロ・マイナスの店舗があるとき",
    type: "enum",
    options: { hold: "保留 (自動で案分しない。管理者が方法を選ぶ)" },
    defaults: [{ validFrom: "2000-01-01", value: "hold", status: "confirmed" }],
    basis: "ご依頼の仕様 (未承認の方法で案分しない)",
  },
  "alloc.rounding": {
    group: "共通経費の案分",
    label: "案分額の端数",
    type: "enum",
    options: { largest_remainder: "切り捨てた残りを端数の大きい店舗から 1 円ずつ", largest_share: "切り捨てた残りを案分額の最も大きい店舗へ" },
    defaults: [{ validFrom: "2000-01-01", value: "largest_remainder", status: "provisional" }],
    basis: "端数処理の方法は資料にないため暫定 (どちらも案分額の合計は共通経費と一致する)",
  },
  "alloc.gp_timing": {
    group: "共通経費の案分",
    label: "案分に使う粗利益の確定タイミング",
    type: "enum",
    options: { run: "案分を確定した時点の粗利益を固定", close: "月次確定の時点の粗利益を固定" },
    defaults: [{ validFrom: "2000-01-01", value: "run", status: "provisional" }],
    basis: "資料にないため暫定。どちらも確定後は基準の粗利益を保存し、後から変わらない",
  },
  "close.correction": {
    group: "月次確定",
    label: "月次確定後の訂正",
    type: "enum",
    options: { reopen: "管理者が確定を解除して訂正し、もう一度確定する (履歴を残す)", next_month: "確定した月は変えず、翌月以降に訂正の行を登録する" },
    defaults: [{ validFrom: "2000-01-01", value: "reopen", status: "provisional" }],
    basis: "資料にないため暫定",
  },
};

export const RULE_GROUPS = [...new Set(Object.values(RULE_DEFS).map((d) => d.group))];

export interface RuleValue {
  key: string;
  value: string;
  status: MgmtRule["status"];
  validFrom: string;
  validTo?: string;
  /** 設定の行 (既定値のときは空) */
  ruleId?: string;
}

/** その日に適用される設定の値 */
export function ruleAt(db: Pick<Database, "mgmtRules">, key: string, date: string): RuleValue {
  const def = RULE_DEFS[key];
  if (!def) throw new Error(`設定がありません: ${key}`);
  const rows = (db.mgmtRules ?? []).filter((r) => r.key === key && r.validFrom <= date && (!r.validTo || date <= r.validTo));
  if (rows.length) {
    const r = rows.sort((a, b) => b.validFrom.localeCompare(a.validFrom) || b.createdAt.localeCompare(a.createdAt))[0];
    return { key, value: r.value, status: r.status, validFrom: r.validFrom, validTo: r.validTo, ruleId: r.id };
  }
  const d = [...def.defaults].reverse().find((x) => x.validFrom <= date) ?? def.defaults[0];
  return { key, value: d.value, status: d.status, validFrom: d.validFrom };
}

export const ruleNum = (db: Pick<Database, "mgmtRules">, key: string, date: string) => Number(ruleAt(db, key, date).value);

/** 設定の値を確かめる (誤りなら理由) */
export function validateRule(key: string, value: string): string | null {
  const def = RULE_DEFS[key];
  if (!def) return "設定の項目が正しくありません。";
  if (def.type === "enum") return def.options && value in def.options ? null : "選べない値です。";
  if (!/^\d+$/.test(value)) return def.type === "bp" ? "率は 0.01% 単位の整数で入力してください (20% = 2000)。" : "金額は円の整数で入力してください。";
  if (def.type === "bp" && Number(value) > 10000) return "率は 100% (10000) 以下にしてください。";
  return null;
}

export function prevDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/**
 * 設定を変える (mutate の中で呼ぶ)。適用開始日より前は前の値のまま。行は消さない:
 * - 開始日をまたぐ前の行は、開始日の前日で閉じる
 * - 同じ開始日の行は、開始日の前日で閉じる (適用されない行として履歴に残る)
 * - 後ろに開始日の行があれば、新しい行はその前日まで
 * 確定した月にかかる変更は呼び出し側で断る (過去の確定した結果を変えない)
 */
export function setRule(db: Database, input: { key: string; value: string; validFrom: string; status: MgmtRule["status"]; note?: string }, userId: string, id: string, now: string): MgmtRule {
  const F = input.validFrom;
  const same = db.mgmtRules.filter((r) => r.key === input.key);
  const later = same.filter((r) => r.validFrom > F && (!r.validTo || r.validTo >= r.validFrom)).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0];
  for (const r of same) {
    if (r.validFrom <= F && (!r.validTo || r.validTo >= F)) r.validTo = prevDay(F);
  }
  const row: MgmtRule = { id, key: input.key, value: input.value, validFrom: F, status: input.status, note: input.note, createdBy: userId, createdAt: now };
  if (later) row.validTo = prevDay(later.validFrom);
  db.mgmtRules.push(row);
  return row;
}

/** 表示用の値 */
export function ruleLabel(key: string, value: string): string {
  const def = RULE_DEFS[key];
  if (!def) return value;
  if (def.type === "bp") return `${(Number(value) / 100).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}%`;
  if (def.type === "yen") return `${Number(value).toLocaleString("ja-JP")} 円`;
  return def.options?.[value] ?? value;
}
