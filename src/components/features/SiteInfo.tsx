import type { SiteInfo } from "@/lib/db/types";
import { SITE_FIELDS, siteInfoLines } from "@/lib/site-info";
import { fmtDateTime } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { Button, Card, CardHeader } from "@/components/ui";

const chip = "inline-flex cursor-pointer items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:text-accent-ink";

/** 現場情報・引継ぎ事項の入力欄 (si_<項目名>)。フォームの中に置く */
export function SiteInfoFields({ value }: { value?: SiteInfo | Record<string, unknown> }) {
  const v = (value ?? {}) as Record<string, unknown>;
  return (
    <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
      {SITE_FIELDS.map((f) => {
        const name = `si_${f.key}`;
        const cur = v[f.key];
        const span = f.wide ? "@xl:col-span-2 @4xl:col-span-3" : "";
        if (f.type === "multi") {
          const sel = Array.isArray(cur) ? (cur as string[]) : [];
          return (
            <fieldset key={f.key} className={`min-w-0 ${span}`}>
              <legend className="label">{f.label}</legend>
              <div className="flex flex-wrap gap-1.5">
                {(f.options ?? []).map((o) => (
                  <label key={o} className={chip}>
                    <input type="checkbox" name={name} value={o} defaultChecked={sel.includes(o)} className="sr-only" />
                    {o}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        }
        return (
          <label key={f.key} className={`block min-w-0 ${span}`}>
            <span className="label">{f.label}</span>
            {f.type === "textarea" ? (
              <textarea name={name} defaultValue={typeof cur === "string" ? cur : ""} rows={2} className="field min-h-[60px]" />
            ) : f.type === "choice" ? (
              <select name={name} defaultValue={typeof cur === "string" ? cur : ""} className="field">
                <option value="">-</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input name={name} defaultValue={cur === undefined || cur === null ? "" : String(cur)} inputMode={f.type === "number" ? "decimal" : undefined} className="field" />
            )}
          </label>
        );
      })}
    </div>
  );
}

/** 現場情報・引継ぎ事項 (表示と編集) */
export function SiteInfoCard({ info, action, returnTo, canEdit, description }: { info?: SiteInfo; action: (fd: FormData) => Promise<void>; returnTo: string; canEdit: boolean; description?: string }) {
  const lines = siteInfoLines(info);
  return (
    <Card>
      <CardHeader
        title="現場情報・引継ぎ事項"
        description={description ?? "手書き見積書の 引取・納品日時、支払い方法、備考欄以下の内容です。施工担当者と共有し、予定表の施工のメモにも載ります"}
      />
      {lines.length ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm @xl:grid-cols-2">
          {lines.map(([k, v]) => (
            <div key={k} className={`min-w-0 ${v.length > 40 ? "@xl:col-span-2" : ""}`}>
              <dt className="text-[11px] text-ink-3">{k}</dt>
              <dd className="whitespace-pre-wrap break-words text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-ink-3">登録はありません。</p>
      )}
      {info?.updatedAt && <p className="mt-2 text-[11px] text-ink-3">最終更新: {userName(info.updatedBy)} {fmtDateTime(info.updatedAt)} (変更の履歴は「変更履歴」に残ります)</p>}
      {canEdit && (
        <details className="mt-3 rounded-lg border border-line px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-accent">{lines.length ? "現場情報を修正する" : "現場情報を入力する"}</summary>
          <form action={action} className="mt-3 space-y-3">
            <input type="hidden" name="returnTo" value={returnTo} />
            <SiteInfoFields value={info} />
            <Button type="submit" size="sm">保存する</Button>
          </form>
        </details>
      )}
    </Card>
  );
}
