import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canManageKpi } from "@/lib/auth/permissions";
import { registerQualityIssue } from "@/lib/actions/kpi";
import { QUALITY_CATEGORIES, QUALITY_KIND_HELP, QUALITY_KIND_LABEL, kpiSettings } from "@/lib/kpi-settings";
import { findLineGroup, lineGroupName, parseLineMessageRef } from "@/lib/line-groups";
import { fmtDateTime, toDateKey } from "@/lib/format";
import { QualityGuide } from "@/components/kpi/QualityGuide";
import { Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, Select, Textarea } from "@/components/ui";

/**
 * クレーム・手直しを案件を選ばずに登録 (LINE の「クレーム・手直し報告」の報告・電話で受けたクレームなど)。
 * ?line=<グループ ID>:<メッセージ ID> で LINE の報告の文を入れて開く。受注番号が分かれば入れ、分からなければ現場名で残す
 */
export default async function NewQualityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const qp = kpiSettings(db).qualityPoints;
  const today = toDateKey(new Date());
  const ref = sp.line ? parseLineMessageRef(sp.line) : null;
  const group = ref ? findLineGroup(db, ref.groupId) : undefined;
  const visible = group && group.purpose === "quality" && (group.storeId ? canAccessStore(user, group.storeId) : canManageKpi(user));
  const message = visible ? group!.pending.find((m) => m.id === ref!.messageId) : undefined;
  const text = message?.text ?? "";
  // 文の中の受注番号 (O-2026-0012 など) と現場名 (「（地区）名前」) を拾う
  const orderNo = text.normalize("NFKC").match(/\b[OS]-\d{4}-\d{3,5}\b|\bS-\d{2,6}\b/)?.[0] ?? "";
  const site = text.normalize("NFKC").match(/[(（][^)）\n]{1,12}[)）]\s*[^\s、。,]{1,12}/)?.[0] ?? "";
  const stores = db.stores.filter((s) => s.kind === "store" && canAccessStore(user, s.id));
  const defaultStore = group?.storeId ?? (canAccessStore(user, user.storeId) && user.storeId !== "hq" ? user.storeId : stores[0]?.id);
  const staff = db.users.filter((u) => u.active && (canAccessStore(user, u.storeId) || u.storeId === "hq"));

  return (
    <div className="max-w-4xl">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="クレーム・手直しを登録 (案件を選ばずに)" description="受注番号が分かれば入れてください。分からなければ現場名で登録し、あとで詳細の画面で受注番号をひも付けます" back={{ href: "/kpi/quality", label: "クレーム・手直し一覧" }} />
      {sp.line && !message && <Note tone="warn">LINE の報告が見つかりません (記録済み・対応不要にした報告、または見る権限のない店舗の報告です)。</Note>}
      {message && (
        <Card className="mb-4">
          <CardHeader title="LINE の報告" description={`${lineGroupName(group!)} · ${fmtDateTime(message.at)}`} />
          <p className="whitespace-pre-wrap text-sm text-ink-2">{text || (message.type === "image" ? "(写真)" : `(${message.type})`)}</p>
        </Card>
      )}
      <Card>
        <form action={registerQualityIssue} className="space-y-3">
          <input type="hidden" name="returnTo" value={sp.line ? `/kpi/quality/new?line=${encodeURIComponent(sp.line)}` : "/kpi/quality/new"} />
          {message && <input type="hidden" name="lineRef" value={sp.line} />}
          <fieldset>
            <legend className="label">区分</legend>
            <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
              {(["rework", "claim", "claim_rework"] as const).map((k) => (
                <label key={k} className="flex cursor-pointer gap-2 rounded-lg border border-line p-2 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft/50">
                  <input type="radio" name="kind" value={k} defaultChecked={k === "rework"} className="mt-0.5" />
                  <span><span className="font-medium text-ink">{QUALITY_KIND_LABEL[k]} ({qp[k]} 点)</span><br /><span className="text-ink-3">{QUALITY_KIND_HELP[k]}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          <QualityGuide />
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
            <Field label="発生日" required><Input type="date" name="occurredOn" defaultValue={message ? message.at.slice(0, 10) : today} required /></Field>
            <Field label="受注番号 (分かれば)"><Input name="orderRef" defaultValue={orderNo} placeholder="O-2026-0012" /></Field>
            <Field label="現場名 (受注番号がないとき)"><Input name="siteName" defaultValue={site} placeholder="（地区）お客様名" /></Field>
          </div>
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-4">
            <Field label="店舗 (受注番号があれば案件の店舗)">
              <Select name="storeId" defaultValue={defaultStore}>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="ポイントの単位 (原因)"><Select name="attribution" defaultValue="store"><option value="store">店舗 (施工・見積の原因)</option><option value="office">事務 (事務の原因)</option></Select></Field>
            <Field label="カテゴリー"><Select name="category" defaultValue=""><option value="">(未選択)</option>{QUALITY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
            <Field label="発生のきっかけ">
              <Input name="origin" list="quality-origins" defaultValue={message ? "LINE" : ""} placeholder="電話・アンケート・LINE など" />
              <datalist id="quality-origins">{["電話", "アンケート", "LINE", "現場", "点検DM", "点検電話"].map((o) => <option key={o} value={o} />)}</datalist>
            </Field>
          </div>
          <fieldset>
            <legend className="label">対象の担当者 (分かれば)</legend>
            <div className="flex flex-wrap gap-1.5">
              {staff.map((u) => <label key={u.id} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft"><input type="checkbox" name="responsibleUserIds" value={u.id} className="h-3.5 w-3.5" />{u.name}</label>)}
            </div>
          </fieldset>
          <Field label="内容" required><Textarea name="description" rows={3} defaultValue={text} required /></Field>
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            <Field label="原因"><Textarea name="cause" rows={3} /></Field>
            <Field label="対策・再発防止 (具体的に)"><Textarea name="countermeasure" rows={3} /></Field>
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-ink-2">
            <label className="flex items-center gap-2"><input type="checkbox" name="resolved" className="h-4 w-4" /> 解決済み (原因と対策が必要)</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="notCounted" className="h-4 w-4" /> 記録のみ (集計しない: 点検 DM・点検電話がきっかけ、お客様が原因など)</label>
          </div>
          <Button type="submit">登録する</Button>
        </form>
      </Card>
    </div>
  );
}
