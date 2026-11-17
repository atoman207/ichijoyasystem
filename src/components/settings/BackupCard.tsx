import { backupAvailable, backupDir, backupDisk, backupHistory, listBackups, readBackupStatus, type BackupStatus } from "@/lib/backup";
import { storageStats } from "@/lib/storage";
import { runBackupNow } from "@/lib/actions/backup";
import { fmtDateTime } from "@/lib/format";
import { Badge, Card, CardHeader } from "@/components/ui";
import { BackupAutoRefresh, BackupButton } from "./BackupControls";

const mb = (n?: number) => (n == null ? "-" : n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function StatusBadge({ s }: { s: BackupStatus }) {
  if (s.status === "running") return <Badge tone="accent" dot={false}>実行中</Badge>;
  return s.status === "ok" ? <Badge tone="good" dot={false}>成功</Badge> : <Badge tone="critical" dot={false}>失敗</Badge>;
}

const triggerLabel = (s: BackupStatus) => (s.trigger === "manual" ? `手動${s.by ? ` (${s.by})` : ""}` : "自動 (毎日 3:30)");

/** 設定 → データ管理: バックアップ (管理者)。保存先はすべてこの VPS */
export async function BackupCard() {
  const avail = backupAvailable();
  const status = readBackupStatus();
  const running = status?.status === "running";
  const files = listBackups();
  const history = backupHistory(6);
  const disk = backupDisk();
  const stats = await storageStats();
  return (
    <Card className="@2xl:col-span-2">
      <CardHeader
        title="バックアップ"
        description="データベース・添付ファイル・写真・チャットボットを、このサーバー (VPS) に保存します。毎日 3:30 に自動で実行し、管理者はいつでも実行できます。"
      />
      <BackupAutoRefresh running={running} />
      <div className="flex flex-wrap items-center gap-3">
        <form action={runBackupNow}>
          <BackupButton disabled={!avail.ok || running} label={running ? "実行中…" : "今すぐバックアップ"} />
        </form>
        {status ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            <StatusBadge s={status} />
            <span>
              {running ? `${fmtDateTime(status.startedAt ?? status.at)} から実行中 (${triggerLabel(status)})` : `最後: ${fmtDateTime(status.at)} · ${triggerLabel(status)}${status.seconds != null ? ` · ${status.seconds} 秒` : ""}`}
            </span>
          </div>
        ) : (
          <span className="text-xs text-ink-3">まだバックアップの記録がありません。</span>
        )}
      </div>
      {!avail.ok && <p className="mt-2 text-xs text-warn-ink">{avail.reason}</p>}
      {status && !running && status.message && <p className={`mt-2 text-xs ${status.status === "ok" ? "text-ink-2" : "text-critical-ink"}`}>{status.message}</p>}

      <div className="mt-4 grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-ink">保存してあるデータベースのバックアップ ({files.length} 件)</div>
          {files.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-subtle text-ink-2">
                    <th className="px-2 py-1.5 text-left font-medium">日時</th>
                    <th className="px-2 py-1.5 text-left font-medium">種類</th>
                    <th className="px-2 py-1.5 text-right font-medium">大きさ</th>
                  </tr>
                </thead>
                <tbody>
                  {files.slice(0, 8).map((f) => (
                    <tr key={f.name} className="border-t border-line">
                      <td className="px-2 py-1.5 tnum">{fmtDateTime(f.at)}</td>
                      <td className="px-2 py-1.5">{f.manual ? "手動" : "自動"}</td>
                      <td className="px-2 py-1.5 text-right tnum">{mb(f.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-ink-3">まだありません。</p>
          )}
          <p className="mt-1 text-[11px] text-ink-3">自動は 14 日分、手動は 30 日分を残します。</p>
        </div>
        <div className="space-y-2 text-xs text-ink-2">
          <div>
            <div className="font-medium text-ink">保存先 (この VPS)</div>
            <div className="break-all">{backupDir()}/db (データベース) · /storage (添付ファイル・写真) · /chatbot</div>
            {disk && <div>ディスクの空き {mb(disk.freeBytes)} / {mb(disk.totalBytes)}</div>}
          </div>
          <div>
            <div className="font-medium text-ink">添付ファイル・写真の保存先 (この VPS)</div>
            <div className="break-all">{stats.dir} · {stats.files.toLocaleString("ja-JP")} ファイル · {mb(stats.bytes)}{stats.writable ? "" : " · 書き込めません"}</div>
            <div className="text-[11px] text-ink-3">Supabase には台帳の文字とファイルのパスだけを保存しています。</div>
          </div>
          {history.length > 0 && (
            <div>
              <div className="font-medium text-ink">最近の実行</div>
              <ul className="mt-0.5 space-y-0.5">
                {history.map((h) => (
                  <li key={`${h.startedAt}-${h.at}`} className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge s={h} />
                    <span className="tnum">{fmtDateTime(h.at)}</span>
                    <span className="text-ink-3">{triggerLabel(h)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
