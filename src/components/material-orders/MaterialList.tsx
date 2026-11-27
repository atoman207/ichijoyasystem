import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CheckCircle2, FileImage, TriangleAlert } from "lucide-react";
import type { Database, User } from "@/lib/db/types";
import { canEditMaterialOrder } from "@/lib/auth/permissions";
import { deleteMaterialRow, saveMaterialRow, setMaterialStatus } from "@/lib/actions/material-orders";
import { MATERIAL_CATEGORY, MATERIAL_STATUS, MATERIAL_STATUSES, groupByCase, needDate, type MaterialRow } from "@/lib/material-orders/plan";
import { ATTACHMENT_CATEGORY } from "@/lib/attachment-category";
import { shortDate } from "@/lib/calendar";
import { fmtDateTime } from "@/lib/format";
import { caseDatesText, caseFiles, printSheetOf } from "@/lib/material-orders/print-sheet";
import { MaterialPrintButton } from "./MaterialPrint";
import { PendingButton } from "@/components/ui/PendingButton";
import { StatusBadge, StoreTag, buttonClass } from "@/components/ui";

/**
 * 材料発注の行 (案件ごと)。材料発注の一覧 (/material-orders) と案件・受注の画面の「材料の発注」で共通 (お客様のご要望 2026-11-27「■4」「■5」)。
 * 未発注は赤 (必要な日が 3 日以内は「急ぎ」)、発注済みは緑。「発注済み」を押すと押した人が発注者になる。
 * showCase = 案件の見出し (店舗・お客様・日程・見積・手書き見積書の原本・現場図面) を出す (一覧)。
 * 案件ごとに「見積・図面を印刷」(見積の内容・発注する材料・手書き見積書の原本・現場図面をその場で印刷。お客様のご要望 2026-11-27)
 */
export function MaterialList({ db, user, rows, returnTo, showCase }: { db: Database; user: User; rows: MaterialRow[]; returnTo: string; showCase: boolean }) {
  const name = (id?: string) => (id ? (db.users.find((u) => u.id === id)?.name ?? "-") : "-");
  if (!rows.length) return <p className="text-sm text-ink-3">該当する材料はありません。</p>;
  return (
    <div className="space-y-3">
      {groupByCase(rows).map((g) => {
        const r0 = g.rows[0];
        const canEdit = canEditMaterialOrder(user, r0.storeId);
        const open = g.rows.filter((r) => r.status === "unordered");
        return (
          <div key={g.key} className={clsx("rounded-xl border bg-panel", open.some((r) => r.urgent) ? "border-critical/50" : open.length ? "border-warn/40" : "border-line")}>
            {showCase ? (
              <CaseHead db={db} row={r0} rows={g.rows} />
            ) : (
              r0.orderId && (
                <div className="flex justify-end border-b border-line px-3 py-1.5">
                  <MaterialPrintButton sheet={printSheetOf(db, r0, g.rows)} />
                </div>
              )
            )}
            <ul className="divide-y divide-line">
              {g.rows.map((r) => (
                <MaterialRowView key={r.key} r={r} canEdit={canEdit} returnTo={returnTo} orderedByName={name(r.orderedBy)} />
              ))}
            </ul>
            {canEdit && open.length > 1 && (
              <form action={setMaterialStatus} className="border-t border-line px-3 py-2">
                <input type="hidden" name="returnTo" value={returnTo} />
                <input type="hidden" name="status" value="ordered" />
                {open.map((r) => (
                  <input key={r.key} type="hidden" name="key" value={r.key} />
                ))}
                <PendingButton type="submit" className={buttonClass("secondary", "sm")}>
                  この案件の未発注 {open.length} 件をまとめて発注済みにする
                </PendingButton>
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 案件の見出し: 店舗・お客様・案件・日程と、発注に必要な情報 (見積の明細・手書き見積書の原本・現場図面・採寸図) をその場で */
function CaseHead({ db, row, rows }: { db: Database; row: MaterialRow; rows: MaterialRow[] }) {
  const store = db.stores.find((s) => s.id === row.storeId);
  const quote = row.quoteId ? db.quotes.find((q) => q.id === row.quoteId) : undefined;
  const order = row.orderId ? db.orders.find((o) => o.id === row.orderId) : undefined;
  // 手書き見積書の原本 (取込書類の写真) と、案件の現場図面・採寸図・資料
  const { originals, drawings } = caseFiles(db, quote, order);
  const dates = caseDatesText(row);
  return (
    <div className="border-b border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <StoreTag store={store} short />
        {row.orderId ? (
          <Link href={`/orders/${row.orderId}#materials`} className="font-semibold text-ink hover:underline">
            {row.customerName ? `${row.customerName} 様` : ""} {row.caseTitle} <span className="text-xs font-normal text-ink-3">({row.orderNumber})</span>
          </Link>
        ) : (
          <span className="font-semibold text-ink">案件なし (在庫補充など)</span>
        )}
        {dates && <span className="text-xs text-ink-2">{dates}</span>}
        {row.orderId && (quote || originals.length > 0 || drawings.length > 0) && (
          <span className="ml-auto">
            <MaterialPrintButton sheet={printSheetOf(db, row, rows)} />
          </span>
        )}
      </div>
      {(quote || originals.length > 0 || drawings.length > 0) && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-accent">見積の内容・手書き見積書の原本・現場図面を見る</summary>
          <div className="mt-2 space-y-2">
            {quote && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-xs">
                  <thead className="text-left text-ink-3">
                    <tr>
                      <th className="py-1 pr-2">品名</th>
                      <th className="py-1 pr-2">仕様</th>
                      <th className="py-1 pr-2 text-right">数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.items.map((it) => (
                      <tr key={it.id} className="border-t border-line/60">
                        <td className="py-1 pr-2 text-ink">{it.name}</td>
                        <td className="py-1 pr-2 text-ink-2">{it.spec}</td>
                        <td className="py-1 pr-2 text-right whitespace-nowrap tabular-nums">
                          {it.qty}
                          {it.unit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Link href={`/quotes/${quote.id}`} className="text-xs text-accent hover:underline">
                  見積 {quote.number} を開く
                </Link>
                {quote.siteInfo && (quote.siteInfo.remarks || quote.siteInfo.sizes || quote.siteInfo.pickupAt || quote.siteInfo.deliveryAt) && <p className="mt-1 text-[11px] text-ink-2">現場の情報: {[quote.siteInfo.pickupAt && `引取 ${quote.siteInfo.pickupAt}`, quote.siteInfo.deliveryAt && `納品 ${quote.siteInfo.deliveryAt}`, quote.siteInfo.sizes && `サイズ ${quote.siteInfo.sizes}`, quote.siteInfo.remarks].filter(Boolean).join(" / ")}</p>}
              </div>
            )}
            {(originals.length > 0 || drawings.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {[...originals.map((a) => ({ a, label: "手書き見積書の原本" })), ...drawings.map((a) => ({ a, label: a.category ? ATTACHMENT_CATEGORY[a.category].short : "資料" }))].map(({ a, label }) => (
                  <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" className="group block w-28 rounded-lg border border-line p-1 text-[10px] text-ink-2 hover:border-accent">
                    {a.kind === "photo" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/attachments/${a.id}?size=thumb`} alt={label} loading="lazy" className="aspect-[4/3] w-full rounded object-cover" />
                    ) : (
                      <span className="flex aspect-[4/3] w-full items-center justify-center rounded bg-subtle">
                        <FileImage className="h-6 w-6 text-ink-3" />
                      </span>
                    )}
                    <span className="mt-0.5 block truncate">{label}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function MaterialRowView({ r, canEdit, returnTo, orderedByName }: { r: MaterialRow; canEdit: boolean; returnTo: string; orderedByName: string }) {
  const need = needDate(r);
  const unordered = r.status === "unordered";
  return (
    <li className={clsx("px-3 py-2", unordered && (r.urgent ? "bg-critical-soft/50" : "bg-warn-soft/25"))} data-testid="material-row">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge value={r.status} map={MATERIAL_STATUS} />
            {r.urgent && <span className="rounded bg-critical px-1.5 text-[10px] font-bold text-white">急ぎ</span>}
            <span className="font-medium text-ink">{r.name}</span>
            {r.code && <span className="rounded bg-subtle px-1.5 font-mono text-xs text-ink">{r.code}</span>}
            <span className="text-[11px] text-ink-3">{MATERIAL_CATEGORY[r.category]}{r.source === "ai" ? " · 写真から読み取り" : r.source === "manual" ? " · 手入力" : " · 見積から自動"}</span>
          </div>
          <div className="mt-0.5 text-xs text-ink-2">
            必要数量 {r.qtyAuto !== undefined ? `${r.qtyAuto}${r.unit ?? ""}` : "-"}
            {r.qtyEdited && (
              <span className="ml-1 font-semibold text-ink">
                → 発注 {r.qty}
                {r.unit ?? ""}
              </span>
            )}
            {!r.qtyEdited && r.qtyAuto === undefined && r.qty !== undefined && <span className="ml-1 font-semibold text-ink">発注 {r.qty}{r.unit ?? ""}</span>}
            {need && <span className="ml-2">必要な日 {shortDate(need)}</span>}
            {r.supplierName && <span className="ml-2">発注先 {r.supplierName}</span>}
          </div>
          {r.spec && <div className="mt-0.5 text-[11px] text-ink-3">{r.spec}</div>}
          {r.note && <div className="mt-0.5 text-[11px] text-ink-2">メモ: {r.note}</div>}
          {r.status === "ordered" && (
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-good-ink">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              発注者 {orderedByName} · {r.orderedAt ? fmtDateTime(r.orderedAt) : ""}
            </div>
          )}
          {r.warnings.map((w) => (
            <div key={w} className="mt-0.5 flex items-center gap-1 text-[11px] text-warn-ink">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
              {w}
            </div>
          ))}
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-1.5">
            {r.status !== "ordered" && (
              <form action={setMaterialStatus}>
                <input type="hidden" name="returnTo" value={returnTo} />
                <input type="hidden" name="key" value={r.key} />
                <input type="hidden" name="status" value="ordered" />
                <PendingButton type="submit" className={buttonClass("primary", "sm")}>
                  発注済み
                </PendingButton>
              </form>
            )}
          </div>
        )}
      </div>
      {canEdit && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-accent">状況・数量を変える{r.source !== "auto" ? "・内容を直す" : ""}</summary>
          <form action={saveMaterialRow} className="mt-2 grid grid-cols-1 gap-2 @xl:grid-cols-3">
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="key" value={r.key} />
            <label className="block">
              <span className="text-[11px] text-ink-3">発注状況</span>
              <select name="status" defaultValue={r.status} className="field h-9 py-1 text-sm">
                {MATERIAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {MATERIAL_STATUS[s].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-3">発注数量{r.qtyAuto !== undefined ? ` (必要数量 ${r.qtyAuto})` : ""}</span>
              <input name="qty" defaultValue={r.qty ?? ""} inputMode="decimal" className="field h-9 py-1 text-sm" />
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-3">必要な日 (空 = 納品・工事の日)</span>
              <input type="date" name="neededBy" defaultValue={r.neededBy ?? ""} className="field h-9 py-1 text-sm" />
            </label>
            {r.source !== "auto" && (
              <>
                <label className="block">
                  <span className="text-[11px] text-ink-3">材料名</span>
                  <input name="name" defaultValue={r.name} className="field h-9 py-1 text-sm" />
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-3">品番</span>
                  <input name="code" defaultValue={r.code ?? ""} className="field h-9 py-1 text-sm" />
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-3">単位</span>
                  <input name="unit" defaultValue={r.unit ?? ""} className="field h-9 py-1 text-sm" />
                </label>
                <label className="block @xl:col-span-3">
                  <span className="text-[11px] text-ink-3">寸法・施工箇所など</span>
                  <input name="spec" defaultValue={r.spec ?? ""} className="field h-9 py-1 text-sm" />
                </label>
              </>
            )}
            <label className="block">
              <span className="text-[11px] text-ink-3">発注先・外注業者</span>
              <input name="supplierName" defaultValue={r.supplierName ?? ""} className="field h-9 py-1 text-sm" />
            </label>
            <label className="block @xl:col-span-2">
              <span className="text-[11px] text-ink-3">メモ</span>
              <input name="note" defaultValue={r.note ?? ""} className="field h-9 py-1 text-sm" />
            </label>
            <div className="flex flex-wrap items-center gap-2 @xl:col-span-3">
              <PendingButton type="submit" className={buttonClass("secondary", "sm")}>
                保存
              </PendingButton>
            </div>
          </form>
          {r.source !== "auto" && r.id && (
            <form action={deleteMaterialRow} className="mt-1">
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="key" value={r.key} />
              <button type="submit" className="text-[11px] text-critical hover:underline">
                この材料を削除
              </button>
            </form>
          )}
        </details>
      )}
    </li>
  );
}
