import { requireUser } from "@/lib/auth/session";
import { BACKEND, getDb } from "@/lib/db/store";
import { canExportData, canManageSettings } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { createProduct, updateDocumentSettings, updateOpsSettings, updateProduct, updateStore } from "@/lib/actions/settings";
import { UsersTab } from "@/components/settings/UsersTab";
import { resetSampleData } from "@/lib/actions/auth";
import { aiStatus } from "@/lib/ai/provider";
import { documentSettings } from "@/lib/doc-settings";
import { AiConnectionCheck } from "@/components/settings/AiConnectionCheck";
import { KpiSettingsCard } from "@/components/settings/KpiSettingsCard";
import { CUSTOMER_CREATOR_LABEL, opsSettings } from "@/lib/ops-settings";
import { fmtDateTime, yen } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, DELIVERY_CHANNEL_LABEL, DELIVERY_STATUS } from "@/lib/constants";
import { approvalSettings } from "@/lib/approval-rules";
import { sendTestMessage, updateAiIntakeSettings, updateApprovalSettings, updateNotifySettings } from "@/lib/actions/settings-ops";
import { HANDOFF_MODE_LABEL, aiIntakeSettings, type HandoffMode } from "@/lib/ai-intake";
import { appBaseUrl, chatworkConfig, integrationStatuses } from "@/lib/notify/config";
import { NOTIFY_EVENT_LABEL, notifySettings, type NotifyEvent } from "@/lib/notify/events";
import { canManageIntegrations } from "@/lib/auth/permissions";
import type { ServiceCategory } from "@/lib/db/types";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Select, StoreTag, Textarea } from "@/components/ui";
import { GoLivePanel } from "@/components/settings/GoLivePanel";
import { LineGroupsCard } from "@/components/settings/LineGroupsCard";
import { MessagingConnectionCheck } from "@/components/settings/MessagingConnectionCheck";

/** 「接続を確認」で AI の応答を待つ (最大 50 秒) ため */
export const maxDuration = 60;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const admin = canManageSettings(user);
  const tab = sp.tab ?? "users";
  const base = "/settings";
  const ai = aiStatus();
  const docSet = documentSettings(db);
  const rules = approvalSettings(db);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title={admin ? "設定" : "設定 (閲覧のみ)"} badge={!admin && <Badge tone="neutral">{user.role === "store_manager" ? "変更は管理者のみ (自店舗のスタッフのアカウントは店長も管理)" : "変更は管理者のみ"}</Badge>} />
      <LinkTabs
        current={`${base}?tab=${tab}`}
        items={[
          { href: `${base}?tab=users`, label: "ユーザーと権限", count: db.users.filter((u) => u.signupStatus !== "pending").length },
          { href: `${base}?tab=stores`, label: "店舗" },
          { href: `${base}?tab=products`, label: "商品マスタ", count: db.products.length },
          { href: `${base}?tab=documents`, label: "帳票 (見積書・請求書)" },
          { href: `${base}?tab=ops`, label: "運用" },
          { href: `${base}?tab=kpi`, label: "KPI・インセンティブ" },
          { href: `${base}?tab=rules`, label: "承認ルール・業務フロー" },
          { href: `${base}?tab=integrations`, label: "外部連携・AI" },
          { href: `${base}?tab=data`, label: "データ管理" },
          { href: `${base}?tab=golive`, label: "本番運用の準備" },
        ]}
      />

      {tab === "users" && <UsersTab db={db} user={user} />}

      {tab === "stores" && (
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
          {db.stores.map((s) => (
            <Card key={s.id}>
              <CardHeader title={<StoreTag store={s} />} description={s.kind === "hq" ? "本社・ショールーム" : "店舗"} />
              {admin ? (
                <form action={updateStore.bind(null, s.id)} className="space-y-2">
                  <Field label="住所"><Input name="address" defaultValue={s.address} /></Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="電話"><Input name="phone" defaultValue={s.phone} /></Field>
                    <Field label="責任者"><Select name="managerUserId" defaultValue={s.managerUserId}>{db.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
                  </div>
                  <Button type="submit" size="sm" variant="secondary">保存</Button>
                </form>
              ) : (
                <dl className="text-sm"><dt className="text-xs text-ink-3">住所</dt><dd>〒{s.postalCode} {s.address}</dd><dt className="mt-2 text-xs text-ink-3">電話</dt><dd>{s.phone}</dd><dt className="mt-2 text-xs text-ink-3">責任者</dt><dd>{userName(s.managerUserId)}</dd></dl>
              )}
            </Card>
          ))}
        </div>
      )}

      {tab === "products" && (
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
          <Card className="@4xl:col-span-2" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">種別</th><th className="px-3 py-2 text-left font-medium">商品名</th><th className="px-3 py-2 text-left font-medium">グレード / サイズ</th><th className="px-3 py-2 text-right font-medium">単価 (税抜)</th><th className="px-3 py-2 text-right font-medium">税込</th><th className="px-4 py-2 text-left font-medium">状態</th></tr></thead>
                <tbody>
                  {db.products.map((p) => (
                    <tr key={p.id} className="border-t border-line">
                      <td className="px-4 py-2 text-xs text-ink-2">{CATEGORY_LABEL[p.category]}</td>
                      <td className="px-3 py-2 font-medium">{p.name}</td>
                      <td className="px-3 py-2 text-xs text-ink-2">{[p.grade, p.sizeLabel].filter(Boolean).join(" / ") || "-"}</td>
                      <td className="px-3 py-2 text-right">
                        {admin ? (
                          <form action={updateProduct.bind(null, p.id)} className="flex items-center justify-end gap-1">
                            <input type="hidden" name="active" value={p.active ? "on" : "off"} />
                            <input type="number" name="unitPrice" defaultValue={p.unitPrice} className="field h-8 w-28 py-1 text-right text-xs tnum" />
                            <span className="text-xs text-ink-3">/{p.unit}</span>
                            <button type="submit" className="rounded border border-line px-2 py-1 text-[11px] hover:bg-subtle">保存</button>
                          </form>
                        ) : (
                          <span className="tnum">{yen(p.unitPrice)} /{p.unit}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tnum text-ink-2">{yen(Math.round(p.unitPrice * 1.1))}</td>
                      <td className="px-4 py-2"><Badge tone={p.active ? "good" : "neutral"}>{p.active ? "販売中" : "停止"}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div>
            <Note>単価は税抜。Web サイト掲載の税込価格 (例: 古都 27,500 円/畳) に対応しています。変更は今後作成する見積に反映され、既存の見積は変わりません。</Note>
            {admin && (
              <Card className="mt-4">
                <CardHeader title="商品を追加" />
                <form action={createProduct} className="space-y-2">
                  <Field label="種別"><Select name="category" defaultValue="tatami">{(Object.keys(CATEGORY_LABEL) as ServiceCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</Select></Field>
                  <Field label="商品名" required><Input name="name" required /></Field>
                  <Field label="グレード"><Input name="grade" /></Field>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="サイズ"><Input name="sizeLabel" /></Field>
                    <Field label="単位"><Input name="unit" defaultValue="畳" /></Field>
                    <Field label="単価 (税抜)"><Input name="unitPrice" type="number" /></Field>
                  </div>
                  <Button type="submit" size="sm">追加する</Button>
                </form>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === "documents" && (
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
          <Card className="@4xl:col-span-2">
            <CardHeader title="帳票に載せる会社情報" description="見積書・請求書・領収書の PDF に印字します。空欄の項目は帳票に出しません" />
            {!docSet.registrationNumber && <Note tone="warn">適格請求書発行事業者の登録番号が未設定です。インボイス制度の請求書・領収書には登録番号の記載が必要です。</Note>}
            {admin ? (
              <form action={updateDocumentSettings} className="mt-3 space-y-4">
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                  <Field label="会社名" required><Input name="companyName" defaultValue={docSet.companyName} required /></Field>
                  <Field label="登録番号 (T + 13 桁)" hint="適格請求書発行事業者の登録番号"><Input name="registrationNumber" defaultValue={docSet.registrationNumber} placeholder="T1234567890123" /></Field>
                  <Field label="郵便番号"><Input name="postalCode" defaultValue={docSet.postalCode} /></Field>
                  <Field label="住所"><Input name="address" defaultValue={docSet.address} /></Field>
                  <Field label="電話"><Input name="tel" defaultValue={docSet.tel} /></Field>
                  <Field label="FAX"><Input name="fax" defaultValue={docSet.fax} /></Field>
                  <Field label="メール"><Input name="email" type="email" defaultValue={docSet.email} /></Field>
                  <Field label="Web サイト"><Input name="website" defaultValue={docSet.website} /></Field>
                </div>
                <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" name="showStore" defaultChecked={docSet.showStore} className="h-4 w-4" /> 担当店舗の住所・電話も載せる</label>
                <div>
                  <div className="label">振込先 (請求書に印字。3 つまで)</div>
                  <div className="space-y-2">
                    {[0, 1, 2].map((i) => {
                      const b = docSet.bankAccounts[i];
                      return (
                        <div key={i} className="grid grid-cols-2 gap-2 @3xl:grid-cols-5">
                          <Input name={`bank${i}`} defaultValue={b?.bank} placeholder="銀行名" aria-label={`振込先${i + 1} 銀行名`} />
                          <Input name={`branch${i}`} defaultValue={b?.branch} placeholder="支店名" aria-label={`振込先${i + 1} 支店名`} />
                          <Select name={`type${i}`} defaultValue={b?.type ?? "普通"} aria-label={`振込先${i + 1} 種別`}><option value="普通">普通</option><option value="当座">当座</option></Select>
                          <Input name={`number${i}`} defaultValue={b?.number} placeholder="口座番号" inputMode="numeric" aria-label={`振込先${i + 1} 口座番号`} />
                          <Input name={`holder${i}`} defaultValue={b?.holder} placeholder="口座名義 (カナ)" aria-label={`振込先${i + 1} 口座名義`} className="col-span-2 @3xl:col-span-1" />
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                  <Field label="見積の有効期限 (日数)"><Input name="quoteValidDays" type="number" min={1} max={365} defaultValue={docSet.quoteValidDays} /></Field>
                  <Field label="請求書の支払期限 (発行日からの日数)"><Input name="paymentDays" type="number" min={0} max={365} defaultValue={docSet.paymentDays} /></Field>
                  <Field label="見積書の定型の備考" className="@xl:col-span-2"><Textarea name="quoteNote" defaultValue={docSet.quoteNote} /></Field>
                  <Field label="請求書の定型の備考" className="@xl:col-span-2"><Textarea name="invoiceNote" defaultValue={docSet.invoiceNote} /></Field>
                </div>
                <Button type="submit">保存</Button>
              </form>
            ) : (
              <dl className="mt-3 grid grid-cols-1 gap-2 text-sm @xl:grid-cols-2">
                <div><dt className="text-xs text-ink-3">会社名</dt><dd>{docSet.companyName}</dd></div>
                <div><dt className="text-xs text-ink-3">登録番号</dt><dd>{docSet.registrationNumber || "未設定"}</dd></div>
                <div><dt className="text-xs text-ink-3">住所</dt><dd>〒{docSet.postalCode} {docSet.address}</dd></div>
                <div><dt className="text-xs text-ink-3">電話</dt><dd>{docSet.tel || "-"}</dd></div>
                <div className="@xl:col-span-2"><dt className="text-xs text-ink-3">振込先</dt><dd>{docSet.bankAccounts.length ? docSet.bankAccounts.map((b) => `${b.bank} ${b.branch} ${b.type} ${b.number} ${b.holder}`).join(" / ") : "未設定"}</dd></div>
              </dl>
            )}
          </Card>
          <Card>
            <CardHeader title="帳票の出力" description="各画面の「PDF」から出力します" />
            <ul className="space-y-1.5 text-xs text-ink-2">
              <li>・見積書: 見積の画面 (改訂版ごとに出力できます)</li>
              <li>・請求書・領収書: 請求の画面、受注・施工の画面</li>
              <li>・書式: A4 縦。会社名・登録番号・振込先はこの画面の設定を使います</li>
              <li>・社内で決まった書式がある場合は、見本 (紙・PDF) をいただければ同じ配置に合わせます</li>
            </ul>
          </Card>
        </div>
      )}

      {tab === "kpi" && <KpiSettingsCard db={db} admin={admin} />}

      {tab === "ops" && (
        <Card>
          <CardHeader title="顧客の新規登録ができる人" description="重複登録を防ぐため、見積の訪問前に事務担当が顧客を登録する運用です。運用を始めてから店長にも広げられます" />
          <form action={updateOpsSettings} className="space-y-3">
            <fieldset disabled={!admin} className="space-y-2">
              {(Object.keys(CUSTOMER_CREATOR_LABEL) as (keyof typeof CUSTOMER_CREATOR_LABEL)[]).map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm"><input type="radio" name="customerCreators" value={k} defaultChecked={opsSettings(db).customerCreators === k} className="h-4 w-4" /> {CUSTOMER_CREATOR_LABEL[k]}</label>
              ))}
            </fieldset>
            <p className="text-[11px] text-ink-3">事務担当は 設定 → KPI・インセンティブ の「事務担当」で選んだ社員です。登録できない人には、顧客の検索 (既存のお客様の選択) と、事務担当への依頼の案内が表示されます。</p>
            {admin && <Button type="submit" size="sm">保存</Button>}
          </form>
        </Card>
      )}

      {tab === "rules" && (
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
          <Card>
            <CardHeader title="承認ルール" description="安全性と効率の両立: 日常的な登録は即時反映、重要な情報は承認を経て反映" />
            <table className="w-full text-sm">
              <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-1.5 text-left font-medium">対象</th><th className="px-3 py-1.5 text-left font-medium">条件</th><th className="px-3 py-1.5 text-left font-medium">承認者</th></tr></thead>
              <tbody className="text-xs">
                <tr className="border-t border-line"><td className="px-3 py-2">問い合わせ・現場情報・顧客のその他の項目の登録/変更</td><td className="px-3 py-2">-</td><td className="px-3 py-2">不要 (即時反映・履歴記録)</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">顧客の重要情報 (氏名・フリガナ・区分・電話・メール・住所) の変更</td><td className="px-3 py-2">{rules.customerChange ? "店舗スタッフ・本部スタッフの変更" : "承認なし (設定で変更可)"}</td><td className="px-3 py-2">{rules.customerChange ? "店長 (店長・管理者の変更は即時反映)" : "不要"}</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">見積の確定</td><td className="px-3 py-2">{yen(rules.quoteAdminThreshold)} 未満</td><td className="px-3 py-2">店長</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">見積の確定</td><td className="px-3 py-2">{yen(rules.quoteAdminThreshold)} 以上 / 本社案件</td><td className="px-3 py-2">管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">確定後の金額変更</td><td className="px-3 py-2">変更前後の高い方で判定</td><td className="px-3 py-2">店長 / 管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">受注 (契約) の確定</td><td className="px-3 py-2">見積と同じ基準額</td><td className="px-3 py-2">店長 / 管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">契約内容 (契約日・契約金額) の変更</td><td className="px-3 py-2">変更前後の高い方で判定</td><td className="px-3 py-2">店長 / 管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">経費精算</td><td className="px-3 py-2">{yen(rules.expenseAdminThreshold)} 未満</td><td className="px-3 py-2">店長</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">経費精算</td><td className="px-3 py-2">{yen(rules.expenseAdminThreshold)} 以上 / 本部分</td><td className="px-3 py-2">管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">仕入の支払依頼</td><td className="px-3 py-2">全件</td><td className="px-3 py-2">管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">見積・契約・経費 (店舗分)</td><td className="px-3 py-2">承認できる店長がいない (店長のいない店舗・店長本人の申請)</td><td className="px-3 py-2">管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">すべての申請</td><td className="px-3 py-2">申請者本人</td><td className="px-3 py-2">承認できない (ほかの承認者が判断)</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">請求書の無効化</td><td className="px-3 py-2">-</td><td className="px-3 py-2">本部 / 管理者のみ操作可</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">ユーザー・店舗・商品マスタの変更</td><td className="px-3 py-2">-</td><td className="px-3 py-2">管理者のみ操作可</td></tr>
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-ink-3">判断は「承認」「差戻し (修正して再申請)」「却下」の 3 つ。差戻し・却下は理由の入力が必要で、申請者に通知されます。すべて承認の履歴と変更履歴に残ります。</p>
            {admin && (
              <form action={updateApprovalSettings} className="mt-4 space-y-3 border-t border-line pt-4">
                <div className="text-sm font-medium text-ink">承認ルールを変更する</div>
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                  <Field label="見積・契約: 管理者の承認になる金額 (以上)"><Input name="quoteAdminThreshold" type="number" min={10000} step={1000} defaultValue={rules.quoteAdminThreshold} required /></Field>
                  <Field label="経費: 管理者の承認になる金額 (以上)"><Input name="expenseAdminThreshold" type="number" min={1000} step={1000} defaultValue={rules.expenseAdminThreshold} required /></Field>
                </div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="customerChange" defaultChecked={rules.customerChange} className="h-4 w-4" /> 顧客の重要情報 (氏名・フリガナ・区分・電話・メール・住所) の変更に承認を必要とする</label>
                <Button type="submit" size="sm">保存</Button>
                <p className="text-[11px] text-ink-3">変更は、これから申請するものに使われます (申請済みの承認者は変わりません)。変更は変更履歴に残ります。</p>
              </form>
            )}
          </Card>
          <Card>
            <CardHeader title="業務フローと情報の入口・出口" />
            <ol className="space-y-1.5 text-xs text-ink-2">
              <li>1. 問い合わせ (入口: {Object.values(CHANNEL_LABEL).join(" / ")})</li>
              <li>2. 顧客登録 (初回対応者がその場で登録・更新)</li>
              <li>3. 現地調査・採寸 → 予定表</li>
              <li>4. 見積 (手書き撮影 → AI 読取 → 社内書式) → 承認 → 送付 (出口: メール / LINE / Chatwork / 郵送 / 対面)</li>
              <li>5. 受注・契約承認 → 施工予定 → 進捗記録 → 施工完了 (売上計上)</li>
              <li>6. 請求書発行 → 送付 → 入金登録 → 売掛管理・督促</li>
              <li>7. 経費 (レシート撮影) → 承認 → 精算 / 仕入請求書 (撮影) → 支払承認 → 買掛・支払</li>
              <li>8. すべての操作が変更履歴に記録され、ダッシュボード・レポートにリアルタイム反映</li>
            </ol>
          </Card>
        </div>
      )}

      {tab === "integrations" && (
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
          <Card className="@2xl:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink">AI (書類の読取・アンケートはがきの読取・AI アシスタント)</div>
                <p className="mt-1 text-xs text-ink-2">
                  API キーを環境変数に 1 つ設定すると、書類取込の AI 読取 (手書き見積・図面・施工資料・請求書・レシート・アンケートはがき) と AI アシスタントが動作します。
                  OpenAI のキー (sk-…) は OPENAI_API_KEY、Anthropic のキー (sk-ant-…) は ANTHROPIC_API_KEY に設定します。ローカルは .env.local、本番は Vercel の Environment Variables に入れ、再起動 (再デプロイ) すると反映されます。
                </p>
                {ai.enabled && (
                  <p className="mt-2 text-xs text-ink-2">
                    接続先: <span className="font-medium text-ink">{ai.label}</span> · モデル: <span className="font-medium text-ink">{ai.model}</span> · キー: 環境変数 {ai.source} (値は表示しません)
                  </p>
                )}
                {ai.note && <p className="mt-2 text-xs text-warn-ink">⚠ {ai.note}</p>}
              </div>
              <Badge tone={ai.enabled ? "good" : "neutral"}>{ai.enabled ? "接続設定あり" : "未設定 (サンプルモード)"}</Badge>
            </div>
            {admin && <AiConnectionCheck enabled={ai.enabled} />}
          </Card>
          {integrationStatuses().map((i) => (
            <Card key={i.key}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">{i.name}</div>
                  <p className="mt-1 text-xs text-ink-2">送信: {i.detail}</p>
                  {i.inbound && (
                    <p className="mt-1 text-xs text-ink-2">
                      受信: {i.inbound.detail}
                      <br />
                      <span className="font-mono text-[11px] text-ink-3">{appBaseUrl()}{i.inbound.path}</span>
                    </p>
                  )}
                </div>
                <Badge tone={i.configured ? "good" : "neutral"}>{i.configured ? "接続設定あり" : "未設定 (記録のみ)"}</Badge>
              </div>
            </Card>
          ))}
          {canManageIntegrations(user) && (
            <Card className="@2xl:col-span-2">
              <CardHeader title="メール・LINE・Chatwork の接続" description="メールは SMTP (会社のメールアカウント) の設定でログインまで確かめます (届くかはテスト送信で)。ドメインを設定したら: ① APP_BASE_URL=https://<ドメイン> を設定して再起動 → ② 「LINE の Webhook URL をこのシステムに設定」→ ③ Chatwork は受信するルームごとに Webhook を作り (URL は下記、イベントは「メッセージ作成」)、トークンを CHATWORK_WEBHOOK_TOKEN にカンマ区切りで入れて再起動 → ④「接続を確認」" />
              <ul className="mb-3 space-y-1 text-xs text-ink-2">
                <li><span className="inline-block w-20 text-ink-3">LINE</span><span className="font-mono text-[11px] break-all">{appBaseUrl()}/api/integrations/line</span></li>
                <li><span className="inline-block w-20 text-ink-3">Chatwork</span><span className="font-mono text-[11px] break-all">{appBaseUrl()}/api/integrations/chatwork</span></li>
              </ul>
              <MessagingConnectionCheck webhookReady={/^https:\/\//.test(appBaseUrl()) && !/localhost|127\.0\.0\.1/.test(appBaseUrl())} />
            </Card>
          )}
          <LineGroupsCard db={db} admin={canManageIntegrations(user)} />
          {[
            { name: "Google スプレッドシート", status: "取込・書き出しに対応", ok: true, desc: "リンクで共有したシートから顧客・問い合わせを取込 (データ入出力の画面)。書き出した CSV はシートでインポート。非公開シートの直接連携はサービスアカウントの準備後。" },
            { name: "会計ソフト (弥生・freee・マネーフォワードなど)", status: "CSV で出力", ok: true, desc: "売上・入金・経費・仕入・現金出納の仕訳と明細を、会計データの出力 (/accounting) から CSV で出力します (汎用・弥生会計のインポート形式)。" },
          ].map((i) => (
            <Card key={i.name}>
              <div className="flex items-start justify-between gap-2">
                <div><div className="text-sm font-medium text-ink">{i.name}</div><p className="mt-1 text-xs text-ink-2">{i.desc}</p></div>
                <Badge tone={i.ok ? "good" : "neutral"}>{i.status}</Badge>
              </div>
            </Card>
          ))}
          {(() => {
            const intake = aiIntakeSettings(db);
            const base = appBaseUrl();
            return (
              <Card className="@2xl:col-span-2">
                <CardHeader title="既存の AI システムからの受付 (AI テキスト相談・AI 音声相談・AI 電話受付)" description="各 AI システムの「受付が終わったときの送信 (Webhook)」を下の URL に設定すると、受付ごとに問い合わせを登録し、会話の記録をやりとり履歴に残して、担当者に引き継ぎます。同じ受付 ID は 1 件だけ登録します" />
                <ul className="mb-3 space-y-1 text-xs text-ink-2">
                  {(["chat", "voice", "phone"] as const).map((k) => (
                    <li key={k}><span className="inline-block w-28 text-ink-3">{k === "chat" ? "AI テキスト相談" : k === "voice" ? "AI 音声相談" : "AI 電話受付"}</span><span className="font-mono text-[11px] break-all">POST {base}/api/integrations/ai-intake?source={k}</span></li>
                  ))}
                  <li className="text-ink-3">認証: ヘッダー Authorization: Bearer &lt;AI_INTAKE_SECRET&gt; (ヘッダーを設定できないシステムは URL の末尾に &amp;token=&lt;AI_INTAKE_SECRET&gt;)。受け取る項目: name・phone・email・address・summary (要約)・purpose (用件)・transcript (会話)・desiredDate (希望日)・callbackPhone (折返し先)・store (店舗)・handoff (引き継ぎが必要)・urgency・id (受付 ID) など</li>
                </ul>
                <form action={updateAiIntakeSettings} className="space-y-3">
                  <fieldset disabled={!admin} className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                    <Field label="店舗が分からないときの登録先">
                      <Select name="defaultStore" defaultValue={intake.defaultStore}>
                        {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="担当者への引き継ぎ">
                      <Select name="handoff" defaultValue={intake.handoff}>
                        {(Object.keys(HANDOFF_MODE_LABEL) as HandoffMode[]).map((m) => <option key={m} value={m}>{HANDOFF_MODE_LABEL[m]}</option>)}
                      </Select>
                    </Field>
                    {db.stores.map((s) => (
                      <Field key={s.id} label={`引き継ぎ先: ${s.name}`} hint="未設定は店長">
                        <Select name={`assignee_${s.id}`} defaultValue={intake.assignees[s.id] ?? ""}>
                          <option value="">店長 ({userName(s.managerUserId)})</option>
                          {db.users.filter((u) => u.active && (u.storeId === s.id || u.role === "admin" || u.role === "hq_staff")).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </Select>
                      </Field>
                    ))}
                  </fieldset>
                  {admin && <Button type="submit" size="sm">保存</Button>}
                </form>
              </Card>
            );
          })()}
          {(() => {
            const ns = notifySettings(db);
            const events = Object.keys(NOTIFY_EVENT_LABEL) as NotifyEvent[];
            return (
              <Card className="@2xl:col-span-2">
                <CardHeader title="社内通知 (メール・Chatwork)" description="承認依頼・承認の結果・メンション・業務依頼を、画面のお知らせに加えてメールと Chatwork でも知らせます。メールは「メールで通知を受け取る」にした社員だけに送ります (プロフィール、または 設定 → ユーザー → 各社員)" />
                <form action={updateNotifySettings} className="space-y-3">
                  <fieldset disabled={!admin}>
                    <table className="w-full text-sm">
                      <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-1.5 text-left font-medium">通知</th><th className="px-3 py-1.5 text-center font-medium">メール</th><th className="px-3 py-1.5 text-center font-medium">Chatwork (社内ルーム{chatworkConfig()?.roomId ? "" : "・未設定"})</th></tr></thead>
                      <tbody>
                        {events.map((e) => (
                          <tr key={e} className="border-t border-line">
                            <td className="px-3 py-1.5">{NOTIFY_EVENT_LABEL[e]}</td>
                            <td className="px-3 py-1.5 text-center"><input type="checkbox" name={`email_${e}`} defaultChecked={ns.email[e]} className="h-4 w-4" aria-label={`メール: ${NOTIFY_EVENT_LABEL[e]}`} /></td>
                            <td className="px-3 py-1.5 text-center"><input type="checkbox" name={`chatwork_${e}`} defaultChecked={ns.chatwork[e]} className="h-4 w-4" aria-label={`Chatwork: ${NOTIFY_EVENT_LABEL[e]}`} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </fieldset>
                  {admin && <Button type="submit" size="sm">保存</Button>}
                </form>
              </Card>
            );
          })()}
          {canManageIntegrations(user) && (
            <Card>
              <CardHeader title="接続の確認 (テスト送信)" description="設定した送信が届くかを確かめます。送信の結果は下の送信履歴に残ります" />
              <form action={sendTestMessage} className="space-y-2">
                <Field label="サービス">
                  <Select name="channel" defaultValue="email">
                    <option value="email">メール</option>
                    <option value="line">LINE</option>
                    <option value="chatwork">Chatwork</option>
                  </Select>
                </Field>
                <Field label="宛先" hint="メールアドレス / LINE のユーザー ID / Chatwork のルーム ID (空欄で社内通知のルーム)"><Input name="to" /></Field>
                <Button type="submit" size="sm" variant="secondary">テスト送信</Button>
              </form>
            </Card>
          )}
          {canManageIntegrations(user) && (
            <Card className="@2xl:col-span-2" padded={false}>
              <div className="px-5 pt-5"><CardHeader title="送信履歴 (新しい順・50 件)" description="メール・LINE・Chatwork で送った通知・帳票・連絡。設定がないため送らなかったものは「記録のみ」です" /></div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">日時</th><th className="px-3 py-2 text-left font-medium">手段</th><th className="px-3 py-2 text-left font-medium">宛先</th><th className="px-3 py-2 text-left font-medium">件名・内容</th><th className="px-3 py-2 text-left font-medium">結果</th></tr></thead>
                  <tbody>
                    {[...db.deliveries].reverse().slice(0, 50).map((d) => (
                      <tr key={d.id} className="border-t border-line align-top">
                        <td className="px-4 py-2 text-xs tnum text-ink-3">{fmtDateTime(d.createdAt)}<div>{userName(d.userId)}</div></td>
                        <td className="px-3 py-2 text-xs">{DELIVERY_CHANNEL_LABEL[d.channel]}<div className="text-ink-3">{{ notify: "社内通知", document: "帳票の送付", message: "個別の連絡", test: "接続の確認" }[d.purpose]}</div></td>
                        <td className="px-3 py-2 text-xs">{d.recipientLabel ?? ""}<div className="font-mono text-[11px] text-ink-3">{d.recipient}</div></td>
                        <td className="px-3 py-2 text-xs"><div className="font-medium text-ink">{d.subject ?? ""}</div><div className="line-clamp-2 text-ink-3">{d.body}</div>{d.attachments?.length ? <div className="text-[11px] text-ink-3">添付: {d.attachments.join("、")}</div> : null}</td>
                        <td className="px-3 py-2 text-xs"><Badge tone={DELIVERY_STATUS[d.status].tone}>{DELIVERY_STATUS[d.status].label}</Badge>{d.error && <div className="mt-1 text-[11px] text-critical">{d.error}</div>}</td>
                      </tr>
                    ))}
                    {db.deliveries.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-ink-3">送信履歴はありません</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === "golive" && (admin ? <GoLivePanel db={db} /> : <Note>本番運用の準備の確認は管理者が行います。</Note>)}

      {tab === "data" && (
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
          <Card>
            <CardHeader title="データのエクスポート" description="特定サービスに依存せず、いつでもデータを取り出せます" />
            {canExportData(user) ? (
            <div className="flex flex-wrap gap-2">
              <LinkButton href="/data" size="sm">データ入出力 (CSV の取込・書き出し)</LinkButton>
              <LinkButton href="/api/export?type=db" variant="secondary" size="sm" download>全データ (JSON)</LinkButton>
              <LinkButton href="/api/export?type=customers" variant="secondary" size="sm" download>顧客一覧 (CSV)</LinkButton>
              <LinkButton href="/api/export?type=sales" variant="secondary" size="sm" download>月次売上 (CSV)</LinkButton>
            </div>
            ) : (
              <p className="text-sm text-ink-3">データの書き出しは管理者・本部スタッフが行えます。</p>
            )}
            <p className="mt-3 text-[11px] text-ink-3">
              保存先: {BACKEND === "supabase" ? "Supabase (PostgreSQL)" : `ローカルファイル data/${process.env.DATA_FILE_NAME ?? "db.json"}`}
              {db.meta.importedAt ? ` · クライアント資料から取込 ${fmtDateTime(db.meta.importedAt)}` : ` · サンプル生成 ${fmtDateTime(db.meta.seededAt)}`} · 件数: 顧客 {db.customers.length} / 問い合わせ {db.inquiries.length} / 受注 {db.orders.length} / 予定 {db.schedule.length} / アンケート {db.surveys.length} / 資料 {db.sourceFiles.length} / 履歴 {db.auditLogs.length}
            </p>
          </Card>
          {BACKEND === "json" && !db.meta.importedAt ? (
            <Card>
              <CardHeader title="サンプルデータの初期化" description="検証で変更したデータを初期状態に戻します (管理者のみ・ローカル検証環境のみ)" />
              {admin ? (
                <form action={resetSampleData}><Button type="submit" variant="danger">サンプルデータを初期化する</Button></form>
              ) : (
                <p className="text-sm text-ink-3">管理者でログインすると初期化できます。</p>
              )}
            </Card>
          ) : (
            <Card>
              <CardHeader title="本番データ" description="一畳屋の業務資料 (Google ドライブの共有資料 9 フォルダ) から移行したデータです" />
              <p className="text-xs leading-relaxed text-ink-2">サンプルデータへの初期化はできません。取込をやり直す場合は、開発担当が取込スクリプト (scripts/import) を実行します。資料ごとの取込先は「資料・写真」画面で確認できます。</p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
