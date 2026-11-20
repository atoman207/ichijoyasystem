import Link from "@/components/ui/Link";
import clsx from "clsx";
import { sheetRows, weekdayLabel, type WorkLine, type WorkReport } from "@/lib/ops-reports/work-report";

/**
 * 作業日報の表 (店舗の月別の作業日報の表計算と同じ並び)。画面と印刷で共通
 * 日 | 引取 (現場名・畳 表/新・襖 張替/新・障子 張替/新・網戸 張替/新・その他・担当) | 見積 | 施工 | チラシ (配布人・枚数・地域) | 納品 (現場名・畳 表/新・襖・障子・網戸・その他・担当) | 来店数
 */

const num = (v: number) => (v ? v.toLocaleString("ja-JP") : "");

function Site({ line, links }: { line?: WorkLine; links: boolean }) {
  if (!line) return null;
  const text = (
    <>
      {line.time && <span className="mr-1 text-ink-3 tnum">{line.time}</span>}
      {line.site}
      {line.noQty && (line.line === "pickup" || line.line === "delivery") && <span className="ml-1 rounded bg-warn-soft px-1 text-[9px] text-warn-ink print:border print:border-ink-3 print:bg-transparent">枚数?</span>}
    </>
  );
  return links ? (
    <Link href={`/schedule/${line.eventId}`} className="hover:text-accent hover:underline" title={`${line.title}${line.orderNumber ? ` (受注 ${line.orderNumber})` : ""}`}>
      {text}
    </Link>
  ) : (
    text
  );
}

function Staff({ line }: { line?: WorkLine }) {
  return line?.assignees.length ? <span className="text-ink-2">{line.assignees.join("・")}</span> : null;
}

function Inline({ line, links }: { line?: WorkLine; links: boolean }) {
  if (!line) return null;
  return (
    <span>
      <Site line={line} links={links} />
      {line.assignees.length > 0 && <span className="ml-1 text-[10px] text-ink-3">({line.assignees.join("・")})</span>}
    </span>
  );
}

export function WorkReportSheet({ report, links = true, print = false }: { report: WorkReport; links?: boolean; print?: boolean }) {
  const rows = sheetRows(report);
  const pu = report.totals.pickup.units;
  const du = report.totals.delivery.units;
  const th = "border border-line bg-subtle px-1 py-1 text-center text-[10px] font-semibold whitespace-nowrap text-ink-2 print:bg-transparent";
  const td = "border border-line px-1 py-0.5 align-top";
  const n = "text-right tnum";
  return (
    <div className={clsx(!print && "overflow-x-auto rounded-2xl border border-line/70 bg-panel shadow-card")}>
      <table className={clsx("w-full border-collapse text-[11px] leading-snug text-ink", print ? "text-[8.5px]" : "min-w-[1180px]")}>
        <thead>
          <tr>
            <th rowSpan={2} className={th}>日</th>
            <th colSpan={11} className={th}>引取</th>
            <th rowSpan={2} className={th}>見積<br />(現調・採寸)</th>
            <th rowSpan={2} className={th}>施工</th>
            <th colSpan={3} className={th}>チラシ</th>
            <th colSpan={8} className={th}>納品</th>
            <th rowSpan={2} className={th}>来店数</th>
          </tr>
          <tr>
            <th className={th}>現場名</th>
            <th className={th}>畳<br />表</th>
            <th className={th}>畳<br />新</th>
            <th className={th}>襖<br />張替</th>
            <th className={th}>襖<br />新</th>
            <th className={th}>障子<br />張替</th>
            <th className={th}>障子<br />新</th>
            <th className={th}>網戸<br />張替</th>
            <th className={th}>網戸<br />新</th>
            <th className={th}>その他</th>
            <th className={th}>担当</th>
            <th className={th}>配布人</th>
            <th className={th}>枚数</th>
            <th className={th}>地域</th>
            <th className={th}>現場名</th>
            <th className={th}>畳<br />表</th>
            <th className={th}>畳<br />新</th>
            <th className={th}>襖</th>
            <th className={th}>障子</th>
            <th className={th}>網戸</th>
            <th className={th}>その他</th>
            <th className={th}>担当</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const p = r.pickup;
            const d = r.delivery;
            const dow = r.day.weekday;
            return (
              <tr key={`${r.day.date}-${i}`} className={clsx(r.day.closed && "bg-subtle/70 print:bg-transparent", r.first && "border-t-2 border-t-line")}>
                {r.first && (
                  <td rowSpan={r.span} className={clsx(td, "text-center whitespace-nowrap tnum", dow === 0 ? "text-critical" : dow === 6 ? "text-info" : "")}>
                    {Number(r.day.date.slice(8))}
                    <span className="ml-0.5 text-[10px]">({weekdayLabel(dow)})</span>
                    {r.day.closed && <div className="text-[9px] text-ink-3">休</div>}
                  </td>
                )}
                <td className={clsx(td, "min-w-[7rem]")}><Site line={p} links={links} /></td>
                <td className={clsx(td, n)}>{num(p?.units.tatamiOmote ?? 0)}</td>
                <td className={clsx(td, n)}>{num(p?.units.tatamiNew ?? 0)}</td>
                <td className={clsx(td, n)}>{num(p?.units.fusumaRe ?? 0)}</td>
                <td className={clsx(td, n)}>{num(p?.units.fusumaNew ?? 0)}</td>
                <td className={clsx(td, n)}>{num(p?.units.shojiRe ?? 0)}</td>
                <td className={clsx(td, n)}>{num(p?.units.shojiNew ?? 0)}</td>
                <td className={clsx(td, n)}>{num(p?.units.amidoRe ?? 0)}</td>
                <td className={clsx(td, n)}>{num(p?.units.amidoNew ?? 0)}</td>
                <td className={clsx(td, "text-[10px]")} title={p?.otherNote || undefined}>{p ? p.otherNote || num(p.units.other) : ""}</td>
                <td className={td}><Staff line={p} /></td>
                <td className={clsx(td, "min-w-[6rem]")}><Inline line={r.survey} links={links} /></td>
                <td className={clsx(td, "min-w-[6rem]")}><Inline line={r.install} links={links} /></td>
                <td className={td}>{r.flyer?.distributor}</td>
                <td className={clsx(td, n)}>{r.flyer ? r.flyer.copies.toLocaleString("ja-JP") : ""}</td>
                <td className={clsx(td, "text-[10px]")}>{r.flyer?.area}</td>
                <td className={clsx(td, "min-w-[7rem]")}><Site line={d} links={links} /></td>
                <td className={clsx(td, n)}>{num(d?.units.tatamiOmote ?? 0)}</td>
                <td className={clsx(td, n)}>{num(d?.units.tatamiNew ?? 0)}</td>
                <td className={clsx(td, n)}>{num((d?.units.fusumaRe ?? 0) + (d?.units.fusumaNew ?? 0))}</td>
                <td className={clsx(td, n)}>{num((d?.units.shojiRe ?? 0) + (d?.units.shojiNew ?? 0))}</td>
                <td className={clsx(td, n)}>{num((d?.units.amidoRe ?? 0) + (d?.units.amidoNew ?? 0))}</td>
                <td className={clsx(td, "text-[10px]")} title={d?.otherNote || undefined}>{d ? d.otherNote || num(d.units.other) : ""}</td>
                <td className={td}><Staff line={d} /></td>
                {r.first && (
                  <td rowSpan={r.span} className={clsx(td, n)} title={r.day.note || undefined}>
                    {r.day.visitors !== undefined ? r.day.visitors.toLocaleString("ja-JP") : ""}
                    {r.day.note && <div className="text-left text-[9px] text-ink-3">{r.day.note}</div>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className={clsx(td, "text-center")}>計</td>
            <td className={td}>{report.totals.pickup.count} 件</td>
            <td className={clsx(td, n)}>{num(pu.tatamiOmote)}</td>
            <td className={clsx(td, n)}>{num(pu.tatamiNew)}</td>
            <td className={clsx(td, n)}>{num(pu.fusumaRe)}</td>
            <td className={clsx(td, n)}>{num(pu.fusumaNew)}</td>
            <td className={clsx(td, n)}>{num(pu.shojiRe)}</td>
            <td className={clsx(td, n)}>{num(pu.shojiNew)}</td>
            <td className={clsx(td, n)}>{num(pu.amidoRe)}</td>
            <td className={clsx(td, n)}>{num(pu.amidoNew)}</td>
            <td className={clsx(td, n)}>{num(pu.other)}</td>
            <td className={td} />
            <td className={td}>{report.totals.survey} 件</td>
            <td className={td}>{report.totals.install} 件</td>
            <td className={td} />
            <td className={clsx(td, n)}>{num(report.totals.flyerCopies)}</td>
            <td className={td} />
            <td className={td}>{report.totals.delivery.count} 件</td>
            <td className={clsx(td, n)}>{num(du.tatamiOmote)}</td>
            <td className={clsx(td, n)}>{num(du.tatamiNew)}</td>
            <td className={clsx(td, n)}>{num(du.fusumaRe + du.fusumaNew)}</td>
            <td className={clsx(td, n)}>{num(du.shojiRe + du.shojiNew)}</td>
            <td className={clsx(td, n)}>{num(du.amidoRe + du.amidoNew)}</td>
            <td className={clsx(td, n)}>{num(du.other)}</td>
            <td className={td} />
            <td className={clsx(td, n)}>{num(report.totals.visitors)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

const fmt = (v: number | null) => (v === null ? "-" : v.toLocaleString("ja-JP", { maximumFractionDigits: 1 }));

/** 見出しの集計 (畳 総数 ／人 ／日 ／人日、襖類 (係数後)) */
export function WorkReportHeadline({ report, compact = false }: { report: WorkReport; compact?: boolean }) {
  const f = report.factors;
  const rows: [string, typeof report.tatami][] = [
    ["畳 (引取の表 + 新)", report.tatami],
    ["襖類 (係数後)", report.fusumaWeighted],
  ];
  const cell = clsx("border border-line px-2 py-1 text-right tnum", compact && "px-1 py-0.5");
  return (
    <div>
      <table className={clsx("border-collapse text-ink", compact ? "text-[9px]" : "text-xs")}>
        <thead>
          <tr>
            <th className="border border-line bg-subtle px-2 py-1 text-left font-semibold print:bg-transparent" />
            <th className="border border-line bg-subtle px-2 py-1 font-semibold print:bg-transparent">総数</th>
            <th className="border border-line bg-subtle px-2 py-1 font-semibold print:bg-transparent">／人</th>
            <th className="border border-line bg-subtle px-2 py-1 font-semibold print:bg-transparent">／日</th>
            <th className="border border-line bg-subtle px-2 py-1 font-semibold print:bg-transparent">／人日</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, p]) => (
            <tr key={label}>
              <td className="border border-line px-2 py-1 whitespace-nowrap">{label}</td>
              <td className={cell}>{fmt(p.total)}</td>
              <td className={cell}>{fmt(p.perPerson)}</td>
              <td className={cell}>{fmt(p.perDay)}</td>
              <td className={cell}>{fmt(p.perPersonDay)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={clsx("mt-1.5 text-ink-3", compact ? "text-[8px]" : "text-[11px]")}>
        人 = 引取・納品の担当者 {report.people} 人 · 日 = 引取・納品のあった日 {report.workDays} 日 · 人日 = 日ごとの担当者の人数の合計 {report.personDays} · 襖類 (係数後) = 襖 × {f.fusuma} + 障子 × {f.shoji} + 網戸 × {f.amido}
      </p>
    </div>
  );
}
