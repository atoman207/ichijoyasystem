import { Button, Field, Input } from "@/components/ui";

/**
 * 入力フォームの上に置く顧客検索 (GET フォーム)。お客様の件数が多いときに、プルダウンの候補を検索語で絞る
 * keep: 画面に引き継ぐクエリ (問い合わせ ID など)
 */
export function CustomerSearch({ total, q, shown, keep }: { total: number; q?: string; shown: number; keep: Record<string, string | undefined> }) {
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-subtle p-3">
      {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <Field label={`お客様を検索 (登録 ${total.toLocaleString("ja-JP")} 件)`} hint="氏名・フリガナ・顧客コード・電話番号の一部で検索し、下の「お客様」から選びます" className="min-w-0 flex-1">
        <Input name="cq" defaultValue={q ?? ""} placeholder="例: 田中 / C-01234 / 0968" />
      </Field>
      <Button type="submit" variant="secondary">検索</Button>
      {q ? <p className="w-full text-xs text-ink-3">「{q}」に一致するお客様: {shown >= 50 ? "50 件以上 (先頭の 50 件を表示)" : `${shown} 件`}</p> : null}
    </form>
  );
}
