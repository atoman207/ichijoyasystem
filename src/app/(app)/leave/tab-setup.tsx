import { canManageLeaveGrants, canManageLeaveSettings } from "@/lib/auth/permissions";
import { fmtDays, OPENING_COLUMNS } from "@/lib/hr/leave";
import { importLeaveBalances, saveLeaveRules } from "@/lib/actions/leave";
import { Button, Card, CardHeader, Field, Input, Note, Select, Textarea } from "@/components/ui";
import type { Ctx } from "./parts";

/** 切り替え時点の残日数の取込 (本部・管理者) と、有給・振休のルール (管理者) */
export function SetupTab({ ctx }: { ctx: Ctx }) {
  const { user, settings } = ctx;
  const hidden = <input type="hidden" name="returnTo" value={ctx.returnTo} />;
  return (
    <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
      {canManageLeaveGrants(user) && (
        <Card>
          <CardHeader
            title="切り替え時点の残日数の取込"
            description="有給管理表 (社員ごとのシート) の「本年基準日」「当年度分の残日数」「繰越分の残日数」と、休日出勤管理表の未取得の振休を、社員 1 人 1 行で貼り付けます。同じ社員をもう一度取り込むと、前回の取込分を置き換えます"
          />
          <form action={importLeaveBalances} className="space-y-2">
            {hidden}
            <div className="rounded-lg border border-line bg-subtle/60 px-3 py-2 text-xs text-ink-2">
              列の順番: {OPENING_COLUMNS.map((c, i) => `${i + 1}. ${c}`).join("　")}
              <div className="mt-1 text-ink-3">例 (タブ区切り・カンマ区切りどちらでも。見出しの行は読み飛ばします): 山田 太郎, 2026/3/12, 16, 15, 2026/11/30, 1.5</div>
              <div className="mt-1 text-ink-3">日数は 0.5 日単位。社員は氏名 (空白は無視)・名字だけ (同じ名字がいなければ)・ログイン ID で指定できます。有効期限は当年度分 = 本年基準日から 2 年、繰越分 = 前年の基準日から 2 年です。</div>
            </div>
            <Field label="貼り付け"><Textarea name="text" rows={8} placeholder={"社員\t本年基準日\t当年度分の残\t繰越分の残\t時点\t振休の残"} /></Field>
            <Field label="または CSV ファイル (UTF-8・Shift_JIS)"><Input type="file" name="file" accept=".csv,text/csv,text/plain" /></Field>
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <input type="checkbox" name="dryRun" value="1" defaultChecked /> 確認だけ (保存しない。読み取りの結果を表示)
            </label>
            {ctx.ready ? <Button type="submit" size="sm">取り込む</Button> : <Note tone="warn">データベースに有給・休日出勤の表がまだないため、取り込めません (デプロイ後に使えます)。</Note>}
          </form>
        </Card>
      )}
      <Card>
        <CardHeader title="有給・振休のルール" description={canManageLeaveSettings(user) ? "管理者が変更できます。変更は変更履歴に残ります" : "変更は管理者が行います"} />
        <form action={saveLeaveRules} className="space-y-2">
          {hidden}
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
            <Field label="振休のため込みの上限 (日)" hint="社内規定「振休ため込みは 3 日まで」。超えると一覧で警告します">
              <Input type="number" name="compLimit" step="0.5" min="0" max="60" defaultValue={settings.compLimit} disabled={!canManageLeaveSettings(user)} />
            </Field>
            <Field label="有給の消化の順番" hint="有給管理表の注記は「当年度分から消化」">
              <Select name="consumeOrder" defaultValue={settings.consumeOrder} disabled={!canManageLeaveSettings(user)}>
                <option value="oldest">期限の早い (古い) 付与から</option>
                <option value="newest">当年度分 (新しい付与) から</option>
              </Select>
            </Field>
            <Field label="年度の始まりの月">
              <Select name="fiscalStartMonth" defaultValue={String(settings.fiscalStartMonth)} disabled={!canManageLeaveSettings(user)}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m} 月</option>)}
              </Select>
            </Field>
            <Field label="勤怠の締め日" hint="31 = 月末締め">
              <Input type="number" name="closingDay" min="1" max="31" defaultValue={settings.closingDay} disabled={!canManageLeaveSettings(user)} />
            </Field>
            <Field label="午前休の時間帯">
              <div className="flex items-center gap-1">
                <Input type="time" name="amStart" defaultValue={settings.amStart} disabled={!canManageLeaveSettings(user)} />〜
                <Input type="time" name="amEnd" defaultValue={settings.amEnd} disabled={!canManageLeaveSettings(user)} />
              </div>
            </Field>
            <Field label="午後休の時間帯">
              <div className="flex items-center gap-1">
                <Input type="time" name="pmStart" defaultValue={settings.pmStart} disabled={!canManageLeaveSettings(user)} />〜
                <Input type="time" name="pmEnd" defaultValue={settings.pmEnd} disabled={!canManageLeaveSettings(user)} />
              </div>
            </Field>
          </div>
          <p className="text-xs text-ink-3">
            半日の休暇は、予定表にこの時間帯の「休暇」として載り、同じ時間帯の予定と重複の警告になります。有給の有効期限は付与から 2 年、付与日数の目安は法定 (勤続 6 か月 10 日・1 年 6 か月 11 日・… 6 年 6 か月以上 20 日) です。現在の上限: 振休 {fmtDays(settings.compLimit)}。
          </p>
          {canManageLeaveSettings(user) && ctx.ready && <Button type="submit" size="sm" variant="secondary">ルールを保存</Button>}
        </form>
      </Card>
    </div>
  );
}
