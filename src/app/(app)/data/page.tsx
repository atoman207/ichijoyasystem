import type { Metadata } from "next";
import { ArrowRightLeft, Download, FileSpreadsheet, Receipt } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canExportData, canImportData, canReviewCarryover } from "@/lib/auth/permissions";
import { IMPORT_SPEC, type ImportTarget } from "@/lib/data-io-spec";
import { fmtDateTime } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { AUDIT_ACTION_LABEL } from "@/lib/constants";
import { Badge, Card, CardHeader, Note, PageHeader, Select } from "@/components/ui";
import { ImportWizard } from "@/components/features/ImportWizard";
import { googleSheetsStatus } from "@/lib/google/sheets";
import { SalesLedgerImport } from "@/components/features/SalesLedgerImport";
import Link from "@/components/ui/Link";
import { isTestWeekDb } from "@/lib/carryover-server";
import { SalesReconcile } from "@/components/features/SalesReconcile";

export const metadata: Metadata = { title: "データ入出力" };

const EXPORTS = [
  { type: "customers", label: "顧客", desc: "取込と同じ見出し (編集してそのまま取り込めます)" },
  { type: "inquiries", label: "問い合わせ", desc: "受付日時・経路・担当者・状態・顧客コード" },
  { type: "orders", label: "受注・施工", desc: "契約日・金額・状態・施工予定・施工担当" },
  { type: "sales", label: "月次売上", desc: "直近 12 か月・店舗別 (店舗の絞り込みなし)" },
  { type: "db", label: "全データ (JSON)", desc: "保管・分析用。パスワードは含みません" },
] as const;

export default async function DataIoPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const { store } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  if (!canExportData(user) && !canImportData(user)) {
    return (
      <div>
        <PageHeader title="データ入出力" />
        <Note>データの取込・書き出しは管理者・本部スタッフが行います。必要な場合は本部へ依頼してください。</Note>
      </div>
    );
  }
  const storeId = db.stores.some((s) => s.id === store) ? store : "";
  const q = storeId ? `&store=${storeId}` : "";
  const history = db.auditLogs.filter((l) => l.entity === "data" && (l.action === "import" || l.action === "export")).slice(-15).reverse();

  return (
    <div>
      <PageHeader
        title="データ入出力"
        description="CSV ファイル・Google スプレッドシートからの取込と、CSV での書き出し。取込・書き出しは変更履歴に記録されます"
      />

      {isTestWeekDb(db) && canReviewCarryover(user) && (
        <Card className="mb-4">
          <CardHeader title="本番への引き継ぎ (試験期間 11/23〜11/30)" icon={<ArrowRightLeft />} description="試験期間に登録した問い合わせ・見積などのうち、12 月 1 日以降の本番に引き継ぐものを確かめて、11/30 に最終判断します" />
          <Link href="/data/carryover" className="text-sm text-accent hover:underline">引き継ぐ記録の一覧を開く</Link>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          <Card>
            <CardHeader title="取り込む (CSV・Google スプレッドシート)" icon={<FileSpreadsheet />} description="内容を確認してから取り込みます。確認の段階ではデータは変わりません" />
            {canImportData(user) ? <ImportWizard serviceAccountEmail={googleSheetsStatus().email} /> : <Note>取込は管理者・本部スタッフが行います。</Note>}
          </Card>

          <Card>
            <CardHeader
              title="売上明細の取込 (販売管理ソフト)"
              icon={<Receipt />}
              description="顧客は得意先コード、売上は伝票№で登録・更新し、売上台帳から移行した受注・顧客とひも付けます。最新の CSV を取り込むたびに、追加・変更された伝票だけを反映します"
            />
            {canImportData(user) ? <SalesLedgerImport /> : <Note>取込は管理者・本部スタッフが行います。</Note>}
          </Card>

          <Card>
            <CardHeader title="売上台帳と売上明細の二重計上をまとめる" icon={<Receipt />} description="移行した売上のうち、同じ売上が売上台帳の受注と伝票の受注の 2 件になっているものを 1 件にします" />
            {canImportData(user) ? <SalesReconcile /> : <Note>管理者・本部スタッフが行います。</Note>}
            <p className="mt-3 text-xs text-ink-2">
              店舗別・月別の売上 (売上台帳・伝票・新システム) と、売上台帳だけにある売上の一覧は{" "}
              <Link href="/data/sales-check" className="text-accent hover:underline">売上の照合</Link> で確かめられます (旧システムの数字との差も)。
            </p>
          </Card>

          {(Object.keys(IMPORT_SPEC) as ImportTarget[]).map((t) => (
            <Card key={t} padded={false}>
              <div className="px-5 pt-5">
                <CardHeader
                  title={`取込の項目: ${IMPORT_SPEC[t].label}`}
                  description="見出しは表の名前か別名のどちらでも読み取ります。並び順は自由で、ほかの列は取り込みません"
                  action={<a href={`/api/export?type=template-${t}`} className="inline-flex h-8 items-center gap-1 rounded-xl border border-line px-3 text-xs font-medium hover:bg-subtle"><Download className="h-3.5 w-3.5" aria-hidden />ひな形 (CSV)</a>}
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-xs">
                  <thead><tr className="bg-subtle text-left text-ink-2"><th className="px-5 py-2 font-medium">見出し</th><th className="px-3 py-2 font-medium">必須</th><th className="px-3 py-2 font-medium">別名</th><th className="px-5 py-2 font-medium">内容</th></tr></thead>
                  <tbody>
                    {IMPORT_SPEC[t].columns.map((c) => (
                      <tr key={c.key} className="border-t border-line align-top">
                        <td className="px-5 py-1.5 font-medium whitespace-nowrap text-ink">{c.header}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{c.required === "always" ? <Badge tone="critical" dot={false}>必須</Badge> : c.required === "new" ? <Badge tone="warn" dot={false}>新規は必須</Badge> : <span className="text-ink-3">-</span>}</td>
                        <td className="px-3 py-1.5 text-ink-3">{c.aliases.join("・") || "-"}</td>
                        <td className="px-5 py-1.5 text-ink-2">{c.note || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="書き出す (CSV)" icon={<Download />} description="UTF-8 の CSV です。Excel でも Google スプレッドシートでも開けます" />
            {canExportData(user) ? (
              <>
                <form className="mb-3 flex items-center gap-2">
                  <Select name="store" defaultValue={storeId} aria-label="店舗で絞り込む">
                    <option value="">全店舗</option>
                    {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                  <button type="submit" className="h-9 shrink-0 rounded-xl border border-line px-3 text-xs font-medium hover:bg-subtle">絞り込む</button>
                </form>
                <ul className="divide-y divide-line">
                  {EXPORTS.map((e) => (
                    <li key={e.type} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-ink">{e.label}</div>
                        <div className="text-[11px] text-ink-3">{e.desc}</div>
                      </div>
                      <a href={`/api/export?type=${e.type}${e.type === "sales" || e.type === "db" ? "" : q}`} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-xl bg-accent-soft px-3 text-xs font-medium text-accent-ink hover:bg-accent/15"><Download className="h-3.5 w-3.5" aria-hidden />書き出す</a>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Note>書き出しは管理者・本部スタッフが行います。</Note>
            )}
          </Card>

          <Card>
            <CardHeader title="Google スプレッドシートとの連携" />
            <ul className="list-disc space-y-2 pl-4 text-xs leading-relaxed text-ink-2">
              <li><span className="font-medium text-ink">シート → システム:</span> 左の「取り込む」で Google スプレッドシートを選び、シートの URL を貼り付けます。共有設定は「リンクを知っている全員 (閲覧者)」か、サービスアカウントへの共有 (設定されているとき) が必要です。</li>
              <li><span className="font-medium text-ink">システム → シート:</span> CSV を書き出し、Google スプレッドシートの「ファイル → インポート → アップロード」で読み込みます。</li>
              <li>{googleSheetsStatus().email ? <>非公開のシートは、シートの「共有」でサービスアカウント <span className="font-mono">{googleSheetsStatus().email}</span> を「閲覧者」に追加すると直接読めます (読み取りのみ)。</> : "非公開のシートを直接読む連携 (Google のサービスアカウント) は、鍵を GOOGLE_SERVICE_ACCOUNT_JSON に設定すると使えます (設定 → 外部連携・AI)。"}</li>
            </ul>
          </Card>

          <Card>
            <CardHeader title="取込・書き出しの履歴" description="直近 15 件 (すべての記録は変更履歴の画面)" />
            <ul className="space-y-2 text-xs">
              {history.map((l) => (
                <li key={l.id}>
                  <div className="flex flex-wrap items-center gap-1.5 text-ink-3"><span className="tnum">{fmtDateTime(l.at)}</span><Badge dot={false} tone={l.action === "import" ? "warn" : "neutral"}>{AUDIT_ACTION_LABEL[l.action]}</Badge>{userName(l.userId)}</div>
                  <div className="text-ink-2">{l.summary}</div>
                </li>
              ))}
              {history.length === 0 && <li className="text-ink-3">まだ記録はありません。</li>}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
