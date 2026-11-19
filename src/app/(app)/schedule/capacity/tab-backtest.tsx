import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageScheduling, canRunScheduleBacktest } from "@/lib/auth/permissions";
import { loadMasters } from "@/lib/scheduling/masters";
import { Card, CardHeader, Note } from "@/components/ui";
import { BacktestPanel } from "@/components/scheduling/BacktestPanel";

/** 提案の検証 (過去の予定と提案の比較・重みの調整)。計算は src/lib/scheduling/backtest.ts */
export async function BacktestTab() {
  const user = await requireUser();
  const db = getDb();
  const last = db.settings.find((s) => s.id === "scheduling_backtest")?.value as Record<string, unknown> | undefined;
  const m = loadMasters(db);
  return (
    <Card>
      <CardHeader title="提案の検証" description="過去の案件の予定で、当時の担当者が選んだ日とシステムの提案を比べます (提案の 1 位・上位 3 件との一致、移動・待ち日数・残業の目安、1 日あたりの件数)。重視する指標が良くなる重みも探します" />
      {!canRunScheduleBacktest(user) ? (
        <Note>提案の検証は管理者・本部が行います。</Note>
      ) : (
        <BacktestPanel
          stores={db.stores.filter((s) => s.kind === "store" && !s.closedOn).map((s) => ({ id: s.id, name: s.name }))}
          canApply={canManageScheduling(user)}
          focus={m.weights.focus}
          last={last ? { ranAt: String(last.ranAt ?? ""), by: String(last.by ?? ""), metrics: last.metrics as never, tuned: last.tuned as never, notes: (last.notes as string[]) ?? [] } : undefined}
        />
      )}
    </Card>
  );
}
