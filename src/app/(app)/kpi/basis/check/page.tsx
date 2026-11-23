import Link from "@/components/ui/Link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canImportData } from "@/lib/auth/permissions";
import { basisNotes, kpiBasis } from "@/lib/kpi-basis";
import { kpiCheck, readKpiSheet } from "@/lib/kpi-check";
import { storeOfLabel } from "@/lib/survey-workbook/tabs";
import type { ReconRow } from "@/lib/survey-workbook/kpi-sheet";
import { fmtDateTime } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { loadKpiSheetForCheck } from "@/lib/actions/kpi-basis";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { Badge, Button, Card, CardHeader, Flash, LinkButton, Note, PageHeader } from "@/components/ui";

export const maxDuration = 60;

const UNIT_METRICS: { metric: ReconRow["metric"]; label: string }[] = [
  { metric: "reply", label: "返信率" },
  { metric: "finish", label: "④ 工事仕上り" },
  { metric: "qpoints", label: "ポイント合計" },
  { metric: "sites", label: "施工件数" },
  { metric: "qrate", label: "ポイント率" },
];

const fmt = (r: ReconRow | undefined, digits: number) => (r?.system === null || r?.system === undefined ? "-" : r.system.toFixed(digits));
const fmtSheet = (r: ReconRow | undefined, digits: number) => (r?.sheet === undefined ? "(空欄)" : r.sheet.toFixed(digits));
const DIGITS: Partial<Record<ReconRow["metric"], number>> = { reply: 1, finish: 2, qrate: 2, phone: 2, sales: 2, craft: 2 };

function Cell({ r, metric }: { r: ReconRow | undefined; metric: ReconRow["metric"] }) {
  if (!r) return <td className="px-2 py-2 text-right text-ink-3">-</td>;
  const d = DIGITS[metric] ?? 0;
  return (
    <td className={`px-2 py-2 text-right tnum ${r.ok ? "" : "bg-warn-soft/40"}`} title={r.detail}>
      <div className="font-medium">{fmt(r, d)}</div>
      <div className="text-[10px] text-ink-3">シート {fmtSheet(r, d)} {r.ok ? <Badge tone="good" dot={false}>一致</Badge> : <Badge tone="warn" dot={false}>差</Badge>}</div>
      {r.detail && <div className="text-[10px] text-ink-3">{r.detail}</div>}
    </td>
  );
}

export default async function KpiCheckPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canImportData(user)) redirect("/kpi?err=" + encodeURIComponent("支給前の照合は本部スタッフ・管理者が行えます。"));
  const db = getDb();
  const sheet = await readKpiSheet();
  const check = sheet ? kpiCheck(db, sheet) : null;
  const years = check?.years ?? [];
  const year = years.find((y) => y.label === sp.year) ?? years[0];
  const basis = kpiBasis(db);
  const rows = year?.rows ?? [];
  const totals = rows.filter((r) => !r.month);
  const monthly = rows.filter((r) => r.month && !r.ok);
  const units = ["合志", "中央", "西", "玉名", "事務"];
  const unitRow = (u: string, metric: ReconRow["metric"]) => totals.find((r) => r.metric === metric && storeOfLabel(r.target) === storeOfLabel(u));
  const people = [...new Set(totals.filter((r) => r.metric === "sales" || r.metric === "craft").map((r) => r.target.trim()))];
  const person = (name: string, metric: "sales" | "craft") => totals.find((r) => r.metric === metric && r.target.trim() === name);
  const phone = totals.find((r) => r.metric === "phone");
  const fy = year ? Number(year.label.slice(0, 4)) : undefined;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="KPI · 支給前の照合"
        description="スプレッドシート「お客様アンケート集計表」の KPI のタブ (手計算) と、年間インセンティブと同じ計算のシステムの値を並べます。一致すれば、システムの支給額は従来の集計方法と同じです"
        back={{ href: "/kpi/basis", label: "分母・照合" }}
        actions={fy ? <LinkButton href={`/kpi/incentives?fy=${fy}`} size="sm" variant="secondary">{fy}年度の支給額を見る</LinkButton> : undefined}
      />
      <KpiTabs current="/kpi/basis" sp={sp} user={user} />

      <Card>
        <CardHeader title="照合に使う KPI のタブ" description={sheet ? `${sheet.label} · 読み込み ${fmtDateTime(sheet.at)} (${userName(sheet.by)})` : "まだ読み込んでいません"} />
        <p className="mb-3 text-xs text-ink-2">「スプレッドシートの取込」で KPI のタブを含めて取り込むと、ここで使います。KPI のタブだけを読み込むこともできます (Google スプレッドシートの KPI のタブを開いて ファイル → ダウンロード → CSV)。データは変えません。</p>
        <form action={loadKpiSheetForCheck} className="flex flex-wrap items-end gap-2">
          <input type="file" name="files" accept=".csv,.xlsx,text/csv" className="block text-sm" required />
          <Button type="submit" size="sm" variant="secondary">KPI のタブを読み込む</Button>
        </form>
      </Card>

      {check?.problems.length ? <Note tone="warn">{check.problems.join(" / ")}</Note> : null}

      {years.length > 0 && year && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {years.map((y) => (
              <Link key={y.label} href={`/kpi/basis/check?year=${encodeURIComponent(y.label)}`} className={`rounded-full border px-3 py-1 text-xs ${y.label === year.label ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-subtle"}`}>
                {y.label}
              </Link>
            ))}
            <span className="text-xs text-ink-3">比べた期間 {year.period.from.replace(/-/g, "/")}〜{year.period.to.replace(/-/g, "/")} (シートに値のある月まで)</span>
            <Badge tone="good" dot={false}>一致 {year.matched}</Badge>
            <Badge tone={year.differ ? "warn" : "neutral"} dot={false}>差あり {year.differ}</Badge>
          </div>

          <Card className="mt-3" padded={false}>
            <div className="px-5 pt-5"><CardHeader title="店舗・事務" description="上段 = システム (支給額の計算に使う値)、下段 = シートの値と計算の内訳。差のある項目は色を付けています" /></div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-xs">
                <thead><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">単位</th>{UNIT_METRICS.map((m) => <th key={m.metric} className="px-2 py-2 text-right font-medium">{m.label}</th>)}</tr></thead>
                <tbody>
                  {units.map((u) => (
                    <tr key={u} className="border-t border-line align-top">
                      <td className="px-3 py-2 font-medium">{u}</td>
                      {UNIT_METRICS.map((m) => <Cell key={m.metric} r={unitRow(u, m.metric)} metric={m.metric} />)}
                    </tr>
                  ))}
                  <tr className="border-t border-line align-top">
                    <td className="px-3 py-2 font-medium">① 電話対応 (全社)</td>
                    <Cell r={phone} metric="phone" />
                    <td colSpan={UNIT_METRICS.length - 1} />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          {people.length > 0 && (
            <Card className="mt-4" padded={false}>
              <div className="px-5 pt-5"><CardHeader title="社員 (② 営業対応・③ 職人対応)" description="シートの担当者の名前は「スプレッドシートの取込」の担当者の対応表で社員にしています" /></div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-xs">
                  <thead><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">シートの名前</th><th className="px-2 py-2 text-right font-medium">② 営業対応</th><th className="px-2 py-2 text-right font-medium">③ 職人対応</th></tr></thead>
                  <tbody>
                    {people.map((n) => (
                      <tr key={n} className="border-t border-line align-top">
                        <td className="px-3 py-2">{n}</td>
                        <Cell r={person(n, "sales")} metric="sales" />
                        <Cell r={person(n, "craft")} metric="craft" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card className="mt-4" padded={false}>
            <div className="px-5 pt-5"><CardHeader title={`月ごとの件数の差 (${monthly.length} 件)`} description="クレーム件数・手直し件数 (店舗・事務) と Google 口コミの件数・ポイント (社員)。シートの空欄・0 は、まだ転記していない月のことがあります" /></div>
            {monthly.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-ink-3">差はありません</p>
            ) : (
              <div className="max-h-80 overflow-auto">
                <table className="w-full min-w-[520px] text-xs">
                  <thead className="sticky top-0"><tr className="bg-subtle text-ink-2"><th className="px-3 py-1.5 text-left font-medium">項目</th><th className="px-2 py-1.5 text-left font-medium">対象</th><th className="px-2 py-1.5 text-left font-medium">月</th><th className="px-2 py-1.5 text-right font-medium">シート</th><th className="px-3 py-1.5 text-right font-medium">システム</th></tr></thead>
                  <tbody>
                    {monthly.map((r, i) => <tr key={i} className="border-t border-line"><td className="px-3 py-1">{r.label}</td><td className="px-2 py-1">{r.target}</td><td className="px-2 py-1 tnum">{r.month}</td><td className="px-2 py-1 text-right tnum">{r.sheet ?? "(空欄)"}</td><td className="px-3 py-1 text-right tnum">{r.system ?? "-"}</td></tr>)}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <Card className="mt-4">
        <CardHeader title="システムの数え方と、差が出るときの主な理由" />
        <ul className="space-y-1 text-xs text-ink-2">
          {basisNotes(basis).map((t, i) => <li key={i}>・{t}</li>)}
          <li>・シートの平均は、ピボットの「合計点 ÷ ハガキ№ の数」です。ハガキ№ の入っていない行 (№ の書き忘れ) の点数は合計にだけ入り、枚数に入りません。システムはその行をはがきとして数えないため、その分だけ ① と ④ がずれます (№ を入れると両方で数えます)</li>
          <li>・施工件数の自動の値は、移行した売上台帳の行の数です。金額が 0 円の行 (移行で取り込まなかった行) と、移行のあと (11 月 11 日より後) に台帳へ書いた行は入らないため、その月は「分母・照合」で手入力してください</li>
          <li>・はがきは集計月 (アンケートハガキ（回答）の「月」) で数えます。「分母・照合」でアンケートハガキ（回答）を取り込むまでは入力日の月で数えるため、年度の境目で 1 か月ずれます</li>
        </ul>
      </Card>
    </div>
  );
}
