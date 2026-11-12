import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { confirmDocument, discardDocument, uploadDocument } from "@/lib/actions/capture";
import { aiEnabled } from "@/lib/ai/ocr";
import { fmtDateTime, yen } from "@/lib/format";
import { DOCUMENT_KIND_LABEL, DOCUMENT_STATUS } from "@/lib/constants";
import type { DocumentKind } from "@/lib/db/types";
import { CaptureUploader } from "@/components/features/CaptureUploader";
import { Badge, Button, Card, CardHeader, Flash, LinkButton, Note, PageHeader, StatusBadge, StoreTag } from "@/components/ui";

const VALUE_LABEL: Record<string, string> = {
  cash: "現金", card: "法人カード", transfer: "振込",
  koshi: "合志店", chuo: "中央店", nishi: "西店", tamana: "玉名店", hq: "本社・坪井ショールーム",
};

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "string" && VALUE_LABEL[v]) return VALUE_LABEL[v];
  if (typeof v === "number") return v >= 1000 ? yen(v) : String(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" / ");
  return JSON.stringify(v);
}

const FIELD_LABEL: Record<string, string> = {
  customerName: "お客様名", siteAddress: "現場住所", items: "明細", subtotal: "小計", total: "合計", note: "備考", vendor: "支払先", date: "日付", amount: "金額", taxAmount: "消費税", account: "勘定科目", paymentMethod: "支払方法",
  supplier: "仕入先", invoiceNumber: "請求書番号", invoiceDate: "請求日", dueDate: "支払期限", rooms: "部屋", measurements: "採寸", summary: "概要", contractDate: "契約日", fields: "項目", storeId: "店舗",
};

export default async function CapturePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const docs = scopeByStore(user, db.documents).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const selected = docs.find((d) => d.id === sp.doc) ?? docs.find((d) => d.status === "extracted");
  const kind = (sp.kind && DOCUMENT_KIND_LABEL[sp.kind as DocumentKind] ? sp.kind : "handwritten_quote") as DocumentKind;
  const ex = (selected?.extracted ?? {}) as Record<string, unknown>;
  const items = Array.isArray(ex.items) ? (ex.items as { name: string; spec?: string; qty?: number; unit?: string; unitPrice?: number; amount?: number }[]) : null;
  const warnings = Array.isArray(ex._warnings) ? (ex._warnings as string[]) : [];
  const provider = ex._provider === "claude" ? "Claude (vision)" : "サンプル読取";
  const nextHref = selected
    ? selected.kind === "handwritten_quote" ? `/quotes/new?documentId=${selected.id}` : selected.kind === "receipt" ? `/expenses/new?documentId=${selected.id}` : selected.kind === "supplier_invoice" ? `/purchases?documentId=${selected.id}` : undefined
    : undefined;
  const linkedHref = selected?.linkedType && selected.linkedId ? `/${selected.linkedType === "quote" ? "quotes" : selected.linkedType === "expense" ? "expenses" : "purchases"}/${selected.linkedId}` : undefined;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="書類取込 (紙 → データ)" badge={<Badge tone={aiEnabled() ? "good" : "neutral"}>{aiEnabled() ? "AI 読取: 有効" : "AI 読取: サンプルモード"}</Badge>} />
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-5">
        <Card className="@3xl:col-span-2">
          <CardHeader title="1. 撮影・取込" description="タブレット・スマートフォンのカメラで撮影、または画像/PDF を選択" />
          <CaptureUploader action={uploadDocument} defaultKind={kind} stores={db.stores.map((s) => ({ id: s.id, name: s.name }))} defaultStoreId={user.storeId} canChooseStore={allStores} aiEnabled={aiEnabled()} />
        </Card>
        <Card className="@3xl:col-span-3">
          <CardHeader title="2. 読取結果の確認 → 登録" description={selected ? `${selected.fileName} · ${DOCUMENT_KIND_LABEL[selected.kind]} · ${provider} · 確度 ${Math.round((selected.confidence ?? 0) * 100)}%` : "取込済みの書類を選択してください"} action={selected && <StatusBadge value={selected.status} map={DOCUMENT_STATUS} />} />
          {!selected && <p className="py-8 text-center text-sm text-ink-3">左の手順で書類を取り込むと、ここに読取結果が表示されます</p>}
          {selected && (
            <div className="space-y-4">
              {warnings.length > 0 && <Note tone="warn">{warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</Note>}
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm @xl:grid-cols-2">
                {Object.entries(ex).filter(([k]) => !k.startsWith("_") && k !== "items").map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs text-ink-3">{FIELD_LABEL[k] ?? k}</dt>
                    <dd className="break-words text-ink">{renderValue(v)}</dd>
                  </div>
                ))}
              </dl>
              {items && (
                <table className="w-full text-sm">
                  <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-1.5 text-left font-medium">品名</th><th className="px-3 py-1.5 text-right font-medium">数量</th><th className="px-3 py-1.5 text-right font-medium">単価</th><th className="px-3 py-1.5 text-right font-medium">金額</th></tr></thead>
                  <tbody>{items.map((i, idx) => <tr key={idx} className="border-t border-line"><td className="px-3 py-1.5">{i.name}{i.spec ? <span className="ml-1 text-xs text-ink-3">{i.spec}</span> : null}</td><td className="px-3 py-1.5 text-right tnum">{i.qty ?? "-"} {i.unit ?? ""}</td><td className="px-3 py-1.5 text-right tnum">{i.unitPrice !== undefined ? yen(i.unitPrice) : "-"}</td><td className="px-3 py-1.5 text-right tnum">{yen(i.amount ?? (i.qty ?? 0) * (i.unitPrice ?? 0))}</td></tr>)}</tbody>
                </table>
              )}
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                {selected.status === "extracted" && nextHref && <LinkButton href={nextHref}>{selected.kind === "handwritten_quote" ? "見積として登録 (社内書式に変換)" : selected.kind === "receipt" ? "経費として登録" : "仕入請求書として登録"}</LinkButton>}
                {selected.status === "extracted" && !nextHref && <form action={confirmDocument.bind(null, selected.id)}><Button type="submit">読取内容を確定して保存</Button></form>}
                {selected.status === "extracted" && <form action={discardDocument.bind(null, selected.id)}><Button type="submit" variant="danger">破棄</Button></form>}
                {selected.status === "confirmed" && linkedHref && <LinkButton href={linkedHref} variant="secondary">登録先を開く →</LinkButton>}
                {selected.status === "confirmed" && !linkedHref && <span className="text-sm text-good-ink">確定済み</span>}
              </div>
              <p className="text-[11px] text-ink-3">取込: {userName(selected.uploadedBy)} · {fmtDateTime(selected.uploadedAt)} · <StoreTag store={db.stores.find((s) => s.id === selected.storeId)} short /></p>
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title="取込済み書類" description={`${docs.length} 件 · 読取完了 (確認待ち) の書類から順に処理してください`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-5 py-2 text-left font-medium">取込日時</th><th className="px-3 py-2 text-left font-medium">ファイル</th><th className="px-3 py-2 text-left font-medium">種類</th><th className="px-3 py-2 text-left font-medium">店舗</th><th className="px-3 py-2 text-left font-medium">取込者</th><th className="px-3 py-2 text-right font-medium">確度</th><th className="px-3 py-2 text-left font-medium">状態</th><th className="px-5 py-2 text-left font-medium">登録先</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className={`border-t border-line hover:bg-subtle/70 ${selected?.id === d.id ? "bg-accent-soft/40" : ""}`}>
                  <td className="px-5 py-2 text-xs tnum">{fmtDateTime(d.uploadedAt)}</td>
                  <td className="px-3 py-2"><Link href={`/capture?doc=${d.id}`} className="font-medium text-ink hover:text-accent">{d.fileName}</Link></td>
                  <td className="px-3 py-2 text-xs text-ink-2">{DOCUMENT_KIND_LABEL[d.kind]}</td>
                  <td className="px-3 py-2"><StoreTag store={db.stores.find((s) => s.id === d.storeId)} short /></td>
                  <td className="px-3 py-2 text-xs text-ink-2">{userName(d.uploadedBy)}</td>
                  <td className="px-3 py-2 text-right text-xs tnum">{d.confidence ? `${Math.round(d.confidence * 100)}%` : "-"}</td>
                  <td className="px-3 py-2"><StatusBadge value={d.status} map={DOCUMENT_STATUS} /></td>
                  <td className="px-5 py-2 text-xs">{d.linkedType && d.linkedId ? <Link href={`/${d.linkedType === "quote" ? "quotes" : d.linkedType === "expense" ? "expenses" : "purchases"}/${d.linkedId}`} className="text-accent hover:underline">{d.linkedType === "quote" ? "見積" : d.linkedType === "expense" ? "経費" : "仕入請求書"} →</Link> : <span className="text-ink-3">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
        流れ: 撮影 → AI 読取 (取引先・日付・金額・勘定科目・明細) → 担当者が確認・修正 → 見積 / 経費 / 仕入請求書として登録 → 承認 → 受注・施工・売上・請求・入金 / 経費精算・買掛・支払へ自動連動。紙を見ながらの手入力や別帳簿への転記は不要です。
      </p>
    </div>
  );
}
