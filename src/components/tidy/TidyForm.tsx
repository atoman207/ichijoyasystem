import type { Database, TidyCheck, User } from "@/lib/db/types";
import { canRecordTidyCheck } from "@/lib/auth/permissions";
import { TIDY_RESULT, TIDY_RESULTS, tidySettings, type TidyItemDef } from "@/lib/tidy";
import type { HeldLinePhoto } from "@/lib/line-photos";
import { toDateKey } from "@/lib/format";
import { LinePhotoChecks } from "@/components/case-posts/CasePostParts";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Textarea } from "@/components/ui";

const RESULT_CLASS: Record<string, string> = {
  ok: "has-[:checked]:border-good has-[:checked]:bg-good-soft has-[:checked]:text-good-ink",
  ng: "has-[:checked]:border-serious has-[:checked]:bg-serious-soft has-[:checked]:text-serious-ink",
  na: "has-[:checked]:border-line-strong has-[:checked]:bg-subtle has-[:checked]:text-ink",
};

/**
 * 整理整頓チェックの入力 (記録・修正で共通)。スマートフォンで押しやすいよう、項目ごとに 良い / 要改善 / 対象外 の大きなボタン。
 * 修正のときは前の記録の項目 (設定から外れた項目を含む) と結果を出す
 */
export function TidyForm({ db, user, action, check, linePhotos = [], submitLabel }: { db: Database; user: User; action: (fd: FormData) => Promise<void>; check?: TidyCheck; linePhotos?: HeldLinePhoto[]; submitLabel: string }) {
  const settings = tidySettings(db);
  const stores = db.stores.filter((s) => canRecordTidyCheck(user, s.id));
  const defaultStore = check?.storeId ?? (stores.some((s) => s.id === user.storeId) ? user.storeId : stores[0]?.id);
  const staff = db.users.filter((u) => u.active && u.signupStatus !== "pending" && !u.id.startsWith("u_review_")).sort((a, b) => Number(b.id === user.id) - Number(a.id === user.id) || a.name.localeCompare(b.name, "ja"));
  const defs: (TidyItemDef & { result?: string; note?: string; dueDate?: string; old?: boolean })[] = settings.items.map((d) => {
    const prev = check?.items.find((i) => i.key === d.key);
    return { ...d, label: prev?.label ?? d.label, result: prev?.result, note: prev?.note, dueDate: prev?.dueDate };
  });
  for (const i of check?.items ?? []) if (!defs.some((d) => d.key === i.key)) defs.push({ key: i.key, label: i.label, group: i.group, result: i.result, note: i.note, dueDate: i.dueDate, old: true });
  const groups = [...new Set(defs.map((d) => d.group ?? ""))];
  return (
    <form action={action} className="space-y-4">
      {settings.provisional && <Note>いまのチェック項目は暫定です (一般的な整理整頓の項目)。お客様が使っているチェック項目の資料をいただいたら、管理者が差し替えます。</Note>}
      <Card>
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
          <Field label="店舗" required>
            <Select name="storeId" defaultValue={defaultStore} required>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="チェックした日" required><Input type="date" name="date" defaultValue={check?.date ?? toDateKey(new Date())} max={toDateKey(new Date())} required /></Field>
          <Field label="チェックした人">
            <Select name="checkedBy" defaultValue={check?.checkedBy ?? user.id}>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="場所 (任意)" hint="例: 作業場・店頭・車両"><Input name="place" defaultValue={check?.place ?? ""} maxLength={60} /></Field>
        </div>
      </Card>
      {groups.map((g) => (
        <Card key={g || "_"} padded={false}>
          <div className="px-4 pt-4 @xl:px-5"><CardHeader title={g || "項目"} className="mb-2" /></div>
          <ul className="divide-y divide-line">
            {defs.filter((d) => (d.group ?? "") === g).map((d) => (
              <li key={d.key} className="px-4 py-3 @xl:px-5">
                <div className="mb-2 text-sm text-ink">{d.label}{d.old && <Badge tone="neutral" dot={false} className="ml-1">いまの項目にない</Badge>}</div>
                <div className="grid grid-cols-3 gap-1.5 @xl:max-w-md" role="radiogroup" aria-label={d.label}>
                  {TIDY_RESULTS.map((r) => (
                    <label key={r} className={`flex h-11 cursor-pointer items-center justify-center rounded-xl border border-line bg-panel text-sm font-medium text-ink-2 ${RESULT_CLASS[r]}`}>
                      <input type="radio" name={`r_${d.key}`} value={r} defaultChecked={d.result === r} required className="sr-only" />
                      {TIDY_RESULT[r].label}
                    </label>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-1 gap-1.5 @xl:grid-cols-[1fr_170px]">
                  <input name={`n_${d.key}`} defaultValue={d.note ?? ""} maxLength={300} placeholder="メモ (要改善の内容など・任意)" className="field h-9 py-1 text-sm" aria-label={`${d.label} のメモ`} />
                  <label className="flex items-center gap-1.5 text-[11px] text-ink-3">
                    直す期限
                    <input type="date" name={`d_${d.key}`} defaultValue={d.dueDate ?? ""} className="field h-9 flex-1 py-1 text-sm" aria-label={`${d.label} を直す期限 (要改善のとき)`} />
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <Card>
        <Field label="全体のコメント (任意)"><Textarea name="comment" defaultValue={check?.comment ?? ""} rows={3} maxLength={2000} placeholder="気づいたこと・次回までにすること" /></Field>
      </Card>
      {!check && linePhotos.length > 0 && (
        <Card>
          <CardHeader title={`LINE の「整理整頓の確認」グループの写真 (${linePhotos.length} 枚)`} description="このチェックの写真にするものを選んでください。ほかの写真は記録のあとの画面で追加できます" />
          <LinePhotoChecks items={linePhotos.slice(0, 60)} name="lineRefs" stores={db.stores} />
        </Card>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit">{submitLabel}</Button>
        <span className="text-xs text-ink-3">項目ごとに「良い」「要改善」「対象外」のどれかを選んでください。点数 = 良い ÷ (良い + 要改善) × 100</span>
      </div>
    </form>
  );
}
