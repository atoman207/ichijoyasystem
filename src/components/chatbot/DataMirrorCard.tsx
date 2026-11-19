import "server-only";
import { Database } from "lucide-react";
import { mirrorStatus } from "@/lib/datastore/mirror";
import { rebuildDataMirror } from "@/lib/actions/chatbot";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader } from "@/components/ui";

/**
 * VPS のデータベース (システムの全データの写し) の状態。AI アシスタント → チャットボットの管理 に表示する。
 * 中身と同期の仕組みは src/lib/datastore/mirror.ts
 */
export function DataMirrorCard() {
  const s = mirrorStatus();
  const total = s.tables.reduce((a, t) => a + t.rows, 0);
  const tone = s.status === "ready" ? "good" : s.status === "error" ? "critical" : "warn";
  const label = { ready: "同期中 (最新)", building: "作成中", error: "エラー", idle: "未開始" }[s.status];
  return (
    <Card>
      <CardHeader
        title="VPS のデータベース (AI が検索・集計に使うシステムの全データ)"
        icon={<Database />}
        description="システムの全データ (顧客・問い合わせ・見積・受注・請求・入金・予定・経費・仕入・社内資料など) を VPS の SQLite に写し、登録・変更のたびに自動で書き込みます。「質問する」は横断検索と SQL の集計にこのデータベースを使います"
        action={<Badge tone={tone}>{label}</Badge>}
      />
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs @xl:grid-cols-2">
        <div className="flex gap-2"><dt className="shrink-0 text-ink-3">保存先</dt><dd className="min-w-0 break-all font-mono text-ink">{s.path}</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-ink-3">大きさ</dt><dd className="text-ink">{(s.sizeBytes / 1048576).toFixed(1)} MB · {total.toLocaleString("ja-JP")} 行</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-ink-3">最後の書き込み</dt><dd className="text-ink">{s.syncedAt ? fmtDateTime(s.syncedAt) : "-"}</dd></div>
        <div className="flex gap-2"><dt className="shrink-0 text-ink-3">全体の突き合わせ</dt><dd className="text-ink">{s.lastFull ? `${fmtDateTime(s.lastFull.at)} (${(s.lastFull.ms / 1000).toFixed(1)} 秒・書き込み ${s.lastFull.written.toLocaleString("ja-JP")} 行)` : "-"}</dd></div>
      </dl>
      {s.error && <p className="mt-2 rounded-lg bg-critical-soft px-3 py-2 text-xs text-critical-ink">{s.error}</p>}
      {s.tables.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer select-none text-ink-2 hover:text-ink">表ごとの行数 ({s.tables.length} 表)</summary>
          <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-0.5 @xl:grid-cols-2">
            {s.tables.map((t) => (
              <li key={t.table} className="flex justify-between gap-3 border-b border-line/60 py-0.5">
                <span className="min-w-0 truncate text-ink-2" title={t.label}>
                  <span className="font-mono text-ink">{t.table}</span> {t.label.replace(/\s*\(.*$/, "")}
                </span>
                <span className="tnum shrink-0 text-ink">{t.rows.toLocaleString("ja-JP")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <form action={rebuildDataMirror} className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="secondary">作り直す</Button>
        <span className="text-[11px] text-ink-3">ふだんは不要です (Supabase の内容から全部入れ直します。1〜3 分。そのあいだ検索はメモリの索引を使います)</span>
      </form>
    </Card>
  );
}
