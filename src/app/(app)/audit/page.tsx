import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { AUDIT_ACTION_LABEL, ENTITY_LABEL } from "@/lib/constants";
import type { AuditAction } from "@/lib/db/types";
import { Avatar, Badge, Button, Flash, Input, Note, PageHeader, Select, StoreTag } from "@/components/ui";

const ACTION_TONE: Record<AuditAction, "neutral" | "info" | "good" | "warn" | "critical" | "accent"> = {
  create: "info", update: "neutral", delete: "critical", approve: "good", reject: "critical", submit: "warn", send: "accent", status: "neutral", login: "neutral", logout: "neutral", export: "warn",
};

function fmtVal(v: unknown): string {
  if (v === undefined || v === null || v === "") return "(空)";
  if (Array.isArray(v)) return v.join(", ") || "(空)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  let rows = allStores ? db.auditLogs : db.auditLogs.filter((l) => l.storeId === user.storeId || l.userId === user.id);
  if (sp.entity) rows = rows.filter((l) => l.entity === sp.entity);
  if (sp.action) rows = rows.filter((l) => l.action === sp.action);
  if (sp.user) rows = rows.filter((l) => l.userId === sp.user);
  if (allStores && sp.store) rows = rows.filter((l) => l.storeId === sp.store);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((l) => [l.summary, l.entityLabel].join(" ").toLowerCase().includes(q));
  rows = [...rows].reverse().slice(0, 200);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const entities = [...new Set(db.auditLogs.map((l) => l.entity))];

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="変更履歴 (監査ログ)" />
      <Note>すべての登録・更新・承認・送付・ログインが自動で記録されます。改ざん防止のため、履歴は編集・削除できません。</Note>
      <form method="get" className="mt-4 mb-4 flex flex-wrap items-end gap-2">
        <div className="w-full @xl:w-56"><Input name="q" defaultValue={sp.q} placeholder="内容で検索" /></div>
        <Select name="entity" defaultValue={sp.entity ?? ""} className="w-auto">
          <option value="">すべての対象</option>
          {entities.map((e) => <option key={e} value={e}>{ENTITY_LABEL[e] ?? e}</option>)}
        </Select>
        <Select name="action" defaultValue={sp.action ?? ""} className="w-auto">
          <option value="">すべての操作</option>
          {(Object.keys(AUDIT_ACTION_LABEL) as AuditAction[]).map((a) => <option key={a} value={a}>{AUDIT_ACTION_LABEL[a]}</option>)}
        </Select>
        <Select name="user" defaultValue={sp.user ?? ""} className="w-auto">
          <option value="">すべての操作者</option>
          {db.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        {allStores && (
          <Select name="store" defaultValue={sp.store ?? ""} className="w-auto">
            <option value="">全店舗</option>
            {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Button type="submit" variant="secondary">絞り込む</Button>
        <span className="text-xs text-ink-3">{rows.length} 件 (最新 200 件まで)</span>
      </form>
      <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
        {rows.length === 0 && <li className="px-4 py-10 text-center text-sm text-ink-3">該当する履歴はありません</li>}
        {rows.map((l) => (
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
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-ink-3 hover:text-ink">変更内容 ({l.changes.length} 項目)</summary>
                  <table className="mt-1 w-full max-w-xl text-xs">
                    <tbody>
                      {l.changes.map((c, i) => (
                        <tr key={i} className="border-t border-line"><td className="py-1 pr-3 text-ink-3">{c.field}</td><td className="py-1 pr-3 text-ink-2 line-through">{fmtVal(c.before)}</td><td className="py-1 text-ink">{fmtVal(c.after)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
