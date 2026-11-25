import type { Database, Invoice, User } from "@/lib/db/types";
import { Card, CardHeader, LinkButton, Note } from "@/components/ui";
import { canAccessStore, canIssueReceipt, canVoidReceipt } from "@/lib/auth/permissions";
import { invoiceAccessInfo } from "@/lib/case-access";
import { partLabel, receiptChecks, receiptDraft, receiptHeading, receiptWanted } from "@/lib/receipts";
import { DOC_OUTPUT_KIND_LABEL, DOC_OUTPUT_VIA_LABEL, outputSummary } from "@/lib/doc-outputs";
import { recordReceiptPayments, voidReceipt } from "@/lib/actions/receipts";
import { fmtDate, fmtDateTime, toDateKey, yen } from "@/lib/format";
import { ReceiptForm } from "./ReceiptForm";
import { Printer, Receipt } from "lucide-react";

/**
 * 請求書の領収書 (発行した領収書・印刷・取り消し・入金の記録との突き合わせ) と帳票の出力記録
 * (お客様のご要望 2026-11-25「⑥」「⑧」)。請求書の画面に出す
 */
export function ReceiptsCard({ db, user, inv, returnTo }: { db: Database; user: User; inv: Invoice; returnTo: string }) {
  const access = invoiceAccessInfo(db, user, inv).access;
  const order = db.orders.find((o) => o.id === inv.orderId);
  const customer = db.customers.find((c) => c.id === inv.customerId);
  const list = (db.receipts ?? []).filter((r) => r.invoiceId === inv.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const draft = receiptDraft(db, inv, order);
  const head = receiptHeading(customer, inv, order);
  const checks = receiptChecks(db, inv, order);
  const wanted = receiptWanted(order);
  const name = (id?: string) => db.users.find((u) => u.id === id)?.name ?? "-";
  const outputs = (db.docOutputs ?? []).filter((o) => o.refId === inv.id || list.some((r) => r.id === o.refId)).sort((a, b) => b.at.localeCompare(a.at));
  const canIssue = canIssueReceipt(user, access) && inv.status !== "void";
  return (
    <Card id="receipts">
      <CardHeader title="領収書" icon={<Receipt />} description={`支払方法ごとの内訳つきで発行します。2 回目の印刷から「再発行」と印字し、出力の記録を残します · ${wanted.reason}`} />
      {checks.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {checks.map((c) => (
            <Note key={c.text} tone={c.tone === "warn" ? "warn" : "accent"}>
              {c.text}
            </Note>
          ))}
        </div>
      )}
      {list.length > 0 && (
        <ul className="mb-3 divide-y divide-line rounded-xl border border-line text-xs" data-testid="receipt-list">
          {list.map((r) => {
            const out = outputSummary(db, "receipt", r.id);
            const unrecorded = r.status === "issued" && inv.paidAmount < list.filter((x) => x.status === "issued").reduce((a, x) => a + x.amount, 0);
            return (
              <li key={r.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium text-ink">{r.number}</span>
                  <span className={r.status === "void" ? "rounded bg-critical-soft px-1.5 text-[10px] text-critical-ink" : "rounded bg-good-soft px-1.5 text-[10px] text-good-ink"}>{r.status === "void" ? "取り消し" : "発行済み"}</span>
                  <span className="text-ink-2">{fmtDate(r.issueDate)}</span>
                  <span className="font-semibold text-ink tnum">{yen(r.amount)}</span>
                  <span className="text-ink-2">{r.parts.map((p) => `${partLabel(p)} ${yen(p.amount)}`).join(" · ")}</span>
                  {r.status === "issued" && (
                    <LinkButton href={`/api/pdf/receipts/${r.id}`} target="_blank" variant={out.count ? "secondary" : "primary"} size="sm" className="ml-auto">
                      <Printer />
                      {out.count ? `再発行 (印刷 ${out.count + 1} 回目)` : "印刷 (PDF)"}
                    </LinkButton>
                  )}
                </div>
                <div className="text-[11px] text-ink-3">
                  宛名 {r.addressee} {r.honorific} · 但し {r.purpose} · 発行 {name(r.createdBy)} {fmtDateTime(r.createdAt)}
                  {out.count > 0 && ` · 出力 ${out.count} 回 (最後 ${out.lastBy ?? "-"} ${fmtDateTime(out.last!.at)})`}
                  {r.status === "void" && ` · 取り消し ${name(r.voidedBy)} ${fmtDateTime(r.voidedAt ?? r.updatedAt)} (理由: ${r.voidReason ?? "-"})`}
                </div>
                {r.status === "issued" && (unrecorded || canVoidReceipt(user, r)) && (
                  <div className="flex flex-wrap items-start gap-3">
                    {unrecorded && canAccessStore(user, r.storeId) && (
                      <form action={recordReceiptPayments.bind(null, r.id)} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <input type="date" name="date" defaultValue={toDateKey(new Date())} className="field w-auto" aria-label="入金日" />
                        <button type="submit" className="rounded-lg border border-accent/40 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent-soft">
                          この領収書の内訳で入金を記録
                        </button>
                      </form>
                    )}
                    {canVoidReceipt(user, r) && (
                      <details className="text-[11px]">
                        <summary className="cursor-pointer text-critical-ink">取り消す (書き損じ・作り直し)</summary>
                        <form action={voidReceipt.bind(null, r.id)} className="mt-1 flex flex-wrap items-center gap-1.5">
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <input name="reason" required maxLength={200} placeholder="理由 (例: 内訳の誤り)" className="field w-56" aria-label="取り消しの理由" />
                          <button type="submit" className="rounded-lg border border-critical/40 px-2 py-1 font-medium text-critical-ink hover:bg-critical-soft">
                            取り消す
                          </button>
                        </form>
                      </details>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canIssue ? (
        <ReceiptForm
          invoiceId={inv.id}
          invoiceNumber={inv.number}
          returnTo={`${returnTo}#receipts`}
          total={inv.total}
          paidAmount={inv.paidAmount}
          remaining={draft.remaining}
          amount={draft.amount}
          parts={draft.parts}
          beforePayment={draft.beforePayment}
          addressee={head.addressee}
          honorific={head.honorific}
          purpose={head.purpose}
          today={toDateKey(new Date())}
        />
      ) : (
        inv.status !== "void" && <p className="text-xs text-ink-3">この請求書の領収書は発行できません。</p>
      )}
      {outputs.length > 0 && (
        <details className="mt-3 border-t border-line pt-2 text-xs">
          <summary className="cursor-pointer font-medium text-ink-2">帳票の出力記録 ({outputs.length} 件)</summary>
          <ul className="mt-1 space-y-0.5 text-ink-2">
            {outputs.slice(0, 40).map((o) => (
              <li key={o.id}>
                {fmtDateTime(o.at)} · {name(o.userId)} · {DOC_OUTPUT_KIND_LABEL[o.kind]} {o.number} · {o.reissue ? `再発行 ${o.reissue} 回目` : "最初の出力"} · {DOC_OUTPUT_VIA_LABEL[o.via]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
