import type { Database } from "@/lib/db/types";
import { inboundItems, inboundMailState, inboundSettings, slackSeenChannels } from "@/lib/inbound/feed";
import { inboundMailConfig } from "@/lib/inbound/mail";
import { slackBotToken, slackSigningSecret } from "@/lib/inbound/slack";
import { checkInboundMailNow, setInboundMail, setSlackChannelStore } from "@/lib/actions/inbound";
import { lineSecret, chatworkWebhookTokens } from "@/lib/notify/config";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, LinkButton, Select } from "@/components/ui";

/**
 * 設定 → 外部連携・AI の「外部から届いたメッセージの通知」(お客様のご要望 2026-11-26。src/lib/inbound/feed.ts)
 * LINE・Chatwork は受信の設定があればそのまま通知。メール (会社のメールボックス) は管理者がオンにしたときだけ、Slack はアプリの設定をしたとき
 */
export function InboundCard({ db, admin, base }: { db: Database; admin: boolean; base: string }) {
  const set = inboundSettings(db);
  const mailCfg = inboundMailConfig();
  const mail = inboundMailState(db);
  const items = inboundItems(db);
  const count = (ch: string) => items.filter((i) => i.channel === ch).length;
  const slackReady = Boolean(slackSigningSecret());
  const channels = Object.entries(slackSeenChannels(db)).sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt));
  const stores = db.stores.filter((s) => s.kind !== "hq");
  const back = <input type="hidden" name="returnTo" value="/settings?tab=integrations#inbound" />;
  const rows: { name: string; ok: boolean; status: string; detail: string }[] = [
    { name: "LINE", ok: Boolean(lineSecret()), status: lineSecret() ? "通知します" : "受信の設定なし", detail: "1 対 1・グループのメッセージ (お客様・協力業者・案件・店舗別グループ)。届いた店舗の社員と本部・管理者に知らせます" },
    { name: "Chatwork", ok: chatworkWebhookTokens().length > 0, status: chatworkWebhookTokens().length ? "通知します" : "受信の設定なし", detail: "協力業者・仕入先のルームの投稿。本部・管理者に知らせます" },
  ];
  return (
    <Card className="@2xl:col-span-2" id="inbound">
      <CardHeader
        title="外部から届いたメッセージの通知 (LINE・メール・Slack・Chatwork)"
        description="届いたメッセージを右上のベルとトーストで知らせます (届いた店舗の社員と本部・管理者。お店の決まらないものは本部・管理者だけ)。一覧は「届いたメッセージ」で見られます"
        action={<LinkButton href="/notices/inbound" size="sm" variant="secondary">届いたメッセージ ({items.length})</LinkButton>}
      />
      <ul className="divide-y divide-line text-xs">
        {rows.map((r) => (
          <li key={r.name} className="flex flex-wrap items-start justify-between gap-2 py-2">
            <div className="min-w-0">
              <span className="font-medium text-ink">{r.name}</span>
              <p className="mt-0.5 text-ink-2">{r.detail} · これまで {count(r.name === "LINE" ? "line" : "chatwork")} 件</p>
            </div>
            <Badge tone={r.ok ? "good" : "neutral"}>{r.status}</Badge>
          </li>
        ))}

        <li className="py-3" data-testid="inbound-mail">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="font-medium text-ink">メール (会社のメールボックス)</span>
              <p className="mt-0.5 text-ink-2">
                {mailCfg ? <>受信するアカウント: <span className="font-mono">{mailCfg.user}</span> ({mailCfg.host}:{mailCfg.port} · {mailCfg.mailbox} · 環境変数 {mailCfg.source})</> : "メールサーバーの設定がありません (INBOUND_MAIL_HOST・INBOUND_MAIL_USER・INBOUND_MAIL_PASSWORD、または送信と同じ SMTP_HOST・SMTP_USER・SMTP_PASSWORD)"}
              </p>
              <p className="mt-0.5 text-ink-2">
                読み取り専用で読みます (メールソフトの未読・既読は変わらず、削除・移動もしません)。お客様・取引先のメールはやりとり履歴にも残します。自動送信・メールマガジンは一覧だけ (ベルに出しません)。
              </p>
              {set.mailEnabled && (
                <p className="mt-1 text-ink-2">
                  最後の確認: {mail.lastRunAt ? fmtDateTime(mail.lastRunAt) : "まだ"} · これまで {mail.received ?? 0} 通
                  {mail.lastError && <span className="ml-1 text-critical-ink">· {mail.lastError}</span>}
                </p>
              )}
            </div>
            <Badge tone={set.mailEnabled ? (mail.lastError ? "warn" : "good") : "neutral"}>{set.mailEnabled ? (mail.lastError ? "受信に失敗" : "通知します") : "オフ"}</Badge>
          </div>
          {admin && (
            <div className="mt-2 flex flex-wrap gap-2">
              <form action={setInboundMail}>
                {back}
                <input type="hidden" name="enabled" value={set.mailEnabled ? "0" : "1"} />
                <Button type="submit" size="sm" variant={set.mailEnabled ? "secondary" : "primary"} disabled={!set.mailEnabled && !mailCfg} data-testid="inbound-mail-toggle">
                  {set.mailEnabled ? "メールの受信の通知をオフにする" : "メールの受信の通知をオンにする"}
                </Button>
              </form>
              {set.mailEnabled && (
                <form action={checkInboundMailNow}>
                  {back}
                  <Button type="submit" size="sm" variant="secondary">今すぐ確認</Button>
                </form>
              )}
            </div>
          )}
        </li>

        <li className="py-3" data-testid="inbound-slack">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="font-medium text-ink">Slack</span>
              <p className="mt-0.5 text-ink-2">
                Slack のアプリ (api.slack.com/apps) の Event Subscriptions の Request URL に下の URL を設定し、Bot Events に message.channels・message.groups・message.im を足して、通知したいチャンネルにアプリを招待します。署名の確認に SLACK_SIGNING_SECRET、送り主・チャンネルの名前の取得に SLACK_BOT_TOKEN (users:read・channels:read・groups:read) を設定します。
              </p>
              <p className="mt-0.5 font-mono text-[11px] break-all text-ink-3">{base}/api/integrations/slack</p>
              <p className="mt-0.5 text-ink-2">
                {slackReady ? `署名の確認の設定あり${slackBotToken() ? " · 名前の取得の設定あり" : " · SLACK_BOT_TOKEN は未設定 (送り主は「Slack のユーザー」と表示)"}` : "SLACK_SIGNING_SECRET が未設定です"} · これまで {count("slack")} 件
              </p>
            </div>
            <Badge tone={slackReady ? "good" : "neutral"}>{slackReady ? "通知します" : "未設定"}</Badge>
          </div>
          {channels.length > 0 && (
            <div className="mt-2 rounded-xl border border-line">
              <div className="border-b border-line bg-subtle/60 px-3 py-1.5 text-[11px] font-semibold text-ink-2">届いたチャンネルと知らせる店舗 (決めていないチャンネル・DM は本部・管理者だけ)</div>
              <ul className="divide-y divide-line">
                {channels.map(([id, c]) => (
                  <li key={id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                    <span className="min-w-0 text-ink">
                      {c.name ? `#${c.name}` : id} <span className="text-[11px] text-ink-3">· {c.count} 件 · 最後 {fmtDateTime(c.lastAt)}</span>
                    </span>
                    {admin ? (
                      <form action={setSlackChannelStore} className="flex items-center gap-1">
                        {back}
                        <input type="hidden" name="channel" value={id} />
                        <Select name="storeId" defaultValue={set.slackStores?.[id] ?? ""} className="h-8 w-40 py-0 text-xs" aria-label={`${c.name ?? id} の知らせる店舗`}>
                          <option value="">本部・管理者だけ</option>
                          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </Select>
                        <Button type="submit" size="sm" variant="secondary">変更</Button>
                      </form>
                    ) : (
                      <span className="text-[11px] text-ink-2">{set.slackStores?.[id] ? (db.stores.find((s) => s.id === set.slackStores![id])?.name ?? set.slackStores[id]) : "本部・管理者だけ"}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      </ul>
    </Card>
  );
}
