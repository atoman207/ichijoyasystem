import "server-only";
import type { Database, StoreId, User, WorkKind } from "@/lib/db/types";
import { calcInternalOrder, WORK_KIND_LABEL } from "@/lib/mgmt/attribution";
import { canViewMgmt } from "@/lib/mgmt/access";
import { taxRate } from "@/lib/sales-ledger";
import { toDateKey } from "@/lib/format";
import type { AnalysisResult } from "./analyze";

/**
 * 店舗間の仕事の依頼 (内部受注) で、それぞれの店舗にいくらの売上が計上されるかの計算 (仮の金額でよい)
 * ------------------------------------------------------------
 * 管理会計の画面と同じ計算 (src/lib/mgmt/attribution.ts の calcInternalOrder: 設定の配分率・基準額 (税込/税抜)・端数) を使う:
 *  - 外部売上 (お客様からの売上) は、施工した店舗に全額
 *  - 依頼した店舗 (受注店舗) へ「基準額 × 配分率」を内部受注として移し、施工した店舗から同じ額を引く (合計は変わらない)
 * 「合志店から中央店に 20 万円の通常工事を依頼したら？」のような質問に、AI が計算せずにこの結果で答える。
 * 見られるのは管理会計を見られる人 (店長・本部・管理者。permissions は src/lib/mgmt/access.ts)
 */

export interface StoreSplitInput {
  /** 依頼した店舗 (受注店舗・営業エリアの店舗) */
  fromStore: string;
  /** 施工した店舗 (売上帰属店舗) */
  toStore: string;
  /** 金額 (円) */
  amount: number;
  workKind?: WorkKind;
  /** 金額が税込か (省略 = 税込。受注の金額は税込で登録する) */
  taxIncluded?: boolean;
  date?: string;
}

export type StoreSplitResult =
  | { ok: true; text: string; table: AnalysisResult; summary: string }
  | { ok: false; error: string };

/** 店舗の名前・略称・id から店舗を探す (「合志」「合志店」「koshi」) */
export function findStore(db: Pick<Database, "stores">, raw: string): { id: StoreId; name: string } | undefined {
  const q = raw.normalize("NFKC").replace(/\s/g, "").replace(/店$/, "");
  if (!q) return undefined;
  const s = db.stores.find((x) => x.id === q) ?? db.stores.find((x) => x.name.replace(/\s/g, "").startsWith(q) || (x.shortName ?? "").replace(/\s/g, "").startsWith(q));
  return s ? { id: s.id, name: s.name.split("・")[0] } : undefined;
}

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

export function simulateStoreSplit(db: Database, user: User, input: StoreSplitInput, now = new Date()): StoreSplitResult {
  if (!canViewMgmt(user)) return { ok: false, error: "店舗間の売上の配分 (管理会計) は、店長・本部スタッフ・管理者が確認できます。店長に確認してください。" };
  const from = findStore(db, input.fromStore);
  const to = findStore(db, input.toStore);
  if (!from || !to) return { ok: false, error: `店舗が分かりません (${!from ? input.fromStore : input.toStore})。店舗: ${db.stores.map((s) => s.name.split("・")[0]).join("・")}` };
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1e10) return { ok: false, error: "金額を円で指定してください。" };
  const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : toDateKey(now);
  const workKind: WorkKind = input.workKind === "reform" ? "reform" : "normal";
  // 受注の金額は税込で持つ。税抜と言われたら税込に直してから計算する
  const total = input.taxIncluded === false ? Math.round(input.amount * (1 + taxRate(date))) : Math.round(input.amount);
  const calc = calcInternalOrder(db, { total, salesDate: date, contractDate: date }, workKind);
  const same = from.id === to.id;
  const internal = same ? 0 : calc.amount;
  const rows = same
    ? [{ k0: `${to.name} (受注・施工)`, ext: total, adj: 0, mgmt: total }]
    : [
        { k0: `${from.name} (依頼した店舗)`, ext: 0, adj: internal, mgmt: internal },
        { k0: `${to.name} (施工した店舗)`, ext: total, adj: -internal, mgmt: total - internal },
      ];
  const table: AnalysisResult = {
    ok: true,
    title: `${same ? to.name : `${from.name} → ${to.name}`} ${yen(total)} の${WORK_KIND_LABEL[workKind]}の売上の配分`,
    period: { from: date, to: date, label: `${date} の設定で計算` },
    spec: { subject: "sales", title: "店舗間の売上の配分 (計算)" },
    columns: [
      { key: "k0", label: "店舗", kind: "text" },
      { key: "ext", label: "外部売上 (お客様からの売上)", kind: "yen" },
      { key: "adj", label: "内部受注の配分", kind: "yen" },
      { key: "mgmt", label: "店舗の売上 (管理会計)", kind: "yen" },
    ],
    rows,
    total: { k0: "合計", ext: total, adj: 0, mgmt: total },
    omitted: 0,
    notes: [
      same ? "同じ店舗が受注して施工したので、内部受注の配分はありません。" : `内部受注 = ${calc.explain}`,
      `${input.taxIncluded === false ? `税抜 ${yen(Math.round(input.amount))} を税込 ${yen(total)} に直して計算しました。` : "金額は税込として計算しました。"}全社の売上は ${yen(total)} のまま (二重には数えません)。`,
      calc.provisional ? "この配分率は「暫定」の設定です (管理会計 → 設定 で確定します)。" : "配分率・基準・端数は管理会計の設定 (確認済み) によります。",
    ],
  };
  const summary = same ? `${to.name} に ${yen(total)} (配分なし)` : `${from.name} ${yen(internal)} / ${to.name} ${yen(total - internal)} (合計 ${yen(total)})`;
  const text = [
    `【店舗間の売上の配分 (${WORK_KIND_LABEL[workKind]}・${date} の設定)】`,
    ...rows.map((r) => `- ${r.k0}: 外部売上 ${yen(r.ext)} / 内部受注の配分 ${r.adj >= 0 ? "+" : "−"}${yen(Math.abs(r.adj))} / 店舗の売上 ${yen(r.mgmt)}`),
    `- 合計: ${yen(total)}`,
    ...table.notes.map((n) => `注記: ${n}`),
  ].join("\n");
  return { ok: true, text, table, summary };
}

/**
 * 質問から「A 店から B 店に X 円の工事を依頼」を読み取る (読み取れたら AI に渡す前に計算しておく: 往復を 1 回減らす)。
 * 「A 店が B 店に依頼」「A 店の仕事を B 店が施工」など。読み取れないときは undefined (AI が道具で計算する)
 */
export function parseStoreSplitQuestion(db: Pick<Database, "stores">, q: string): StoreSplitInput | undefined {
  const t = q.normalize("NFKC").replace(/\s/g, "");
  if (!/(依頼|頼|振|回|任せ|施工|内部受注)/.test(t) || !/(売上|計上|配分|いくら|金額)/.test(t)) return undefined;
  const names = db.stores.flatMap((s) => [s.name.split("・")[0], s.shortName ?? ""].filter((n) => n.length >= 2).map((n) => ({ n: n.replace(/店$/, ""), id: s.id })));
  const hits: { id: string; at: number; n: string }[] = [];
  for (const x of names) {
    for (let i = t.indexOf(x.n); i >= 0; i = t.indexOf(x.n, i + 1)) if (!hits.some((h) => h.at === i)) hits.push({ id: x.id, at: i, n: x.n });
  }
  hits.sort((a, b) => a.at - b.at);
  const ids = [...new Set(hits.map((h) => h.id))];
  if (ids.length !== 2) return undefined;
  const m = /(\d+(?:[.,]\d+)*)\s*(億|万|千)?\s*円/.exec(t);
  if (!m) return undefined;
  const amount = Number(m[1].replace(/,/g, "")) * (m[2] === "億" ? 1e8 : m[2] === "万" ? 1e4 : m[2] === "千" ? 1e3 : 1);
  // 店舗の名前の後ろの助詞で、依頼した店舗と施工した店舗を決める:
  //  依頼 = 「から」「が (… に依頼)」「の仕事・案件・工事・お客様」/ 施工 = 「に」「へ」「が施工・で施工・が工事・が作業」
  const roleOf = (h: { at: number; n: string }): "from" | "to" | undefined => {
    const after = t.slice(h.at + h.n.length).replace(/^店/, "");
    if (/^(が|で)(施工|工事|作業|担当)/.test(after) || /^(に|へ)/.test(after)) return "to";
    if (/^(から|の(仕事|案件|工事|お客))/.test(after) || /^が/.test(after)) return "from";
    return undefined;
  };
  const first = hits.find((h) => h.id === ids[0])!;
  const second = hits.find((h) => h.id === ids[1])!;
  const r1 = roleOf(first);
  const r2 = roleOf(second);
  let fromId = first.id;
  let toId = second.id;
  if (r1 === "to" || r2 === "from") [fromId, toId] = [second.id, first.id];
  return {
    fromStore: fromId,
    toStore: toId,
    amount,
    workKind: /リフォーム/.test(t) ? "reform" : "normal",
    taxIncluded: /税抜|税別/.test(t) ? false : undefined,
  };
}
