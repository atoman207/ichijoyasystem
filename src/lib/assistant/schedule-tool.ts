import "server-only";
import type { Database, ScheduleKind, StoreId, User } from "@/lib/db/types";
import type { ToolDef } from "@/lib/ai/provider";
import { SCHEDULE_KIND } from "@/lib/constants";
import { fmtDate } from "@/lib/format";
import { SUGGEST_KINDS } from "@/lib/schedule-capacity";
import { suggestScheduleDates, type SuggestSlot } from "@/lib/schedule-suggest";

/**
 * AI アシスタントの道具「予定の候補日の提案」(suggest_schedule)。
 * 計算は src/lib/schedule-suggest.ts (店舗の 1 日の受け入れ量・畳の製造能力・担当者の空き・現場の距離と移動時間。AI は使わない)
 */
export interface ScheduleSuggestTool {
  def: ToolDef;
  run: (db: Database, user: User, args: Record<string, unknown>, now: Date) => { text: string; summary: string; href?: string };
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

export const scheduleSuggestTool: ScheduleSuggestTool | null = {
  def: {
    name: "suggest_schedule",
    description: `新しい案件・訪問の予定の候補日を提案する (会社全体の生産性が高くなる日)。店舗の 1 日の受け入れ量・畳の製造能力・担当者の空き・近くの現場 (移動時間) を考えて点数をつける。種類: ${SUGGEST_KINDS.map((k) => `${k}=${SCHEDULE_KIND[k].label}`).join(", ")}。受注番号 (orderId) や顧客 (customerId) が分かれば渡す (現場の住所・畳の枚数を読み取る)。`,
    parameters: {
      type: "object",
      properties: {
        store: { type: "string", description: "店舗 (id または名前。省略 = 質問した人の店舗)" },
        kind: { type: "string", enum: SUGGEST_KINDS },
        order: { type: "string", description: "受注の ID または番号 (O-2026-0012)" },
        customer: { type: "string", description: "顧客の ID またはコード" },
        address: { type: "string", description: "現場の住所・地名" },
        tatami_count: { type: "integer", description: "畳の枚数" },
        staff_count: { type: "integer", description: "必要な人数" },
        days: { type: "integer", description: "日数 (複数日の施工)" },
        slot: { type: "string", enum: ["am", "pm", "day"] },
        from: { type: "string", description: "探す期間の始まり YYYY-MM-DD" },
        to: { type: "string", description: "探す期間の終わり YYYY-MM-DD" },
        limit: { type: "integer", description: "候補の数 (既定 5)" },
      },
      required: ["kind"],
    },
  },
  run(db, user, a, now) {
    const storeArg = str(a.store);
    const store = storeArg ? db.stores.find((s) => s.id === storeArg || s.name.includes(storeArg) || storeArg.includes(s.shortName)) : undefined;
    const kind = (SUGGEST_KINDS as string[]).includes(String(a.kind)) ? (a.kind as ScheduleKind) : undefined;
    if (!kind) return { text: `予定の種類を ${SUGGEST_KINDS.join("・")} から選んでください。`, summary: "種類が不明" };
    const orderRef = str(a.order);
    const order = orderRef ? db.orders.find((o) => o.id === orderRef || o.number.toUpperCase() === orderRef.toUpperCase()) : undefined;
    const custRef = str(a.customer);
    const customer = custRef ? db.customers.find((c) => c.id === custRef || c.code.toUpperCase() === custRef.toUpperCase()) : undefined;
    const storeId: StoreId = store?.id ?? order?.storeId ?? customer?.storeId ?? user.storeId;
    const r = suggestScheduleDates(
      db,
      user,
      {
        storeId,
        kind,
        orderId: order?.id,
        customerId: customer?.id ?? order?.customerId,
        address: str(a.address),
        tatamiCount: num(a.tatami_count),
        staffCount: num(a.staff_count),
        durationDays: num(a.days),
        slot: (["am", "pm", "day"] as const).find((s) => s === a.slot) as SuggestSlot | undefined,
        from: str(a.from, 10),
        to: str(a.to, 10),
        limit: Math.min(10, num(a.limit) ?? 5),
      },
      now,
    );
    const storeName = db.stores.find((s) => s.id === storeId)?.name ?? storeId;
    const slotLabel = (s?: SuggestSlot) => (s === "am" ? "午前" : s === "pm" ? "午後" : "終日");
    const lines = [
      `${storeName} の ${SCHEDULE_KIND[kind].label} の候補日 (${r.candidates.length} 件${r.window ? ` / 探した期間 ${r.window.from}〜${r.window.to}` : ""}${r.site ? ` / 現場 ${r.site.label}` : ""}${r.tatamiCount ? ` / 畳 ${r.tatamiCount} 枚` : ""})`,
      ...r.candidates.map(
        (c, i) =>
          `${i + 1}. ${fmtDate(c.date, { weekday: true })}${c.endDate && c.endDate !== c.date ? `〜${fmtDate(c.endDate)}` : ""} ${c.startTime ? `${c.startTime}${c.endTime ? `-${c.endTime}` : ""}` : slotLabel(c.slot)} 点数 ${c.score} 担当 ${(c.assigneeNames ?? c.assigneeIds).join("・") || "未定"}${c.travelMin !== undefined ? ` 移動 約${c.travelMin}分` : ""}\n   理由: ${c.reasons.join(" / ")}${c.warnings.length ? `\n   注意: ${c.warnings.join(" / ")}` : ""}`,
      ),
      ...(r.notes.length ? [`注記: ${r.notes.join(" / ")}`] : []),
      "予定の登録は 予定表 →「予定を登録」の画面で行います (この AI は登録しません)。",
    ];
    const first = r.candidates[0]?.date;
    return { text: lines.join("\n"), summary: `${storeName} ${SCHEDULE_KIND[kind].label} → ${r.candidates.length} 件`, href: first ? `/schedule?date=${first}` : "/schedule" };
  },
};
