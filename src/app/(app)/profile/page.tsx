import Link from "@/components/ui/Link";
import type { Metadata } from "next";
import { AtSign, Building, CalendarDays, Camera, ClipboardCheck, Hammer, Inbox, KeyRound, Mail, Phone, Shield, ShieldCheck, Users } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canApprove, canApproveAll, canManageCompanyEvents, canManageFinance, canManageSettings, canManageUsers, canSeeAllStores, isDemoAccount, isManagerOrAbove } from "@/lib/auth/permissions";
import { customerName, storeById, storeName, userName } from "@/lib/db/queries";
import { addDays, fmtDate, fmtDateTime, toDateKey, yen } from "@/lib/format";
import { APPROVAL_TYPE_LABEL, AUDIT_ACTION_LABEL, ENTITY_LABEL, INQUIRY_STATUS, ORDER_STATUS, ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import { Avatar, Badge, Button, Card, CardHeader, ChannelTag, Field, Flash, Input, LinkButton, Note, PageHeader, Stat, StatusBadge, StoreTag } from "@/components/ui";
import { changeOwnLoginId, changeOwnPassword } from "@/lib/actions/auth";
import { accountEditLocked, avatarUrl, credentialStatus, PASSWORD_LOCK_MESSAGE } from "@/lib/account-rules";
import { AvatarUploader } from "@/components/settings/AvatarUploader";
import { updateOwnNotify } from "@/lib/actions/settings-ops";
import { approvalSettings } from "@/lib/approval-rules";
import { NotifyPrefsForm } from "@/components/settings/NotifyPrefsForm";
import { analyzeConflicts, compareEvents, overlapsRange, timeLabel } from "@/lib/calendar";
import { ConflictBadge, KindBadge } from "@/components/schedule/parts";

export const metadata: Metadata = { title: "プロフィール" };

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const weekEnd = addDays(today, 7);
  const store = storeById(user.storeId);
  const allStores = canSeeAllStores(user);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));

  const myInquiries = db.inquiries
    .filter((i) => i.assignedUserId === user.id && (i.status === "new" || i.status === "in_progress"))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const myJobs = db.orders
    .filter((o) => (o.workerIds.includes(user.id) || o.createdBy === user.id) && ["confirmed", "scheduled", "in_progress"].includes(o.status))
    .sort((a, b) => (a.scheduledStart ?? "9999").localeCompare(b.scheduledStart ?? "9999"));
  const myRequests = db.approvals.filter((a) => a.requestedBy === user.id && a.status === "pending");
  const toDecide = db.approvals.filter((a) => a.status === "pending" && canApprove(user, a));
  const myEvents = db.schedule.filter((e) => e.assigneeIds.includes(user.id) && overlapsRange(e, today, weekEnd)).sort(compareEvents);
  const myConflictIds = new Set(analyzeConflicts(myEvents).pairs.filter((p) => p.userId === user.id).flatMap((p) => [p.aId, p.bId]));
  const myLogs = db.auditLogs.filter((l) => l.userId === user.id && l.entity !== "session").slice(-10).reverse();
  const myCustomers = db.customers.filter((c) => c.assignedUserId === user.id).length;
  const loginCount = db.auditLogs.filter((l) => l.userId === user.id && l.action === "login").length;
  const initialPassword = !isDemoAccount(user) && credentialStatus(db.auditLogs, user.id).password === "initial";
  const passwordLocked = accountEditLocked();

  const permissions: { ok: boolean; label: string }[] = [
    { ok: true, label: allStores ? "全店舗の顧客・問い合わせ・見積・案件・請求を閲覧" : `${storeName(user.storeId)} の顧客・問い合わせ・見積・案件・請求を閲覧` },
    {
      ok: isManagerOrAbove(user),
      label:
        canApproveAll(user)
          ? "全案件の承認 (店長承認・管理者承認の両方)。自分の申請 (見積・契約・経費・仕入の支払) は承認なしでそのまま反映"
          : `自店舗の店長承認 (見積・契約 ${approvalSettings(db).quoteAdminThreshold.toLocaleString("ja-JP")} 円未満、経費 ${approvalSettings(db).expenseAdminThreshold.toLocaleString("ja-JP")} 円未満。自分の申請を除く)`,
    },
    { ok: canManageFinance(user) || isManagerOrAbove(user), label: `請求書の発行 (${allStores ? "全店舗" : "自店舗"})` },
    { ok: true, label: `入金の登録 (${allStores ? "全店舗" : "自店舗"})` },
    { ok: canManageFinance(user), label: "請求書の無効化、仕入請求書 (買掛) の登録・支払処理" },
    { ok: canManageUsers(user), label: canManageSettings(user) ? "すべてのアカウントの追加・削除・権限の変更、新規登録の申請の承認" : `${storeName(user.storeId)} の店舗スタッフのアカウントの追加・削除、新規登録の申請の承認` },
    { ok: canManageSettings(user), label: "店舗・商品マスタ・運用ルールの変更、サンプルデータの初期化" },
    { ok: true, label: `予定表で全社員・全店舗の予定を閲覧し、${allStores ? "全店舗" : storeName(user.storeId)}の予定を登録・変更 (担当になった他店舗の予定も変更可)` },
    { ok: canManageCompanyEvents(user), label: "全社共通の予定 (社内行事・全社会議など全店舗のカレンダーに載る予定) の登録" },
  ];

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader title="プロフィール" />

      {initialPassword && (
        <div className="mb-6">
          <Note tone="warn">
            <span className="font-medium">初期パスワードのままです。</span>
            {passwordLocked
              ? " テスト期間中のため、現在はパスワードを変更できません。テスト期間の設定を解除したあとに変更してください。"
              : <> 配られたパスワードはほかの人も知っているため、下の <a href="#password" className="font-medium underline">パスワードの変更</a> で、自分だけが知っているパスワード (8 文字以上) に変更してください。ログイン ID (メールアドレス) もこの画面で変えられます。</>}
          </Note>
        </div>
      )}

      <Card className="mb-6 overflow-hidden" padded={false}>
        <div className="grid grid-cols-1 gap-6 p-5 @xl:p-6 @3xl:grid-cols-5">
          <div className="@3xl:col-span-3">
            <div className="flex items-start gap-4">
              <Avatar name={user.name} id={user.id} size={64} ring src={avatarUrl(user)} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold tracking-tight text-ink">{user.name}</h2>
                  <Badge tone="accent" dot={false}>{ROLE_LABEL[user.role]}</Badge>
                </div>
                <div className="mt-0.5 text-xs text-ink-3">{user.kana}</div>
                <div className="mt-1 text-sm text-ink-2">{user.title}</div>
                <p className="mt-2 text-xs leading-relaxed text-ink-3">{ROLE_DESCRIPTION[user.role]}</p>
              </div>
            </div>
            <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 text-sm @xl:grid-cols-2">
              <div className="flex items-start gap-2.5">
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                <div className="min-w-0"><dt className="text-xs text-ink-3">ログイン ID (メールアドレス)</dt><dd className="truncate font-mono text-[13px] text-ink">{user.email}</dd></div>
              </div>
              <div className="flex items-start gap-2.5">
                <Phone className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                <div><dt className="text-xs text-ink-3">電話</dt><dd className="text-ink tnum">{user.phone ?? "-"}</dd></div>
              </div>
              <div className="flex items-start gap-2.5">
                <Building className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                <div><dt className="text-xs text-ink-3">所属</dt><dd className="text-ink"><StoreTag store={store} />{store && <span className="ml-1 text-xs text-ink-3">{store.address}</span>}</dd></div>
              </div>
              <div className="flex items-start gap-2.5">
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                <div><dt className="text-xs text-ink-3">ログイン</dt><dd className="text-ink">これまで {loginCount} 回 · 担当顧客 {myCustomers} 件</dd></div>
              </div>
            </dl>
          </div>
          <div className="rounded-2xl bg-subtle/70 p-4 @3xl:col-span-2">
            <div className="mb-3 text-xs font-semibold tracking-wide text-ink-2">このアカウントでできること</div>
            <ul className="space-y-2.5">
              {permissions.map((p) => (
                <li key={p.label} className={`flex items-start gap-2.5 text-sm ${p.ok ? "text-ink" : "text-ink-3"}`}>
                  {p.ok ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden /> : <Shield className="mt-0.5 h-4 w-4 shrink-0 text-ink-3/60" aria-hidden />}
                  <span className={p.ok ? "" : "line-through decoration-ink-3/40"}>{p.label}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-3">権限は src/lib/auth/permissions.ts のルールで判定され、画面ごとにロール名を直接比較しません。</p>
          </div>
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="担当中の問い合わせ" value={`${myInquiries.length} 件`} sub="新規・対応中" icon={<Inbox />} accent="info" href="/inquiries" />
        <Stat label="担当中の受注・施工" value={`${myJobs.length} 件`} sub="受注確定 〜 施工中" icon={<Hammer />} accent="accent" href="/orders" />
        <Stat
          label={toDecide.length > 0 ? "あなたの承認待ち" : "申請中の承認"}
          value={`${toDecide.length > 0 ? toDecide.length : myRequests.length} 件`}
          sub={toDecide.length > 0 ? `ほかに申請中 ${myRequests.length} 件` : "承認者の確認を待っています"}
          icon={<ClipboardCheck />}
          tone={toDecide.length > 0 ? "warn" : undefined}
          href={toDecide.length > 0 ? "/approvals?tab=mine" : "/approvals?tab=requested"}
        />
        <Stat label="今後 7 日間の予定" value={`${myEvents.length} 件`} sub={myConflictIds.size > 0 ? <span className="text-critical-ink">重複している予定があります</span> : myEvents[0] ? `次: ${fmtDate(myEvents[0].date)} ${myEvents[0].startTime ?? ""} ${myEvents[0].title}` : "予定はありません"} icon={<CalendarDays />} accent="good" tone={myConflictIds.size > 0 ? "critical" : undefined} href="/schedule?view=list&user=me&store=all" />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <Card>
          <CardHeader title="今後 7 日間の予定" description="あなたが担当者に含まれる予定 (全店舗)" icon={<CalendarDays />} action={<Link href="/schedule?view=list&user=me&store=all" className="text-xs font-medium text-accent hover:underline">自分の予定 →</Link>} />
          <ul className="divide-y divide-line">
            {myEvents.length === 0 && <li className="py-6 text-center text-sm text-ink-3">予定はありません</li>}
            {myEvents.slice(0, 8).map((e) => (
              <li key={e.id}>
                <Link href={`/schedule/${e.id}`} className="flex gap-3 py-2.5 hover:bg-subtle/60">
                  <div className="w-24 shrink-0 text-xs text-ink-2 tnum">
                    <div className={e.date <= today ? "font-semibold text-accent-ink" : "font-medium text-ink"}>{e.date <= today ? "今日" : fmtDate(e.date).slice(5)}</div>
                    <div>{timeLabel(e)}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{e.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                      <KindBadge kind={e.kind} />
                      {myConflictIds.has(e.id) && <ConflictBadge />}
                      {e.location && <span className="truncate">{e.location}</span>}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="担当中の問い合わせ" description="初回対応・見積作成が必要なもの" icon={<Inbox />} action={<Link href="/inquiries" className="text-xs font-medium text-accent hover:underline">一覧 →</Link>} />
          <ul className="divide-y divide-line">
            {myInquiries.length === 0 && <li className="py-6 text-center text-sm text-ink-3">担当中の問い合わせはありません</li>}
            {myInquiries.slice(0, 6).map((i) => (
              <li key={i.id} className="py-2.5">
                <Link href={`/inquiries/${i.id}`} className="flex items-center gap-2 hover:text-accent">
                  <StatusBadge value={i.status} map={INQUIRY_STATUS} />
                  <ChannelTag channel={i.channel} />
                  <span className="truncate text-sm text-ink">{i.summary}</span>
                </Link>
                <div className="mt-1 text-[11px] text-ink-3">
                  {i.contactName} · {storeMap.get(i.storeId)?.shortName} · 受付 {fmtDate(i.receivedAt)}
                  {i.nextAction && <span className="ml-2 text-warn-ink">次: {i.nextAction}{i.nextActionDue ? ` (${fmtDate(i.nextActionDue)})` : ""}</span>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <Card>
          <CardHeader title="担当中の受注・施工" description="施工担当または登録者として関わっている案件" icon={<Hammer />} action={<Link href="/orders" className="text-xs font-medium text-accent hover:underline">一覧 →</Link>} />
          <ul className="divide-y divide-line">
            {myJobs.length === 0 && <li className="py-6 text-center text-sm text-ink-3">進行中の案件はありません</li>}
            {myJobs.slice(0, 6).map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <Link href={`/orders/${o.id}`} className="block truncate text-sm text-ink hover:text-accent">{customerName(o.customerId)} 様 · {o.title}</Link>
                  <div className="mt-0.5 text-[11px] text-ink-3">{o.number} · {storeMap.get(o.storeId)?.shortName} · 施工予定 {fmtDate(o.scheduledStart)}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm tnum">{yen(o.total)}</div>
                  <StatusBadge value={o.status} map={ORDER_STATUS} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title={toDecide.length > 0 ? "あなたの承認待ち" : "あなたの申請"} description={toDecide.length > 0 ? "内容を確認して承認または却下してください" : "承認者の確認を待っている申請"} icon={<ClipboardCheck />} action={<Link href="/approvals" className="text-xs font-medium text-accent hover:underline">承認一覧 →</Link>} />
          <ul className="divide-y divide-line">
            {(toDecide.length > 0 ? toDecide : myRequests).slice(0, 6).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink">{a.title}</div>
                  <div className="mt-0.5 text-[11px] text-ink-3">{APPROVAL_TYPE_LABEL[a.type]} · {storeMap.get(a.storeId)?.shortName} · 申請 {userName(a.requestedBy)} {fmtDateTime(a.createdAt)}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-medium tnum">{yen(a.amount)}</div>
                  <Badge tone={a.requiredRole === "admin" ? "serious" : "warn"} dot={false}>{a.requiredRole === "admin" ? "管理者承認" : "店長承認"}</Badge>
                </div>
              </li>
            ))}
            {toDecide.length === 0 && myRequests.length === 0 && <li className="py-6 text-center text-sm text-ink-3">承認待ち・申請中の案件はありません</li>}
          </ul>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader title="最近のあなたの操作" description="登録・変更・承認はすべて変更履歴に記録されます" icon={<Users />} action={<Link href="/audit" className="text-xs font-medium text-accent hover:underline">変更履歴 →</Link>} />
        <ul className="divide-y divide-line">
          {myLogs.length === 0 && <li className="py-6 text-center text-sm text-ink-3">まだ操作履歴はありません</li>}
          {myLogs.map((l) => (
            <li key={l.id} className="flex items-start gap-3 py-2.5">
              <Badge tone={l.action === "approve" ? "good" : l.action === "reject" || l.action === "delete" ? "critical" : l.action === "submit" ? "warn" : "neutral"} dot={false}>{AUDIT_ACTION_LABEL[l.action]}</Badge>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">{l.summary}</div>
                <div className="text-[11px] text-ink-3">{ENTITY_LABEL[l.entity] ?? l.entity} · {l.entityLabel} · {fmtDateTime(l.at)}</div>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mb-6">
        <CardHeader title="通知の受け取り方" description="画面のお知らせに加えて、メール・Chatwork で受け取る設定です" icon={<Mail />} />
        <NotifyPrefsForm u={user} action={updateOwnNotify} />
      </Card>

      <div className="mb-6 grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <Card>
          <CardHeader title="顔写真" description="社内の画面で、あなたの名前の横に表示されます" icon={<Camera />} />
          <AvatarUploader name={user.name} id={user.id} src={avatarUrl(user)} />
        </Card>
        <Card>
          <CardHeader title="ログイン ID (メールアドレス) の変更" description="次回のログインから新しい ID を使います。確認のため現在のパスワードを入力してください" icon={<AtSign />} />
          {isDemoAccount(user) ? (
            <p className="text-xs text-ink-3">デモ用アカウントのログイン ID は変更できません。</p>
          ) : (
            <form action={changeOwnLoginId} className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <Field label="新しいログイン ID" required>
                <Input name="email" required defaultValue={user.email} autoCapitalize="none" spellCheck={false} autoComplete="username" />
              </Field>
              <Field label="現在のパスワード" required>
                <Input name="current" type="password" required autoComplete="current-password" />
              </Field>
              <div className="@xl:col-span-2">
                <Button type="submit" size="sm">ログイン ID を変更する</Button>
              </div>
            </form>
          )}
        </Card>
      </div>

      <Card className="mb-6" id="password">
        <CardHeader title="パスワードの変更" description="初期パスワードでログインした場合は、ここで自分だけが知っているパスワードに変更してください" icon={<KeyRound />} />
        {passwordLocked && <Note tone="warn">{PASSWORD_LOCK_MESSAGE}</Note>}
        <form action={changeOwnPassword} className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
          <Field label="現在のパスワード" required>
            <Input name="current" type="password" required autoComplete="current-password" disabled={passwordLocked} />
          </Field>
          <Field label="新しいパスワード (8 文字以上)" required>
            <Input name="next" type="password" required minLength={8} autoComplete="new-password" disabled={passwordLocked} />
          </Field>
          <Field label="新しいパスワード (確認)" required>
            <Input name="confirm" type="password" required minLength={8} autoComplete="new-password" disabled={passwordLocked} />
          </Field>
          <div className="@xl:col-span-3">
            <Button type="submit" size="sm" disabled={passwordLocked}>パスワードを変更する</Button>
          </div>
        </form>
      </Card>

      <Note>
        ログイン ID・パスワード・顔写真・通知の受け取り方は、この画面で本人が変更できます。氏名・ロール・所属の変更は管理者 (店舗スタッフは所属店舗の店長も) が 社員管理 (右上の自分のアイコンのメニュー) から行います。多要素認証は次の段階 (Phase 2) で認証基盤とあわせて提供します。
        {canManageUsers(user) && <span className="ml-2"><LinkButton href="/staff" variant="secondary" size="sm">社員管理を開く</LinkButton></span>}
      </Note>
    </div>
  );
}
