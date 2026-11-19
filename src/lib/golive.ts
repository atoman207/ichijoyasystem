import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "@/lib/db/types";
import { BACKEND } from "@/lib/db/store";
import { missingTables } from "@/lib/db/supabase";
import { isDemoAccount } from "@/lib/auth/permissions";
import { aiStatus } from "@/lib/ai/provider";
import { integrationStatuses } from "@/lib/notify/config";
import { knowledgeSources } from "@/lib/knowledge";
import { backupDir, readBackupStatus } from "@/lib/backup";
import { storageDir } from "@/lib/storage";
import { customerPhoneDigits } from "@/lib/customer-contacts";

/**
 * 本番運用の準備状況 (設定 → 本番運用の準備)
 * サーバー・データベース・セキュリティ・AI・外部連携・バックアップ・移行データを自動で確かめる (秘密の値は表示しない)
 */

export type CheckStatus = "ok" | "warn" | "ng" | "info";

export interface CheckItem {
  label: string;
  status: CheckStatus;
  detail: string;
  /** 対応のしかた (ok 以外のとき) */
  fix?: string;
}

export interface CheckGroup {
  title: string;
  items: CheckItem[];
}

const env = (k: string) => (process.env[k] ?? "").trim();
const digits = (v?: string) => (v ?? "").replace(/[^0-9]/g, "");

export function goLiveChecks(db: Database, now = new Date()): CheckGroup[] {
  const groups: CheckGroup[] = [];
  const onVercel = env("VERCEL") === "1";
  const prod = process.env.NODE_ENV === "production";
  const baseUrl = env("APP_BASE_URL");
  const mem = process.memoryUsage();

  // ---- サーバー・データベース ----
  const missing = BACKEND === "supabase" ? missingTables() : [];
  groups.push({
    title: "サーバー・データベース",
    items: [
      { label: "動作環境", status: "info", detail: `${onVercel ? "Vercel" : prod ? "サーバー (next start)" : "開発環境 (next dev)"} · Node.js ${process.version} · 稼働 ${Math.round(process.uptime() / 60)} 分 · メモリ ${Math.round(mem.rss / 1024 / 1024)} MB` },
      BACKEND === "supabase"
        ? { label: "データベース", status: "ok", detail: "Supabase (PostgreSQL) に接続しています" }
        : { label: "データベース", status: prod ? "ng" : "warn", detail: `ローカルファイル (data/${process.env.DATA_FILE_NAME ?? "db.json"}) で動いています`, fix: "NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY を設定してください (deploy/ichijoya.env.example)" },
      missing.length
        ? { label: "データベースの表", status: "ng", detail: `足りない表: ${missing.join(", ")}`, fix: "デプロイ (npm run build) で表を追加するか、npm run db:migrate を実行してください" }
        : { label: "データベースの表", status: "ok", detail: "アプリの表がそろっています" },
      storageCheck(db),
      { label: "タイムゾーン", status: Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Tokyo" ? "ok" : "ng", detail: Intl.DateTimeFormat().resolvedOptions().timeZone, fix: "APP_TIME_ZONE=Asia/Tokyo を設定してください" },
      !baseUrl
        ? { label: "このシステムの URL (APP_BASE_URL)", status: onVercel ? "warn" : "ng", detail: "未設定 (通知・帳票のリンクと Webhook の受信先に使います)", fix: "APP_BASE_URL=https://<ドメイン> を設定してください" }
        : { label: "このシステムの URL (APP_BASE_URL)", status: baseUrl.startsWith("https://") ? "ok" : "warn", detail: baseUrl.startsWith("https://") ? baseUrl : `${baseUrl} (ドメインなし・IP アドレスで公開中)`, fix: "ドメインを用意して DNS を設定したら、サーバーで sudo bash /srv/ichijoya/repo/deploy/enable-domain.sh <ドメイン> <メール> を実行してください (https・証明書・URL を切り替えます)" },
    ],
  });

  // ---- セキュリティ・アカウント ----
  const active = db.users.filter((u) => u.active);
  const demo = active.filter((u) => isDemoAccount(u));
  const admins = active.filter((u) => u.role === "admin" && !isDemoAccount(u));
  const changed = new Set(db.auditLogs.filter((l) => l.entity === "user" && l.action === "update" && /パスワードを変更/.test(l.summary)).map((l) => l.entityId));
  const notChanged = active.filter((u) => !isDemoAccount(u) && !changed.has(u.id) && u.passwordHash);
  const secret = env("SESSION_SECRET");
  groups.push({
    title: "セキュリティ・アカウント",
    items: [
      secret.length >= 32 ? { label: "ログインの署名の鍵 (SESSION_SECRET)", status: "ok", detail: "設定あり" } : { label: "ログインの署名の鍵 (SESSION_SECRET)", status: secret ? "warn" : env("SUPABASE_SECRET_KEY") ? "warn" : "ng", detail: secret ? "短すぎます" : "未設定 (Supabase の鍵から作っています)", fix: "32 文字以上のランダムな値を設定してください (openssl rand -hex 32)" },
      demo.length ? { label: "デモ用アカウント", status: "ng", detail: `有効なデモ用アカウントが ${demo.length} 件あります (パスワードが公開されています)`, fix: "node scripts/import/seed-demo-accounts.mjs --off で無効にしてください" } : { label: "デモ用アカウント", status: "ok", detail: "有効なデモ用アカウントはありません" },
      admins.length ? { label: "管理者アカウント", status: "ok", detail: `${admins.length} 人 (${admins.map((u) => u.name).join("・")})` } : { label: "管理者アカウント", status: "ng", detail: "デモ用以外の管理者がいません", fix: "設定 → ユーザーと権限 で管理者を登録してください" },
      notChanged.length ? { label: "初期パスワードの変更", status: "warn", detail: `一度もパスワードを変更していない社員が ${notChanged.length} 人います`, fix: "各社員に、最初のログインでプロフィールからパスワードを変更してもらってください" } : { label: "初期パスワードの変更", status: "ok", detail: "全員が変更済み" },
      { label: "HTTPS", status: baseUrl.startsWith("https://") ? "ok" : "warn", detail: baseUrl.startsWith("https://") ? "https で公開" : "http で公開中 (ドメインの用意待ち)", fix: "ドメインを用意したら enable-domain.sh で証明書 (Let's Encrypt) を設定します。それまでは社内の確認用として使ってください" },
    ],
  });

  // ---- AI・外部連携 ----
  const ai = aiStatus();
  const integ = integrationStatuses();
  const sources = knowledgeSources(db);
  groups.push({
    title: "AI・外部連携",
    items: [
      ai.enabled ? { label: "AI", status: "ok", detail: `${ai.label} · ${ai.model} (キー: ${ai.source})` } : { label: "AI", status: "warn", detail: "未設定 (サンプルモード)", fix: "OPENAI_API_KEY を設定し、設定 → 外部連携・AI の「接続を確認」で確かめてください" },
      { label: "社内資料 (ナレッジ)", status: db.knowledge.some((k) => k.active) ? "ok" : "warn", detail: `${db.knowledge.filter((k) => k.active).length} 件 · スプレッドシート ${sources.length} 件${sources.some((s) => s.lastError) ? " (同期の失敗あり)" : ""}`, fix: "社内資料の画面で、AI が回答に使う資料を登録してください" },
      ...integ.map((i): CheckItem => ({ label: i.name, status: i.configured ? "ok" : "info", detail: i.configured ? i.detail : `未設定 (送信は「記録のみ」): ${i.detail}` })),
      { label: "定期実行の鍵 (CRON_SECRET)", status: env("CRON_SECRET") ? "ok" : onVercel ? "info" : "warn", detail: env("CRON_SECRET") ? "設定あり (社内資料の自動同期)" : "未設定", fix: "サーバーの設定ファイルに CRON_SECRET を設定してください" },
    ],
  });

  // ---- バックアップ ----
  const b = readBackupStatus();
  const age = b ? (now.getTime() - Date.parse(b.at)) / 3600000 : Infinity;
  groups.push({
    title: "バックアップ",
    items: onVercel && !b
      ? [{ label: "バックアップ", status: "warn", detail: "Vercel では自動のバックアップを設定していません", fix: "サーバー (VPS) へ移行後、deploy/backup.sh が毎日実行されます。Supabase の有料プランでは自動バックアップも使えます" }]
      : [
          !b
            ? { label: "最後のバックアップ", status: "ng", detail: "記録がありません", fix: "設定 → データ管理 の「今すぐバックアップ」を押してください (毎日 3:30 に自動実行)" }
            : b.status === "running"
              ? { label: "最後のバックアップ", status: "info", detail: `実行中 (${new Date(b.startedAt ?? b.at).toLocaleString("ja-JP")} から)` }
              : { label: "最後のバックアップ", status: b.status === "ok" && age <= 36 ? "ok" : "ng", detail: `${new Date(b.at).toLocaleString("ja-JP")} · ${b.status === "ok" ? "成功" : "失敗"}${b.trigger === "manual" ? ` (手動${b.by ? `: ${b.by}` : ""})` : ""} · ${b.message ?? ""}`, fix: b.status === "ok" ? "毎日 3:30 の自動実行 (/etc/cron.d/ichijoya) を確認してください" : "/var/log/ichijoya/backup.log を確認し、設定 → データ管理 から実行し直してください" },
          ...(b ? [{ label: "保管・ディスク", status: (Number.parseInt(b.diskUsed ?? "0") >= 85 ? "warn" : "info") as CheckStatus, detail: `保存先 ${backupDir()} (この VPS) · データベースのバックアップ ${b.kept ?? "-"} 件 · ディスク使用 ${b.diskUsed ?? "-"}`, fix: "ディスクの空きを確保してください" }] : []),
        ],
  });
  return groups;
}

/* ================================================================== */
/* 移行データの確認                                                       */
/* ================================================================== */

export interface DataCheck {
  label: string;
  count: number;
  total: number;
  status: CheckStatus;
  note: string;
  href?: string;
}

export function migrationChecks(db: Database): DataCheck[] {
  const customers = db.customers;
  const phones = new Map<string, number>();
  for (const c of customers) {
    const d = digits(c.phone);
    if (d.length >= 9) phones.set(d, (phones.get(d) ?? 0) + 1);
  }
  const dupPhones = [...phones.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
  const customerIds = new Set(customers.map((c) => c.id));
  const orderIds = new Set(db.orders.map((o) => o.id));
  const activeUsers = new Set(db.users.filter((u) => u.active).map((u) => u.id));
  const rows: DataCheck[] = [
    { label: "電話番号のない顧客", count: customers.filter((c) => customerPhoneDigits(c).length === 0).length, total: customers.length, status: "info", note: "電話での照合 (AI 電話受付・Web フォーム) ができません", href: "/customers" },
    { label: "住所のない顧客", count: customers.filter((c) => !c.address?.trim()).length, total: customers.length, status: "info", note: "現場の住所は受注ごとにも登録できます", href: "/customers" },
    { label: "電話番号が同じ顧客", count: dupPhones, total: customers.length, status: dupPhones ? "warn" : "ok", note: "同じお客様の重複か、家族・法人の共有の番号です。受付の自動ひも付けは最近更新した顧客になります", href: "/customers" },
    { label: "顧客が見つからない受注", count: db.orders.filter((o) => !customerIds.has(o.customerId)).length, total: db.orders.length, status: "ok", note: "移行の対応づけの漏れ" },
    { label: "受注が見つからない請求", count: db.invoices.filter((i) => !orderIds.has(i.orderId)).length, total: db.invoices.length, status: "ok", note: "移行の対応づけの漏れ" },
    { label: "担当者が退職・未登録の対応中の問い合わせ", count: db.inquiries.filter((i) => ["new", "in_progress"].includes(i.status) && i.assignedUserId && !activeUsers.has(i.assignedUserId)).length, total: db.inquiries.filter((i) => ["new", "in_progress"].includes(i.status)).length, status: "ok", note: "担当者を付け直してください", href: "/inquiries" },
    { label: "担当者のいない未対応の問い合わせ", count: db.inquiries.filter((i) => i.status === "new" && !i.assignedUserId).length, total: db.inquiries.filter((i) => i.status === "new").length, status: "ok", note: "担当者を割り当ててください", href: "/inquiries?status=new" },
  ];
  return rows.map((r) => ({ ...r, status: r.count === 0 ? "ok" : r.status === "ok" ? "warn" : r.status }));
}

/** 添付ファイル・写真の保存先 (この VPS のディスク。Supabase にはパスだけ) */
function storageCheck(db: Database): CheckItem {
  const dir = storageDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { label: "ファイルの保存先", status: "ng", detail: `${dir} に書き込めません`, fix: "サーバーで所有者を ichijoya にしてください (sudo chown -R ichijoya:ichijoya /srv/ichijoya/data)" };
  }
  const missing = db.attachments.filter((a) => !fs.existsSync(path.join(dir, a.storageKey))).length;
  return missing
    ? { label: "ファイルの保存先", status: "ng", detail: `この VPS (${dir}) · 台帳 ${db.attachments.length} 件のうち ${missing} 件の本体がありません`, fix: "node scripts/ops/migrate-storage-to-vps.mjs で確かめてください" }
    : { label: "ファイルの保存先", status: "ok", detail: `この VPS (${dir}) · ${db.attachments.length} 件 (Supabase には台帳の文字とパスだけ)` };
}
