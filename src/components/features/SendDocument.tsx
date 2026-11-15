import type { Customer } from "@/lib/db/types";
import { sendDocument } from "@/lib/actions/documents";
import { lineConfig, mailConfig } from "@/lib/notify/config";
import { Button, Card, CardHeader, Field, Input, Note, Select, Textarea } from "@/components/ui";

/**
 * 見積書・請求書をお客様へ送る (メール: PDF を添付 / LINE: 期限つきの PDF のリンク)
 * 送信の設定 (設定 → 外部連携・AI) がないサービスは選べない
 */
export function SendDocumentCard({ kind, id, number, customer, defaultMessage }: { kind: "quote" | "invoice"; id: string; number: string; customer?: Customer; defaultMessage: string }) {
  const mail = Boolean(mailConfig());
  const line = Boolean(lineConfig());
  const label = kind === "quote" ? "見積書" : "請求書";
  const preferLine = customer?.preferredChannel === "line" && line && customer.lineId;
  return (
    <Card>
      <CardHeader title={`${label}をお客様へ送信`} description={`メールは PDF を添付、LINE は PDF を開くリンク (14 日間有効) を送ります。送信するとやりとり履歴・送信履歴に残ります`} />
      {!mail && !line ? (
        <Note>メール・LINE の送信設定がありません (設定 → 外部連携・AI)。郵送・手渡しで送った場合は「送付の記録」に残してください。</Note>
      ) : (
        <form action={sendDocument.bind(null, kind, id)} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
            <Field label="送信方法">
              <Select name="channel" defaultValue={preferLine ? "line" : mail ? "email" : "line"}>
                {mail && <option value="email">メール (PDF を添付)</option>}
                {line && <option value="line">LINE (PDF のリンク)</option>}
              </Select>
            </Field>
            <Field label="宛先" hint="メールアドレス、または LINE のユーザー ID" className="@xl:col-span-2">
              <Input name="to" defaultValue={preferLine ? customer?.lineId : customer?.email ?? (line ? customer?.lineId : "")} placeholder="例: customer@example.com" required />
            </Field>
          </div>
          <Field label="件名 (メールのみ)"><Input name="subject" defaultValue={`${kind === "quote" ? "お見積書" : "ご請求書"} ${number} 株式会社一畳屋`} /></Field>
          <Field label="本文"><Textarea name="message" defaultValue={defaultMessage} rows={6} required /></Field>
          <Button type="submit" size="sm">送信する</Button>
        </form>
      )}
    </Card>
  );
}
