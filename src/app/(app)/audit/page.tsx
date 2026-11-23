import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canExportAudit, canSeeAllStores, canViewAuditEntry } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { AUDIT_ACTION_LABEL, ENTITY_LABEL, ROLE_LABEL } from "@/lib/constants";
import { fieldLabel, fieldValue } from "@/lib/field-labels";
import type { AuditAction } from "@/lib/db/types";
import { Avatar, Badge, Button, Flash, Input, LinkButton, Note, PageHeader, Pager, Select, StoreTag, paginate } from "@/components/ui";

const ACTION_TONE: Record<AuditAction, "neutral" | "info" | "good" | "warn" | "critical" | "accent"> = {
  create: "info", update: "neutral", delete: "critical", approve: "good", reject: "critical", submit: "warn", send: "accent", status: "neutral", login: "neutral", logout: "neutral", export: "warn", import: "warn", view: "neutral",
};

const SCOPE_TEXT: Record<string, string> = {
  admin: "管理者はすべての履歴を閲覧できます。",
  hq_staff: "本部スタッフはすべての店舗の履歴を閲覧できます (ほかの社員のログイン・ログアウトを除く)。",
  store_manager: "店長は自店舗の履歴と自分の操作を閲覧できます (ほかの社員のログイン・ログアウトを除く)。",
  store_staff: "店舗スタッフは自分の操作と、自店舗の案件・顧客・予定・請求などの履歴を閲覧できます。",
};

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const visible = db.auditLogs.filter((l) => canViewAuditEntry(user, l));
  let rows = visible;
  if (sp.entity) rows = rows.filter((l) => l.entity === sp.entity);
  if (sp.action) rows = rows.filter((l) => l.action === sp.action);
  if (sp.user) rows = rows.filter((l) => l.userId === sp.user);
  if (allStores && sp.store) rows = rows.filter((l) => l.storeId === sp.store);
  if (sp.from) rows = rows.filter((l) => l.at.slice(0, 10) >= sp.from!);
  if (sp.to) rows = rows.filter((l) => l.at.slice(0, 10) <= sp.to!);
  if (sp.changed === "1") rows = rows.filter((l) => l.changes && l.changes.length > 0);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((l) => [l.summary, l.entityLabel].join(" ").toLowerCase().includes(q));
  rows = [...rows].reverse();
  const paged = paginate(rows, sp.page, 100);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const names = new Map<string, string>([...db.users.map((u) => [u.id, u.name] as [string, string]), ...db.suppliers.map((s) => [s.id, s.name] as [string, string]), ...db.stores.map((s) => [s.id, s.name] as [string, string])]);
  const entities = [...new Set(visible.map((l) => l.entity))].sort((a, b) => (ENTITY_LABEL[a] ?? a).localeCompare(ENTITY_LABEL[b] ?? b, "ja"));
  const actors = [...new Set(visible.map((l) => l.userId))].map((id) => ({ id, name: userName(id) })).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const exportQs = new URLSearchParams(Object.entries({ type: "audit", entity: sp.entity, action: sp.action, user: sp.user, store: sp.store, from: sp.from, to: sp.to, q: sp.q }).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="変更履歴 (監査ログ)" actions={canExportAudit(user) ? <LinkButton href={`/api/export?${exportQs}`} variant="secondary" size="sm" download>この条件で書き出す (CSV)</LinkButton> : undefined} />
      <Note>
        すべての登録・変更・承認・差戻し・却下・送付・ログインが、操作した人・日時とともに自動で記録されます。変更した項目は変更前と変更後の値を残します。改ざん防止のため、履歴は画面から編集・削除できません。{SCOPE_TEXT[user.role]} (あなた: {ROLE_LABEL[user.role]})
      </Note>
      <form method="get" className="mt-4 mb-4 flex flex-wrap items-end gap-2">
        <div className="w-full @xl:w-56"><Input name="q" defaultValue={sp.q} placeholder="内容・番号で検索" /></div>
        <Select name="entity" defaultValue={sp.entity ?? ""} className="w-auto" aria-label="対象">
          <option value="">すべての対象</option>
          {entities.map((e) => <option key={e} value={e}>{ENTITY_LABEL[e] ?? e}</option>)}
        </Select>
        <Select name="action" defaultValue={sp.action ?? ""} className="w-auto" aria-label="操作">
          <option value="">すべての操作</option>
          {(Object.keys(AUDIT_ACTION_LABEL) as AuditAction[]).map((a) => <option key={a} value={a}>{AUDIT_ACTION_LABEL[a]}</option>)}
        </Select>
        <Select name="user" defaultValue={sp.user ?? ""} className="w-auto" aria-label="操作した人">
          <option value="">すべての操作者</option>
          {actors.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        {allStores && (
          <Select name="store" defaultValue={sp.store ?? ""} className="w-auto" aria-label="店舗">
            <option value="">全店舗</option>
            {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Input type="date" name="from" defaultValue={sp.from} className="w-auto" aria-label="日付 (から)" />
        <span className="text-xs text-ink-3">〜</span>
        <Input type="date" name="to" defaultValue={sp.to} className="w-auto" aria-label="日付 (まで)" />
        <label className="flex items-center gap-1 text-xs text-ink-2"><input type="checkbox" name="changed" value="1" defaultChecked={sp.changed === "1"} className="h-4 w-4" /> 変更前後の値があるものだけ</label>
        <Button type="submit" variant="secondary">絞り込む</Button>
        <span className="text-xs text-ink-3">{rows.length} 件</span>
      </form>
      <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
        {rows.length === 0 && <li className="px-4 py-10 text-center text-sm text-ink-3">該当する履歴はありません</li>}
        {paged.items.map((l) => (
          <li key={l.id} className="flex gap-3 px-4 py-3">
            <Avatar name={userName(l.userId)} id={l.userId} size={28} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <span className="tnum">{fmtDateTime(l.at)}</span>
                <span className="font-medium text-ink-2">{userName(l.userId)}</span>
                <Badge tone={ACTION_TONE[l.action]} dot={false}>{AUDIT_ACTION_LABEL[l.action]}</Badge>
                <span>{ENTITY_LABEL[l.entity] ?? l.entity}: {l.entityLabel}</span>
                {l.storeId && <StoreTag store={storeMap.get(l.storeId)} short />}
              </div>
              <div className="mt-0.5 text-sm text-ink">{l.summary}</div>
              {l.changes && l.changes.length > 0 && (
                <details className="mt-1 text-xs" open={l.changes.length <= 3}>
                  <summary className="cursor-pointer text-ink-3 hover:text-ink">変更前 → 変更後 ({l.changes.length} 項目)</summary>
                  <table className="mt-1 w-full max-w-2xl table-fixed text-xs">
                    <tbody>
                      {l.changes.map((c, i) => (
                        <tr key={i} className="border-t border-line align-top">
                          <td className="w-32 py-1 pr-3 text-ink-3">{fieldLabel(l.entity, c.field)}</td>
                          <td className="py-1 pr-3 text-ink-2 line-through">{fieldValue(c.field, c.before, names)}</td>
                          <td className="py-1 text-ink">{fieldValue(c.field, c.after, names)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Pager paged={paged} path="/audit" sp={sp} />
    </div>
  );
}
