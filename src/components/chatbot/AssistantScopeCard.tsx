import { Card, CardHeader, Badge, Button, Field, Input, Note } from "@/components/ui";
import type { Database } from "@/lib/db/types";
import { assistantAllStores, assistantScope } from "@/lib/assistant/scope";
import { setAssistantScope } from "@/lib/actions/assistant-scope";

/** AI アシスタントの閲覧範囲 (権限どおり / 全店舗) の設定 (管理者。AI アシスタント →「チャットボットの管理」) */
export function AssistantScopeCard({ db }: { db: Database }) {
  const s = assistantScope(db);
  const active = assistantAllStores(db);
  const by = s.updatedBy ? db.users.find((u) => u.id === s.updatedBy)?.name : undefined;
  return (
    <Card>
      <CardHeader
        title="AI アシスタントの閲覧範囲"
        description="店舗のロールの人が AI アシスタントに聞いたとき、どの店舗のデータまで調べて答えるか"
        action={<Badge tone={active ? "warn" : "good"}>{active ? `全店舗${s.until ? ` (${s.until} まで)` : ""}` : s.mode === "all_stores" ? "権限どおり (終了日を過ぎました)" : "権限どおり"}</Badge>}
      />
      <form action={setAssistantScope} className="space-y-3 text-sm">
        <fieldset className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">
          <label className="flex gap-2 rounded-lg border border-line p-2.5">
            <input type="radio" name="mode" value="permission" defaultChecked={!active} className="mt-1" />
            <span>
              <strong>権限どおり (おすすめ)</strong>
              <span className="block text-xs text-ink-2">店長・店舗スタッフは自店舗のデータだけ。管理者・本部スタッフは全店舗。</span>
            </span>
          </label>
          <label className="flex gap-2 rounded-lg border border-line p-2.5">
            <input type="radio" name="mode" value="all_stores" defaultChecked={active} className="mt-1" />
            <span>
              <strong>全店舗 (テスト期間など)</strong>
              <span className="block text-xs text-ink-2">全員が、AI アシスタントで全店舗の顧客・案件・予定・売上を調べられます。</span>
            </span>
          </label>
        </fieldset>
        <Field label="全店舗にする最終日 (空欄 = 戻すまで)" hint="この日を過ぎると、自動で権限どおりに戻ります">
          <Input type="date" name="until" defaultValue={s.until ?? ""} className="max-w-48" />
        </Field>
        <Note tone="warn">
          全店舗にしても変わらないもの: 画面で見られる範囲、登録・変更・承認の権限、AI からの実行 (確認のカード)、ほかの人の相談の履歴、社内資料の公開範囲、管理会計 (社外秘)。変更は変更履歴に残ります。
        </Note>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">保存</Button>
          {by && <span className="text-xs text-ink-3">最後の変更: {by}{s.updatedAt ? ` (${s.updatedAt.slice(0, 10)})` : ""}</span>}
        </div>
      </form>
    </Card>
  );
}
