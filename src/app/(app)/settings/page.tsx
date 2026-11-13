import { requireUser } from "@/lib/auth/session";
import { BACKEND, getDb } from "@/lib/db/store";
import { canExportData, canManageSettings } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { createProduct, createUser, resetUserPassword, toggleUserActive, updateProduct, updateStore, updateUserRole } from "@/lib/actions/settings";
import { resetSampleData } from "@/lib/actions/auth";
import { aiEnabled } from "@/lib/ai/ocr";
import { fmtDateTime, yen } from "@/lib/format";
import { APPROVAL_RULES, CATEGORY_LABEL, CHANNEL_LABEL, ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import type { Role, ServiceCategory } from "@/lib/db/types";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Select, StoreTag } from "@/components/ui";
import Link from "@/components/ui/Link";
import { PermissionTableCard } from "@/components/settings/PermissionTableCard";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const admin = canManageSettings(user);
  const tab = sp.tab ?? "users";
  const base = "/settings";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title={admin ? "設定" : "設定 (閲覧のみ)"} badge={!admin && <Badge tone="neutral">変更は管理者のみ</Badge>} />
      <LinkTabs
        current={`${base}?tab=${tab}`}
        items={[
          { href: `${base}?tab=users`, label: "ユーザーと権限", count: db.users.length },
          { href: `${base}?tab=stores`, label: "店舗" },
          { href: `${base}?tab=products`, label: "商品マスタ", count: db.products.length },
          { href: `${base}?tab=rules`, label: "承認ルール・業務フロー" },
          { href: `${base}?tab=integrations`, label: "外部連携・AI" },
          { href: `${base}?tab=data`, label: "データ管理" },
        ]}
      />

      {tab === "users" && (
        <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
          <Card className="@4xl:col-span-2" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">氏名</th><th className="px-3 py-2 text-left font-medium">ロール</th><th className="px-3 py-2 text-left font-medium">所属</th>{admin && <th className="px-3 py-2 text-left font-medium">ログイン ID</th>}<th className="px-3 py-2 text-left font-medium">状態</th>{admin && <th className="px-4 py-2" />}</tr></thead>
                <tbody>
                  {db.users.map((u) => (
                    <tr key={u.id} className="border-t border-line">
                      <td className="px-4 py-2"><div className="font-medium">{admin ? <Link href={`/settings/users/${u.id}`} className="text-accent hover:underline">{u.name}</Link> : u.name}</div><div className="text-[11px] text-ink-3">{u.title}</div></td>
                      <td className="px-3 py-2 text-xs">{ROLE_LABEL[u.role]}</td>
                      <td className="px-3 py-2"><StoreTag store={db.stores.find((s) => s.id === u.storeId)} short /></td>
                      {admin && <td className="px-3 py-2 font-mono text-[11px] text-ink-2">{u.email}</td>}
                      <td className="px-3 py-2"><Badge tone={u.active ? "good" : "neutral"}>{u.active ? "有効" : "無効"}</Badge></td>
                      {admin && <td className="px-4 py-2 text-right"><form action={toggleUserActive.bind(null, u.id)}><Button type="submit" size="sm" variant="ghost" disabled={u.id === user.id}>{u.active ? "無効化" : "有効化"}</Button></form></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="space-y-4">
            <Card>
              <CardHeader title="ロールと権限" />
              <ul className="space-y-2 text-xs text-ink-2">
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <li key={r}><span className="font-medium text-ink">{ROLE_LABEL[r]}</span>: {ROLE_DESCRIPTION[r]}</li>)}
              </ul>
            </Card>
            {admin && (
              <Card>
                <CardHeader title="ユーザーを追加" />
                <form action={createUser} className="space-y-2">
                  <Field label="氏名" required><Input name="name" required /></Field>
                  <Field label="フリガナ"><Input name="kana" /></Field>
                  <Field label="ログイン ID (メールアドレス可)" required><Input name="email" required autoCapitalize="none" /></Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="ロール"><Select name="role" defaultValue="store_staff">{(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
                    <Field label="所属"><Select name="storeId" defaultValue="koshi">{db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                  </div>
                  <Field label="役職・担当"><Input name="title" placeholder="例: 営業・受付" /></Field>
                  <Field label="初期パスワード (8 文字以上)" required><Input name="password" type="password" required minLength={8} autoComplete="new-password" /></Field>
                  <Button type="submit" size="sm">追加する</Button>
                </form>
              </Card>
            )}
            {admin && (
              <Card>
                <CardHeader title="ロール・所属の変更" description="移行時にロール・所属を推定で設定しています。実際と異なる場合はここで直します (空欄の項目は変更しません)" />
                <form action={updateUserRole} className="space-y-2">
                  <Field label="ユーザー">
                    <Select name="userId" required defaultValue="">
                      <option value="" disabled>
                        選択してください
                      </option>
                      {db.users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({ROLE_LABEL[u.role]} / {db.stores.find((s) => s.id === u.storeId)?.name ?? u.storeId})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="新しいロール"><Select name="role" defaultValue=""><option value="">変更しない</option>{(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
                    <Field label="新しい所属"><Select name="storeId" defaultValue=""><option value="">変更しない</option>{db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                  </div>
                  <Field label="役職・担当 (空欄なら変更しない)"><Input name="title" placeholder="例: 店長" /></Field>
                  <Button type="submit" size="sm" variant="secondary">変更する</Button>
                </form>
              </Card>
            )}
            {admin && (
              <Card>
                <CardHeader title="パスワードの再設定" description="パスワードを忘れた社員の代わりに管理者が設定します" />
                <form action={resetUserPassword} className="space-y-2">
                  <Field label="ユーザー">
                    <Select name="userId" required defaultValue="">
                      <option value="" disabled>
                        選択してください
                      </option>
                      {db.users
                        .filter((u) => u.active)
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} ({u.email})
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label="新しいパスワード (8 文字以上)" required><Input name="password" type="password" required minLength={8} autoComplete="new-password" /></Field>
                  <Button type="submit" size="sm" variant="secondary">再設定する</Button>
                </form>
              </Card>
            )}
          </div>
        </div>
        <PermissionTableCard />
        </div>
      )}

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

      {tab === "rules" && (
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
          <Card>
            <CardHeader title="承認ルール" description="安全性と効率の両立: 日常的な登録は即時反映、重要な情報は承認を経て反映" />
            <table className="w-full text-sm">
              <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-1.5 text-left font-medium">対象</th><th className="px-3 py-1.5 text-left font-medium">条件</th><th className="px-3 py-1.5 text-left font-medium">承認者</th></tr></thead>
              <tbody className="text-xs">
                <tr className="border-t border-line"><td className="px-3 py-2">顧客・問い合わせ・現場情報の登録/変更</td><td className="px-3 py-2">-</td><td className="px-3 py-2">不要 (即時反映・履歴記録)</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">見積の確定</td><td className="px-3 py-2">{yen(APPROVAL_RULES.quoteAdminThreshold)} 未満</td><td className="px-3 py-2">店長</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">見積の確定</td><td className="px-3 py-2">{yen(APPROVAL_RULES.quoteAdminThreshold)} 以上 / 本社案件</td><td className="px-3 py-2">管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">確定後の金額変更</td><td className="px-3 py-2">変更前後の高い方で判定</td><td className="px-3 py-2">店長 / 管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">受注 (契約) の確定</td><td className="px-3 py-2">見積と同じ閾値</td><td className="px-3 py-2">店長 / 管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">経費精算</td><td className="px-3 py-2">{yen(APPROVAL_RULES.expenseAdminThreshold)} 未満</td><td className="px-3 py-2">店長</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">経費精算</td><td className="px-3 py-2">{yen(APPROVAL_RULES.expenseAdminThreshold)} 以上 / 本部分</td><td className="px-3 py-2">管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">仕入請求書の支払</td><td className="px-3 py-2">全件</td><td className="px-3 py-2">管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">見積・契約・経費 (店舗分)</td><td className="px-3 py-2">承認できる店長がいない (店長のいない店舗・店長本人の申請)</td><td className="px-3 py-2">管理者</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">すべての申請</td><td className="px-3 py-2">申請者本人</td><td className="px-3 py-2">承認できない (ほかの承認者が判断)</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">請求書の無効化</td><td className="px-3 py-2">-</td><td className="px-3 py-2">本部 / 管理者のみ操作可</td></tr>
                <tr className="border-t border-line"><td className="px-3 py-2">ユーザー・店舗・商品マスタの変更</td><td className="px-3 py-2">-</td><td className="px-3 py-2">管理者のみ操作可</td></tr>
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-ink-3">閾値は src/lib/constants.ts の APPROVAL_RULES で変更できます (本番では設定画面から変更可能にする想定)。</p>
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
          {[
            { name: "Claude API (AI 読取・アシスタント)", status: aiEnabled() ? "接続中" : "未設定 (サンプルモード)", ok: aiEnabled(), desc: "ANTHROPIC_API_KEY を .env に設定すると、書類の AI 読取と AI アシスタントが実際の Claude で動作します。" },
            { name: "AI 電話受付", status: "本番で接続", ok: false, desc: "通話内容の要約・用件・折返し先を Webhook で受け取り、問い合わせとして自動登録 (入口: AI電話受付)。" },
            { name: "LINE 公式アカウント", status: "本番で接続", ok: false, desc: "Messaging API で受信メッセージを問い合わせ/やりとり履歴に自動記録。見積書・請求書の PDF 送付。" },
            { name: "Web フォーム (ichijoya.co.jp)", status: "本番で接続", ok: false, desc: "お問い合わせフォームの送信を API で受け取り、問い合わせとして自動登録。" },
            { name: "メール (送受信)", status: "本番で接続", ok: false, desc: "見積書・請求書の送付、受信メールの取り込み (SendGrid / Gmail API 等)。" },
            { name: "Chatwork", status: "本番で接続", ok: false, desc: "取引先・協力業者とのやりとりを履歴に集約。" },
            { name: "Google スプレッドシート", status: "取込・書き出しに対応", ok: true, desc: "リンクで共有したシートから顧客・問い合わせを取込 (データ入出力の画面)。書き出した CSV はシートでインポート。非公開シートの直接連携はサービスアカウントの準備後。" },
            { name: "会計ソフト (freee / MF 等)", status: "本番で接続", ok: false, desc: "売上・経費・買掛の仕訳データを連携。" },
          ].map((i) => (
            <Card key={i.name}>
              <div className="flex items-start justify-between gap-2">
                <div><div className="text-sm font-medium text-ink">{i.name}</div><p className="mt-1 text-xs text-ink-2">{i.desc}</p></div>
                <Badge tone={i.ok ? "good" : "neutral"}>{i.status}</Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

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
