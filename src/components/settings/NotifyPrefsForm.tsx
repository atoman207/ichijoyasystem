import type { User } from "@/lib/db/types";
import { mailConfig, chatworkConfig } from "@/lib/notify/config";
import { Button, Field, Input } from "@/components/ui";

/** 通知の受け取り方 (メールアドレス・メールで受け取る・Chatwork のアカウント ID) */
export function NotifyPrefsForm({ u, action }: { u: User; action: (fd: FormData) => Promise<void> }) {
  const mail = Boolean(mailConfig());
  const cw = Boolean(chatworkConfig()?.roomId);
  return (
    <form action={action} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <Field label="通知用のメールアドレス" hint="空欄ならログイン ID (メールアドレスのとき) に送ります"><Input name="notifyEmail" type="email" defaultValue={u.notifyEmail} placeholder="例: name@example.co.jp" /></Field>
        <Field label="Chatwork のアカウント ID" hint="社内通知のルームで [To] に入れます (数字)"><Input name="chatworkAccountId" defaultValue={u.chatworkAccountId} inputMode="numeric" /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" name="notifyByEmail" defaultChecked={u.notifyByEmail} className="h-4 w-4" /> 承認依頼・承認の結果・メンション・業務依頼をメールでも受け取る</label>
      <p className="text-[11px] text-ink-3">メールの送信設定: {mail ? "あり" : "なし (設定されるまでは画面のお知らせのみ)"} · Chatwork の社内通知のルーム: {cw ? "あり" : "なし"}</p>
      <Button type="submit" size="sm" variant="secondary">保存</Button>
    </form>
  );
}
