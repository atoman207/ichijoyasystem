import Link from "@/components/ui/Link";
import { Calculator, RefreshCw } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { recheckCalc, retryExtraction, saveCalc, uploadDocument } from "@/lib/actions/capture";
import { aiStatus } from "@/lib/ai/provider";
import { attachmentsOf } from "@/lib/attachments";
import { fmtDateTime } from "@/lib/format";
import type { LineItem } from "@/lib/ai/ocr";
import { CaptureUploader } from "@/components/features/CaptureUploader";
import { QuoteCalcSheet } from "@/components/features/QuoteCalcSheet";
import { Badge, Card, CardHeader, Flash, LinkButton, Note, PageHeader } from "@/components/ui";

/** AI の読み取り (最大 50 秒) を待つため、処理時間の上限を 60 秒にする */
export const maxDuration = 60;

/**
 * 見積の金額の計算 (金額を書く前に撮影した手書き見積書)
 * 現場で 品名・数量・単価 まで書いた見積書を撮影 → AI が数量・単価を読む → システムが金額・小計・消費税・合計を計算
 * → 職人が確かめて見積書に書き写す → (おすすめ) 書き写した見積書を撮影して照合 → 書類取込の確認画面から見積を登録
 */
export default async function QuoteCalcPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const ai = aiStatus();
  const docs = scopeByStore(user, db.documents).filter((d) => d.kind === "handwritten_quote");
  const doc = sp.doc ? docs.find((d) => d.id === sp.doc) : undefined;
  const recent = docs
    .filter((d) => d.extracted?._mode === "calc" || d.extracted?._calc)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    .slice(0, 8);
  const stores = db.stores.map((s) => ({ id: s.id, name: s.name }));

  const header = (
    <PageHeader
      title="見積の金額の計算"
      icon={<Calculator />}
      back={{ href: "/capture", label: "書類取込" }}
      description="品名・数量・単価まで書いた手書き見積書を撮影すると、金額・小計・消費税・合計を計算します。確かめてから見積書に書き写してください。"
      badge={<Badge tone={ai.enabled ? "good" : "neutral"}>{ai.enabled ? `AI 読取: ${ai.label}` : "AI 読取: サンプルモード"}</Badge>}
    />
  );

  if (!doc) {
    return (
      <div>
        <Flash msg={sp.msg} err={sp.err ?? (sp.doc ? "書類が見つかりません (ほかの店舗の書類か、手書き見積書ではありません)。" : undefined)} />
        {header}
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
          <Card>
            <CardHeader title="撮影して計算する" description="金額・合計を書く前の見積書を、全体が入るように撮影してください" />
            <CaptureUploader
              action={uploadDocument}
              defaultKind="handwritten_quote"
              fixedKind
              hidden={{ mode: "calc" }}
              stores={stores}
              defaultStoreId={user.storeId}
              canChooseStore={canSeeAllStores(user)}
              aiEnabled={ai.enabled}
              labels={{
                submit: "読み取って計算する",
                pending: "AI が数量・単価を読み取り中… (10〜20 秒)",
                sample: "サンプルで計算を試す",
                drop: "タップして見積書を撮影",
                dropNote: "明るい場所で、影や斜めにならないように用紙全体を撮影してください",
                note: ai.enabled ? "AI は品名・数量・単価を読むだけで、計算はシステムが行います (AI に計算はさせません)。" : "AI の API キーが未設定のため、サンプルの読取結果で計算します。",
              }}
            />
          </Card>
          <Card>
            <CardHeader title="使い方" />
            <ol className="space-y-2.5 text-sm text-ink">
              {[
                ["見積書に品名・規格・数量・単価まで書く", "金額・小計・合計はまだ書きません。「2割引」のように割合で書いた値引きも計算します。諸経費・金券など金額だけの行は、金額欄に書いてください。"],
                ["見積書を撮影して「読み取って計算する」", "10〜20 秒ほどで、行ごとの金額と合計が出ます。"],
                ["画面の数量・単価が用紙と同じか確かめる", "黄色の行は読み取りに自信がない行です。違っていたら画面で直すと、すぐに計算し直します。"],
                ["金額・小計・合計を見積書に書き写す", "合計は下の「合計」と上の「税込合計金額」の欄に書きます。"],
                ["(おすすめ) 書き写した見積書を撮影して照合する", "書き写した金額が計算と同じか確かめ、そのまま見積の登録 (書類取込の確認画面) に進めます。"],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-2.5">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="font-medium">{t}</span>
                    <span className="mt-0.5 block text-xs text-ink-3">{d}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        {recent.length > 0 && (
          <Card className="mt-4">
            <CardHeader title="最近の計算" description="押すと計算の画面を開きます" />
            <ul className="divide-y divide-line text-sm">
              {recent.map((d) => {
                const ex = d.extracted ?? {};
                const total = typeof ex.total === "number" ? ex.total : undefined;
                const checked = ex._calcCheck as { issues?: string[] } | undefined;
                return (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link href={ex._mode === "calc" ? `/capture/calc?doc=${d.id}` : `/capture?doc=${d.id}`} className="min-w-0 font-medium text-ink hover:text-accent">
                      {typeof ex.customerName === "string" && ex.customerName ? `${ex.customerName} 様` : d.fileName}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-ink-3">
                      {fmtDateTime(d.uploadedAt)}
                      {total !== undefined && <span className="tnum text-ink-2">{total.toLocaleString("ja-JP")} 円</span>}
                      {checked ? <Badge tone={checked.issues?.length ? "warn" : "good"}>{checked.issues?.length ? "照合: 違いあり" : "照合: 一致"}</Badge> : d.status === "confirmed" ? <Badge tone="good">登録済み</Badge> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    );
  }

  const ex = doc.extracted ?? {};
  const items = (Array.isArray(ex.items) ? (ex.items as LineItem[]) : []).map((it) => ({ name: it.name, spec: it.spec, unit: it.unit, qty: it.qty, unitPrice: it.unitPrice, amount: it.amount, rate: it.rate, uncertain: it.uncertain, corrected: it.corrected }));
  const warnings = Array.isArray(ex._warnings) ? (ex._warnings as string[]) : [];
  const editable = doc.status === "extracted" || doc.status === "failed" || doc.status === "uploaded";
  const photos = attachmentsOf(db, "document", doc.id);
  // 新しい写真 (書き写しの照合のあとは、書き写した見積書。今の明細はその読取結果)
  const photo = photos[0];
  const taxModeRead = ex.taxMode === "税込" || ex.taxMode === "税抜";
  const taxMode = ex.taxMode === "税抜" || (!taxModeRead && ex.taxIncluded === false) ? "税抜" : "税込";
  const isCalc = ex._mode === "calc";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      {header}
      {!isCalc && (
        <div className="mb-4">
          <Note tone="accent">
            この見積書は{ex._calc ? "書き写した後の見積書として読み取り済み" : "記入済みの見積書として取り込んだもの"}です。下は今の明細から計算した金額です。登録は <Link href={`/capture?doc=${doc.id}`} className="font-medium underline">書類取込の確認画面</Link> で行います。
          </Note>
        </div>
      )}
      {doc.status === "failed" && (
        <p role="alert" className="mb-4 rounded-lg bg-critical-soft px-3 py-2 text-xs text-critical-ink">
          AI で読み取れませんでした: {String(ex._error ?? "原因不明のエラー")} — もう一度撮影するか、下の「もう一度読み取る」を押してください。数量・単価を「行を追加」で入力して計算することもできます。
        </p>
      )}
      {warnings.length > 0 && doc.status !== "failed" && (
        <div className="mb-4">
          <Note tone="warn">{warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</Note>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="space-y-2">
          {photo && photo.kind === "photo" ? (
            <a href={`/api/attachments/${photo.id}`} target="_blank" rel="noopener" className="block overflow-hidden rounded-lg border border-line bg-subtle">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/attachments/${photo.id}${photo.thumbKey ? "?size=thumb" : ""}`} alt={`撮影した見積書 ${photo.fileName}`} className="max-h-64 w-full object-contain" />
            </a>
          ) : (
            <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-line px-3 text-center text-xs text-ink-3">{ex._sample ? "サンプル (画像なし)" : "撮影した画像はありません"}</div>
          )}
          {photo && <p className="text-[11px] text-ink-3">画像を押すと元の大きさで開きます。</p>}
          <p className="text-[11px] text-ink-3">
            {fmtDateTime(doc.uploadedAt)}
            {typeof ex._ms === "number" && <> · 読取 {Math.round((ex._ms as number) / 100) / 10} 秒</>}
          </p>
        </div>

        <Card>
          <CardHeader title="計算結果 (書き写す金額)" description="数量・単価が用紙と同じか確かめてから、金額と合計を書き写してください" />
          <QuoteCalcSheet
            key={`${doc.id}_${String(ex._readAt ?? "")}_${String((ex._edited as { at?: string } | undefined)?.at ?? "")}`}
            id={doc.id}
            items={items}
            taxMode={taxMode}
            taxModeRead={taxModeRead}
            discount={typeof ex.discount === "number" ? ex.discount : 0}
            editable={editable}
            saveAction={saveCalc}
          />
        </Card>
      </div>

      {editable && (
        <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-2">
          <Card>
            <CardHeader title="書き写したら (おすすめ)" description="金額・合計を書いた見積書を撮影すると、書き写した金額が計算と同じか確かめます。お客様のお名前なども読み取り、そのまま見積の登録に進めます" />
            <CaptureUploader
              action={recheckCalc}
              defaultKind="handwritten_quote"
              fixedKind
              hideStore
              hidden={{ id: doc.id }}
              stores={stores}
              defaultStoreId={doc.storeId}
              canChooseStore={false}
              aiEnabled={ai.enabled}
              labels={{
                submit: "撮影して書き写しを確かめる",
                pending: "書き写した金額を読み取り中… (10〜20 秒)",
                sample: "サンプルで照合を試す",
                drop: "タップして、金額を書いた見積書を撮影",
                dropNote: "計算に使った写真も残ります",
                note: "読み取った金額と計算を行ごとに比べ、違う行は黄色で知らせます。",
              }}
            />
          </Card>
          <Card>
            <CardHeader title="そのほかの操作" />
            <div className="space-y-3">
              <div>
                <LinkButton href={`/capture?doc=${doc.id}`} variant="secondary">確認画面へ (お客様・見積の登録) →</LinkButton>
                <p className="mt-1 text-[11px] text-ink-3">撮り直さずに、いまの読取結果と計算で見積を作るときはこちら。</p>
              </div>
              {photo && (
                <form action={retryExtraction}>
                  <input type="hidden" name="id" value={doc.id} />
                  <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-panel px-3.5 text-sm font-medium text-ink hover:bg-subtle">
                    <RefreshCw className="h-3.5 w-3.5" /> もう一度読み取る
                  </button>
                  <p className="mt-1 text-[11px] text-ink-3">同じ写真を読み直します (画面で直した数量・単価は読み直した結果に置き換わります)。</p>
                </form>
              )}
              <div>
                <LinkButton href="/capture/calc" variant="secondary">別の見積書を計算する</LinkButton>
              </div>
            </div>
          </Card>
        </div>
      )}
      {!editable && (
        <p className="mt-4 text-sm text-ink-2">
          この書類は{doc.status === "confirmed" ? "登録済み" : "破棄済み"}のため、変更できません。 <Link href={`/capture?doc=${doc.id}`} className="text-accent hover:underline">書類取込の画面で見る →</Link>
        </p>
      )}
    </div>
  );
}
