import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { userName } from "@/lib/db/queries";
import { canManageTidyItems } from "@/lib/auth/permissions";
import { DEFAULT_TIDY_ITEMS, tidyItemsText, tidySettings } from "@/lib/tidy";
import { saveTidyItems } from "@/lib/actions/tidy";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Field, Flash, Note, PageHeader, Textarea } from "@/components/ui";

export const metadata: Metadata = { title: "整理整頓チェックの項目" };

/** チェック項目 (管理者がまとめて差し替える。1 行 1 項目、■ で始まる行は見出し) */
export default async function TidyItemsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const s = tidySettings(db);
  const admin = canManageTidyItems(user);
  const groups = [...new Set(s.items.map((i) => i.group ?? ""))];
  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="整理整頓チェックの項目"
        badge={s.provisional ? <Badge tone="warn">暫定</Badge> : <Badge tone="good">確定</Badge>}
        description={`${s.items.length} 項目${s.updatedAt ? ` · 更新 ${fmtDateTime(s.updatedAt)} ${userName(s.updatedBy ?? "")}` : " · 初期値"}。項目を変えても、記録済みのチェックはその時の項目のまま残ります`}
        back={{ href: "/kpi/tidy", label: "整理整頓" }}
      />
      {s.provisional && <Note>いまの項目は暫定 (一般的な整理整頓の項目) です。お客様が使っているチェック項目の資料をいただいたら、下の欄に貼り付けて差し替えてください。</Note>}
      <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card>
          <CardHeader title="いまの項目" />
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g || "_"}>
                {g && <div className="mb-1 text-xs font-semibold text-ink-2">{g}</div>}
                <ol className="list-decimal space-y-0.5 pl-5 text-sm text-ink">
                  {s.items.filter((i) => (i.group ?? "") === g).map((i) => <li key={i.key}>{i.label}</li>)}
                </ol>
              </div>
            ))}
          </div>
        </Card>
        {admin ? (
          <Card>
            <CardHeader title="まとめて差し替える (管理者)" description="1 行に 1 項目。「■作業場」のように ■ で始まる行 (または【作業場】・「作業場:」) は見出しで、その下の項目をまとめます。行の頭の番号・「・」「□」は外します。同じ名前の項目はキーが同じなので、過去の記録と比べられます" />
            <form action={saveTidyItems} className="space-y-3">
              <Field label="チェック項目"><Textarea name="text" defaultValue={tidyItemsText(s.items)} rows={18} className="font-mono text-sm" /></Field>
              <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="provisional" defaultChecked={s.provisional} className="h-4 w-4" /> 暫定の項目として表示する (お客様の資料で確定したら外す)</label>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit">保存する</Button>
                <span className="text-xs text-ink-3">初期値 ({DEFAULT_TIDY_ITEMS.length} 項目) に戻すときは、初期値の内容を貼り付けて保存します</span>
              </div>
            </form>
          </Card>
        ) : (
          <Card>
            <CardHeader title="項目の変更" description="チェック項目の変更は管理者が行います" />
          </Card>
        )}
      </div>
    </div>
  );
}
