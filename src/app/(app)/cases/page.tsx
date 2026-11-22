import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canSeeAllCustomerRecords, canSeeAllStores, canViewOpenCases } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { isOpenCaseRow } from "@/lib/case-access";
import type { StoreId } from "@/lib/db/types";
import { BILLING_LABEL, CASE_PRESETS, PAYMENT_STATE_LABEL, SCHEDULE_LABEL, SPEC_LABEL, STAGE_LABEL, STAGE_TONE, buildCases, type BillingState, type PaymentState, type ScheduleState, type SpecState, type Stage } from "@/lib/case-status";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { Badge, Card, CardHeader, Flash, PageHeader, Pager, Select, StoreTag, paginate } from "@/components/ui";

const KIND_LABEL = { inquiry: "問い合わせ", quote: "見積", order: "受注" } as const;

export default async function CasesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const q0 = sp.q?.trim() ?? "";
  // ほかの店舗の進行中の案件 (入金完了まで) も見られる (src/lib/case-access.ts)。店舗のロールは「全店舗」を選んだときと、検索したときに含める
  const wide = !canSeeAllStores(user) && canViewOpenCases(user) && (sp.store === "all" || Boolean(q0) || (Boolean(sp.store) && !canAccessStore(user, sp.store as StoreId)));
  const store = sp.store && sp.store !== "all" && db.stores.some((s) => s.id === sp.store) && (wide || canAccessStore(user, sp.store as StoreId)) ? sp.store : "";
  // 閲覧の範囲 = 全社員 (既定) なら、ほかの店舗の完了した案件も含める (閲覧のみ。src/lib/access-policy.ts)
  const readsAll = canSeeAllCustomerRecords(policyReader(db, user));
  const all = buildCases(db, (s) => (wide || canAccessStore(user, s)) && (!store || s === store), today).filter((r) => canAccessStore(user, r.storeId) || readsAll || isOpenCaseRow(r));
  const closed = sp.closed ?? "open";
  const preset = CASE_PRESETS.find((p) => p.key === sp.preset);
  const q = q0;
  let rows = all.filter((r) => (closed === "all" ? true : closed === "closed" ? r.closed : !r.closed));
  if (preset) rows = all.filter(preset.test);
  if (sp.stage) rows = rows.filter((r) => r.stage === sp.stage);
  if (sp.spec) rows = rows.filter((r) => r.spec === sp.spec);
  if (sp.schedule) rows = rows.filter((r) => r.schedule === sp.schedule && (r.kind === "order" || r.kind === "inquiry"));
  if (sp.billing) rows = rows.filter((r) => r.billing === sp.billing);
  if (sp.payment) rows = rows.filter((r) => r.payment === sp.payment);
  if (q) {
    const terms = q.normalize("NFKC").split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => terms.every((t) => r.text.normalize("NFKC").includes(t)));
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  const paged = paginate(rows, sp.page, 50);
  const open = all.filter((r) => !r.closed);
  const stageCounts = (Object.keys(STAGE_LABEL) as Stage[]).map((s) => [s, open.filter((r) => r.stage === s).length] as const).filter(([, n]) => n > 0);
  const base = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...(store ? { store } : sp.store === "all" && wide ? { store: "all" } : {}), ...extra });
    return `/cases?${p.toString()}`;
  };
  const sel = (name: string, value: string | undefined, options: Record<string, string>, label: string) => (
    <label className="block">
      <span className="label">{label}</span>
      <Select name={name} defaultValue={value ?? ""} className="h-9 py-1 text-sm">
        <option value="">すべて</option>
        {Object.entries(options).filter(([k]) => k !== "na").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </Select>
    </label>
  );

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="案件の進捗" description={`問い合わせ → 見積 → 受注・施工 → 請求 → 入金 → 全処理完了 までを 1 つの一覧で。状態は進捗・見積と仕様・工事日程・請求・入金に分けて絞り込めます${canSeeAllStores(user) ? "" : readsAll ? "。ほかの店舗の案件は「全店舗」または検索で表示します (閲覧のみ)" : "。ほかの店舗の案件も、入金が完了するまでは「全店舗」または検索で表示します (閲覧のみ)"}`} />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {CASE_PRESETS.map((p) => {
          const n = all.filter(p.test).length;
          const active = sp.preset === p.key;
          return (
            <Link key={p.key} href={active ? base({}) : base({ preset: p.key })} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${active ? "border-accent bg-accent text-white" : n ? "border-line bg-panel text-ink hover:border-accent" : "border-line bg-subtle text-ink-3"}`}>
              {p.label}
              <span className={`rounded-full px-1.5 tnum ${active ? "bg-white/20" : n ? "bg-warn-soft text-warn-ink" : ""}`}>{n}</span>
            </Link>
          );
        })}
      </div>

      <Card className="mb-4">
        <form action="/cases" method="get" className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label">店舗</span>
            <Select name="store" defaultValue={sp.store === "all" && wide ? "all" : store} className="h-9 py-1 text-sm">
              <option value="">{canSeeAllStores(user) ? "すべて" : "自店舗"}</option>
              {!canSeeAllStores(user) && canViewOpenCases(user) && <option value="all">{readsAll ? "全店舗 (ほかの店舗は閲覧のみ)" : "全店舗 (ほかの店舗は進行中のみ)"}</option>}
              {db.stores.filter((s) => canSeeAllStores(user) || canViewOpenCases(user) || canAccessStore(user, s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}{canAccessStore(user, s.id) ? "" : readsAll ? " (閲覧のみ)" : " (進行中のみ)"}</option>)}
            </Select>
          </label>
          {sel("stage", sp.stage, STAGE_LABEL, "案件進捗")}
          {sel("spec", sp.spec, SPEC_LABEL as Record<SpecState, string>, "見積・仕様")}
          {sel("schedule", sp.schedule, SCHEDULE_LABEL as Record<ScheduleState, string>, "工事日程")}
          {sel("billing", sp.billing, BILLING_LABEL as Record<BillingState, string>, "請求")}
          {sel("payment", sp.payment, PAYMENT_STATE_LABEL as Record<PaymentState, string>, "入金")}
          <label className="block">
            <span className="label">全処理完了</span>
            <Select name="closed" defaultValue={closed} className="h-9 py-1 text-sm">
              <option value="open">未完了の案件</option>
              <option value="closed">完了した案件</option>
              <option value="all">すべて</option>
            </Select>
          </label>
          <label className="block min-w-0 flex-1">
            <span className="label">キーワード (お客様・件名・番号・現場情報)</span>
            <input name="q" defaultValue={q} className="field h-9 py-1 text-sm" placeholder="例: 田中 / 襖紙 / O-2026-0012" />
          </label>
          <button type="submit" className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover">絞り込む</button>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
          <span className="text-ink-3">未完了の内訳:</span>
          {stageCounts.map(([s, n]) => (
            <Link key={s} href={base({ stage: s })} className="hover:underline"><Badge tone={STAGE_TONE[s]}>{STAGE_LABEL[s]} {n}</Badge></Link>
          ))}
        </div>
      </Card>

      <Card padded={false}>
        <div className="px-5 pt-5"><CardHeader title={preset ? preset.label : "案件"} description={`${rows.length.toLocaleString("ja-JP")} 件`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="bg-subtle text-xs text-ink-2">
                <th className="px-4 py-2 text-left font-medium">番号</th>
                <th className="px-2 py-2 text-left font-medium">お客様・件名</th>
                <th className="px-2 py-2 text-left font-medium">店舗</th>
                <th className="px-2 py-2 text-left font-medium">案件進捗</th>
                <th className="px-2 py-2 text-left font-medium">見積・仕様</th>
                <th className="px-2 py-2 text-left font-medium">工事日程</th>
                <th className="px-2 py-2 text-left font-medium">請求</th>
                <th className="px-2 py-2 text-left font-medium">入金</th>
                <th className="px-2 py-2 text-right font-medium">金額</th>
                <th className="px-4 py-2 text-left font-medium">残っている処理</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.length === 0 && <tr><td colSpan={10} className="px-4 py-10 text-center text-ink-3">該当する案件はありません</td></tr>}
              {paged.items.map((r) => (
                <tr key={r.key} className="border-t border-line align-top hover:bg-subtle/60">
                  <td className="px-4 py-2 text-xs">
                    <Link href={r.href} className="font-medium text-accent hover:underline">{r.number}</Link>
                    <div className="text-[10px] text-ink-3">{KIND_LABEL[r.kind]} · {fmtDate(r.date)}</div>
                  </td>
                  <td className="max-w-[18rem] px-2 py-2">
                    <div className="truncate font-medium text-ink">{r.customerName}{r.customerId ? "" : <span className="ml-1 text-[10px] font-normal text-warn-ink">顧客未登録</span>}</div>
                    <div className="truncate text-xs text-ink-2" title={r.title}>{r.title}{r.hasSiteInfo ? <span className="ml-1 text-[10px] text-accent" title="現場情報・引継ぎ事項あり">● 引継ぎ</span> : null}</div>
                  </td>
                  <td className="px-2 py-2"><StoreTag store={db.stores.find((s) => s.id === r.storeId)} short /></td>
                  <td className="px-2 py-2"><Badge tone={STAGE_TONE[r.stage]}>{STAGE_LABEL[r.stage]}</Badge><div className="mt-0.5 text-[11px] text-ink-2">{r.detail}</div></td>
                  <td className="px-2 py-2 text-xs">{r.kind === "inquiry" ? "-" : SPEC_LABEL[r.spec]}</td>
                  <td className="px-2 py-2 text-xs">{r.kind === "quote" ? "-" : `${SCHEDULE_LABEL[r.schedule]}${r.scheduleDate ? ` ${fmtDate(r.scheduleDate)}` : ""}`}</td>
                  <td className="px-2 py-2 text-xs">{BILLING_LABEL[r.billing]}</td>
                  <td className="px-2 py-2 text-xs">{PAYMENT_STATE_LABEL[r.payment]}{r.paymentMethod && r.payment !== "na" ? <div className="text-[10px] text-ink-3">{r.paymentMethod}</div> : null}</td>
                  <td className="px-2 py-2 text-right text-xs tnum">{r.amount !== undefined ? yen(r.amount) : "-"}{r.paid ? <div className="text-[10px] text-ink-3">入金 {yen(r.paid)}</div> : null}</td>
                  <td className="px-4 py-2 text-xs text-warn-ink">{r.closed ? <span className="text-good-ink">完了</span> : r.tasks.join("・") || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-5 pb-4"><Pager paged={paged} path="/cases" sp={sp} /></div>
      </Card>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
        状態の多くは記録から自動で決まります (例: 見積を送付・手渡し → 提出済・TEL待ち、施工予定日を入れる → 日程確定、請求書の発行 → 請求済、入金の登録 → 入金済)。
        記録から分からないもの (打合せ中・一部の仕様が未確定・日程調整中・請求書の要否・入金の予定方法・全処理完了) は、見積・受注の画面で設定します。売上台帳から移行した過去の案件は、施工完了していれば「完了 (移行データ)」として扱います。
      </p>
    </div>
  );
}
