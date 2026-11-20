import type { Database } from "@/lib/db/types";
import { fmtDateTime } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { MEDIA, MEDIA_KEYS, MEDIA_MATCH_LABEL, legacyMediaValues, mediaLabel, readMediaRules } from "@/lib/media";
import { saveMediaMapping } from "@/lib/actions/promotions";
import { Button, Card, CardHeader, Note, Table, Td, Th, Tr } from "@/components/ui";

/** 全社共通の媒体の分類と、過去の値の読み替え (対応表) */
export function MappingTab({ db, canEdit }: { db: Database; canEdit: boolean }) {
  const mapping = readMediaRules(db);
  const values = legacyMediaValues(db, mapping.rules);
  const unmapped = values.filter((v) => !v.media);
  const rows = [...mapping.rules, ...Array.from({ length: 5 }, () => ({ from: "", match: "contains" as const, media: "" as const }))];
  const field = "field h-8 py-1 text-xs";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="全社共通の媒体の分類" description="問い合わせの登録で選ぶ分類 (必須。わからなければ「不明」)。顧客・アンケートも同じ分類で数えます" />
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs @xl:grid-cols-2 @4xl:grid-cols-3">
          {MEDIA_KEYS.map((k) => (
            <li key={k}><span className="font-semibold text-ink">{MEDIA[k].label}</span> <span className="text-ink-3">— {MEDIA[k].hint}</span></li>
          ))}
        </ul>
      </Card>

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-2">
        <Card>
          <CardHeader
            title="対応表 (過去の値 → 分類)"
            description="見積書の媒体欄・アンケートの ⑥・販売管理ソフトの媒体の値を、上から順に見て最初に当てはまった分類に読み替えます。「含む」は値の一部に含めば当てはまります (R・HP のような短い略号は「同じ値」に)"
          />
          {mapping.configured ? (
            mapping.updatedAt && <p className="-mt-2 mb-3 text-[11px] text-ink-3">最終更新 {fmtDateTime(mapping.updatedAt)} · {userName(mapping.updatedBy)}</p>
          ) : (
            <p className="-mt-2 mb-3 text-[11px] text-ink-3">既定の対応表を使っています</p>
          )}
          <form action={saveMediaMapping}>
            <input type="hidden" name="count" value={rows.length} />
            <div className="max-h-[560px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-panel">
                  <tr className="text-left text-[11px] text-ink-3">
                    <th className="px-1 py-1">元の値</th>
                    <th className="px-1 py-1">照合</th>
                    <th className="px-1 py-1">分類</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="px-1 py-0.5"><input name={`r_${i}_from`} defaultValue={r.from} disabled={!canEdit} className={`${field} w-full`} aria-label="元の値" placeholder={r.from ? undefined : "例: 新聞折込"} /></td>
                      <td className="px-1 py-0.5">
                        <select name={`r_${i}_match`} defaultValue={r.match} disabled={!canEdit} className={field} aria-label="照合">
                          {(Object.keys(MEDIA_MATCH_LABEL) as (keyof typeof MEDIA_MATCH_LABEL)[]).map((m) => <option key={m} value={m}>{MEDIA_MATCH_LABEL[m]}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-0.5">
                        <select name={`r_${i}_media`} defaultValue={r.media} disabled={!canEdit} className={field} aria-label="分類">
                          <option value="">選んでください</option>
                          {MEDIA_KEYS.map((k) => <option key={k} value={k}>{MEDIA[k].label}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canEdit ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm">保存する</Button>
                <Button type="submit" size="sm" variant="ghost" name="reset" value="1">既定に戻す</Button>
                <span className="text-[11px] text-ink-3">行を消すときは元の値を空にして保存します。保存すると空の行が 5 行増えます</span>
              </div>
            ) : (
              <p className="mt-3 text-xs text-ink-3">対応表の変更は本部スタッフ・管理者が行います。</p>
            )}
          </form>
        </Card>

        <Card>
          <CardHeader title="過去の値の一覧" description={`見積・受注の媒体欄、アンケート、顧客の媒体 (販売管理ソフト) にある値と、いまの対応表での分類。読み替えられない値 ${unmapped.length} 種類を上に出します`} />
          {unmapped.length > 0 && <div className="mb-3"><Note tone="warn">「未分類」の値は分析で媒体がわからない扱いになります。左の対応表に行を足して分類を決めてください。</Note></div>}
          <Table minWidth="min-w-[440px]" className="max-h-[560px] overflow-y-auto">
            <thead>
              <tr>
                <Th>値</Th>
                <Th>どこの値</Th>
                <Th align="right">件数</Th>
                <Th>分類</Th>
              </tr>
            </thead>
            <tbody>
              {values.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-ink-3">過去の媒体の値はありません</td></tr>
              )}
              {values.slice(0, 300).map((v) => (
                <Tr key={`${v.where}-${v.value}`}>
                  <Td className="text-xs">{v.value}</Td>
                  <Td className="text-[11px] text-ink-3">{v.where}</Td>
                  <Td align="right">{v.count.toLocaleString("ja-JP")}</Td>
                  <Td className={v.media ? "text-xs" : "text-xs text-warn-ink"}>{mediaLabel(v.media)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
