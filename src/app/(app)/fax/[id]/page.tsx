import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canDeleteFax, canEditFaxLinks, canEditPurchaseOrder, canEditSuppliers, canRegisterFaxNumber, canSeeAllStores, canTriageFax, canViewFax } from "@/lib/auth/permissions";
import { checkFax, deleteFax, linkFaxSender, reanalyzeFax, registerFaxSupplier, triageFax, updateFaxLinks } from "@/lib/actions/fax";
import { refreshFax, retryFax } from "@/lib/actions/purchase-orders";
import { FAX_AI_LABEL, FAX_STATUS, FAX_TRIAGE, PURCHASE_ORDER_STATUS } from "@/lib/constants";
import { fmtDateTime } from "@/lib/format";
import { fmtFax } from "@/lib/fax/numbers";
import { faxCandidates } from "@/lib/purchase-orders";
import { Badge, Button, Card, CardHeader, Dl, Flash, Input, Note, PageHeader, Select, StatusBadge, StoreTag } from "@/components/ui";
import { HistoryCard } from "@/components/features/History";
import { FaxBadge } from "@/components/fax/FaxParts";

export const metadata: Metadata = { title: "FAX" };

export default async function FaxDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const f = db.faxMessages.find((x) => x.id === id);
  if (!f) notFound();
  if (!canViewFax(user, f)) redirect("/fax?err=" + encodeURIComponent("この FAX を閲覧する権限がありません。"));
  const inbound = f.direction === "inbound";
  const triage = canTriageFax(user);
  const editLinks = canEditFaxLinks(user, f);
  const po = f.purchaseOrderId ? db.purchaseOrders.find((p) => p.id === f.purchaseOrderId) : undefined;
  const supplier = f.supplierId ? db.suppliers.find((s) => s.id === f.supplierId) : undefined;
  const customer = f.customerId ? db.customers.find((c) => c.id === f.customerId) : undefined;
  const store = db.stores.find((s) => s.id === f.storeId);
  const orders = f.orderIds.map((oid) => db.orders.find((o) => o.id === oid)).filter((o): o is NonNullable<typeof o> => Boolean(o));
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const cand = inbound ? faxCandidates(db, f, user) : { pos: [], orders: [] };
  const file = `/api/fax/${f.id}`;
  const back = `/fax/${f.id}`;
  const blocked = db.faxNumbers.find((n) => n.number === f.remoteNumber && n.kind === "blocked");
  const assignees = db.users.filter((u) => u.active && (canSeeAllStores(user) || u.storeId === f.storeId));
  const canRetry = !inbound && (f.status === "failed" || f.status === "unknown") && po && canEditPurchaseOrder(user, po) && po.status !== "cancelled";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={`${inbound ? "受信" : "送信"} FAX ${f.number}`}
        badge={<FaxBadge f={f} />}
        description={<span className="inline-flex flex-wrap items-center gap-2">{inbound ? "送信元" : "送信先"} {f.remoteName ?? f.ai?.senderName ?? "(未登録)"} {fmtFax(f.remoteNumber) || "番号不明"} · {fmtDateTime(f.at)} · <StoreTag store={store} /></span>}
        back={{ href: inbound ? (f.triage === "review" ? "/fax?tab=review" : f.triage === "junk" ? "/fax?tab=junk" : "/fax?tab=inbox") : "/fax?tab=outbox", label: "FAX 送受信" }}
      />

      {inbound && f.triage === "review" && triage && (
        <Card className="mb-4 border-warn/40">
          <CardHeader title="要確認: この FAX を仕分けてください" description={f.ai ? `AI の判定: ${FAX_AI_LABEL[f.ai.label].label} (信頼度 ${Math.round(f.ai.confidence * 100)}%) · ${f.ai.reason}` : f.aiPending ? "AI で判定中です。少し待って画面を開き直してください" : "AI の判定はありません"} />
          <div className="flex flex-wrap items-start gap-3">
            <form action={triageFax.bind(null, f.id)}>
              <input type="hidden" name="decision" value="accept" />
              <Button type="submit">取り込む (業務の FAX)</Button>
            </form>
            <form action={triageFax.bind(null, f.id)} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="decision" value="junk" />
              <Button type="submit" variant="secondary">不要にする</Button>
              {f.remoteNumber && (
                <label className="flex items-center gap-1.5 text-xs text-ink-2">
                  <input type="checkbox" name="block" defaultChecked={f.ai?.label === "ad"} /> この番号 ({fmtFax(f.remoteNumber)}) を不要に登録し、次から自動で不要にする
                </label>
              )}
            </form>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">不要にしても削除はしません (「不要」タブからいつでも戻せます)。送信元が仕入先・お客様のときは、下の「送信元」で登録すると次から自動で取り込みます。</p>
        </Card>
      )}
      {inbound && f.triage === "junk" && triage && (
        <Card className="mb-4">
          <CardHeader title="不要に仕分けた FAX" description={`${f.decidedBy ? `${users.get(f.decidedBy) ?? "-"} · ${fmtDateTime(f.decidedAt)}` : "不要な番号の台帳による自動の仕分け"}${blocked ? ` · この番号は不要な番号に登録されています (${blocked.label})` : ""}`} />
          <div className="flex flex-wrap items-center gap-3">
            <form action={triageFax.bind(null, f.id)} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="decision" value="restore" />
              <Button type="submit" variant="secondary">戻す (要確認へ)</Button>
              {blocked && <label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" name="unblock" defaultChecked /> 不要な番号の登録も解除する</label>}
            </form>
            {canDeleteFax(user) && (
              <form action={deleteFax.bind(null, f.id)}>
                <Button type="submit" variant="danger" size="sm">完全に削除 (管理者)</Button>
              </form>
            )}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          <Card padded={false}>
            <div className="flex flex-wrap items-center justify-between gap-2 p-5 pb-3">
              <h2 className="text-[15px] font-semibold text-ink">{inbound ? "届いた FAX" : "送った FAX"}</h2>
              <div className="flex gap-2 text-xs">
                <a href={file} target="_blank" rel="noopener" className="text-accent hover:underline">別のタブで開く</a>
                <a href={`${file}?download=1`} className="text-accent hover:underline">保存</a>
              </div>
            </div>
            {f.fileKey ? (
              f.contentType === "application/pdf" ? (
                <iframe src={file} title={`FAX ${f.number}`} className="h-[72vh] min-h-[420px] w-full rounded-b-2xl border-t border-line bg-subtle" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={file} alt={`FAX ${f.number}`} className="w-full rounded-b-2xl border-t border-line" />
              )
            ) : (
              <p className="p-5 text-sm text-ink-3">ファイルはありません</p>
            )}
          </Card>

          {inbound && f.ai && (
            <Card>
              <CardHeader
                title="AI の判定と読み取り"
                description={`${f.ai.provider === "rules" ? "番号の読み取りのみ" : f.ai.model ?? f.ai.provider} · ${fmtDateTime(f.ai.at)}`}
                action={editLinks ? <form action={reanalyzeFax.bind(null, f.id)}><input type="hidden" name="back" value={back} /><Button type="submit" variant="ghost" size="sm">AI で読み直す</Button></form> : undefined}
              />
              {f.ai.error && <div className="mb-3"><Note tone="warn">{f.ai.error}</Note></div>}
              <Dl
                columns={2}
                items={[
                  ["判定", <span key="l" className="inline-flex items-center gap-2"><Badge tone={FAX_AI_LABEL[f.ai.label].tone}>{FAX_AI_LABEL[f.ai.label].label}</Badge><span className="text-xs text-ink-3">信頼度 {Math.round(f.ai.confidence * 100)}%</span></span>],
                  ["書類の種類", f.ai.documentType ?? "-"],
                  ["書かれた送信元", [f.ai.senderName, f.ai.senderFax && fmtFax(f.ai.senderFax)].filter(Boolean).join(" ") || "-"],
                  ["発注番号", f.ai.poNumbers.join("・") || "読み取れませんでした"],
                  ["案件番号", f.ai.orderNumbers.join("・") || "読み取れませんでした"],
                  ["理由", f.ai.reason || "-"],
                ]}
              />
              {f.ai.summary && <p className="mt-3 rounded-xl bg-subtle/70 p-3 text-sm text-ink-2">{f.ai.summary}</p>}
              <p className="mt-2 text-[11px] text-ink-3">AI の読み取りには誤りがあることがあります。番号・内容は FAX と見比べて確認し、違うときは右の「ひも付け」で直してください。</p>
            </Card>
          )}

          <Card>
            <CardHeader title="処理の記録" description="受信・送信の受付・状態の変化・再送・AI の判定・ひも付け・仕分け" />
            <ol className="space-y-2">
              {[...f.events].reverse().map((e, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="w-32 shrink-0 text-xs text-ink-3 tnum">{fmtDateTime(e.at)}</span>
                  <span className="min-w-0">
                    {e.status && <StatusBadge value={e.status} map={FAX_STATUS} />} <span className="text-ink-2">{e.note}</span>
                    {e.userId && e.userId !== "system" && <span className="ml-1 text-xs text-ink-3">({users.get(e.userId) ?? "-"})</span>}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="FAX の情報" />
            <Dl
              columns={1}
              items={[
                ["状態", inbound ? <StatusBadge key="t" value={f.triage ?? "review"} map={FAX_TRIAGE} /> : <StatusBadge key="s" value={f.status} map={FAX_STATUS} />],
                [inbound ? "送信元" : "送信先", `${f.remoteName ?? "-"} ${fmtFax(f.remoteNumber)}`],
                ["自社の番号", fmtFax(f.localNumber) || "-"],
                ["日時", `${fmtDateTime(f.at)}${f.completedAt && !inbound ? ` (完了 ${fmtDateTime(f.completedAt)})` : ""}`],
                ["ページ", f.pages ? `${f.pages} 枚` : "-"],
                ["送信元の判別", supplier ? <Link key="s" href={`/suppliers/${supplier.id}`} className="text-accent hover:underline">仕入先: {supplier.name}</Link> : customer ? <Link key="c" href={`/customers/${customer.id}`} className="text-accent hover:underline">顧客: {customer.name}</Link> : "未登録"],
                ["方式", f.provider === "upload" ? "画面から登録" : f.provider === "manual" ? "FAX 機で送信 (記録)" : f.provider === "mock" ? "模擬 (検証環境)" : f.provider],
                ["担当者", users.get(f.assignedUserId ?? "") ?? "-"],
                ...(!inbound ? ([["送信した人", users.get(f.userId) ?? "-"], ["試行回数", `${f.attempts} 回${f.nextRetryAt ? ` (次の自動再送 ${fmtDateTime(f.nextRetryAt)})` : ""}`]] as [string, string][]) : []),
                ...(f.lastError ? ([["エラー", f.lastError]] as [string, string][]) : []),
                ...(inbound ? ([["確認", f.checkedAt ? `${users.get(f.checkedBy ?? "") ?? "-"} · ${fmtDateTime(f.checkedAt)}` : "未確認"]] as [string, string][]) : []),
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {inbound && !f.checkedAt && f.triage !== "junk" && (
                <form action={checkFax.bind(null, f.id)}><input type="hidden" name="back" value={back} /><Button type="submit" size="sm" variant="secondary">内容を確認した</Button></form>
              )}
              {!inbound && f.status === "sending" && (
                <form action={refreshFax.bind(null, f.id)}><input type="hidden" name="back" value={back} /><Button type="submit" size="sm" variant="secondary">状態を更新</Button></form>
              )}
            </div>
            {canRetry && (
              <form action={retryFax.bind(null, f.id)} className="mt-3 space-y-2 border-t border-line pt-3">
                <input type="hidden" name="back" value={back} />
                {f.status === "unknown" && (
                  <label className="flex items-start gap-2 text-xs text-ink-2">
                    <input type="checkbox" name="confirmUnknown" className="mt-0.5" required />
                    <span>FAX サービスの送信履歴で、この FAX が届いていないことを確かめました (届いていれば再送しないでください)</span>
                  </label>
                )}
                <Button type="submit" size="sm">同じ内容を再送する</Button>
              </form>
            )}
          </Card>

          <Card>
            <CardHeader title="ひも付け" description="発注書・案件・担当者。受信 FAX は、読み取った番号と送信元の仕入先から候補を出します" />
            <Dl
              columns={1}
              items={[
                ["発注書", po ? <span key="p"><Link href={`/purchase-orders/${po.id}`} className="font-mono text-accent hover:underline">{po.number}</Link> <StatusBadge value={po.status} map={PURCHASE_ORDER_STATUS} /></span> : "なし"],
                ["案件", orders.length ? <span key="o" className="flex flex-wrap gap-2 font-mono text-xs">{orders.map((o) => <Link key={o.id} href={`/orders/${o.id}`} className="text-accent hover:underline">{o.number}</Link>)}</span> : "なし"],
              ]}
            />
            {editLinks && (
              <form action={updateFaxLinks.bind(null, f.id)} className="mt-3 space-y-2 border-t border-line pt-3">
                <input type="hidden" name="back" value={back} />
                {(inbound || !po) && (
                  <label className="block">
                    <span className="label">発注書</span>
                    <Select name="purchaseOrderId" defaultValue={f.purchaseOrderId ?? ""}>
                      <option value="">{po ? "(変えない)" : "選ばない"}</option>
                      {cand.pos.map((c) => (
                        <option key={c.po.id} value={c.po.id}>
                          {c.po.number} · {db.suppliers.find((s) => s.id === c.po.supplierId)?.name ?? ""} · {c.reason}
                        </option>
                      ))}
                      {po && !cand.pos.some((c) => c.po.id === po.id) && <option value={po.id}>{po.number} (いまのひも付け)</option>}
                    </Select>
                    {inbound && cand.pos.length === 0 && <span className="mt-1 block text-[11px] text-ink-3">候補がありません (送信元を仕入先にひも付けると、その仕入先の未完了の発注書が候補に出ます)</span>}
                  </label>
                )}
                {inbound && po && <label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" name="clearPo" /> 発注書のひも付けを外す</label>}
                {inbound && <label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" name="forceSupplier" /> 仕入先も発注書に合わせる</label>}
                <label className="block">
                  <span className="label">案件 (受注番号。複数はカンマ区切り)</span>
                  <Input name="orderNumbers" defaultValue={orders.filter((o) => !po?.orderIds.includes(o.id)).map((o) => o.number).join(", ")} placeholder={cand.orders.length ? `候補: ${cand.orders.map((o) => o.number).join(", ")}` : "例: O-2026-0123"} />
                  <span className="mt-1 block text-[11px] text-ink-3">発注書の案件は自動で含めます</span>
                </label>
                <label className="block">
                  <span className="label">担当者</span>
                  <Select name="assignedUserId" defaultValue={f.assignedUserId ?? ""}>
                    <option value="">なし</option>
                    {assignees.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </label>
                <Button type="submit" size="sm" variant="secondary">ひも付けを保存</Button>
              </form>
            )}
          </Card>

          {inbound && editLinks && f.triage !== "junk" && (
            <Card>
              <CardHeader title="送信元をひも付ける" description="仕入先・お客様にひも付けます。「番号を登録」を選ぶと、次からこの番号の FAX を自動で判別します" />
              <form action={linkFaxSender.bind(null, f.id)} className="space-y-2">
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="target" value="supplier" />
                <Select name="supplierId" defaultValue={f.supplierId ?? ""} aria-label="仕入先">
                  <option value="">仕入先を選ぶ</option>
                  {db.suppliers.filter((s) => s.active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
                {f.remoteNumber && canRegisterFaxNumber(user) && <label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" name="register" /> この番号を仕入先の FAX 番号として登録</label>}
                <Button type="submit" size="sm" variant="secondary">仕入先にひも付け</Button>
              </form>
              <form action={linkFaxSender.bind(null, f.id)} className="mt-3 space-y-2 border-t border-line pt-3">
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="target" value="customer" />
                <Input name="customerCode" placeholder="顧客コード (例: C-00012)" defaultValue={customer?.code ?? ""} aria-label="顧客コード" />
                {f.remoteNumber && canRegisterFaxNumber(user) && <label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" name="register" /> この番号を顧客の FAX 番号として登録</label>}
                <Button type="submit" size="sm" variant="secondary">顧客にひも付け</Button>
              </form>
              {triage && canEditSuppliers(user) && !supplier && f.remoteNumber && (
                <form action={registerFaxSupplier.bind(null, f.id)} className="mt-3 space-y-2 border-t border-line pt-3">
                  <input type="hidden" name="back" value={back} />
                  <p className="text-xs font-semibold text-ink-2">新しい仕入先として登録</p>
                  <Input name="name" placeholder="仕入先の名前" defaultValue={f.ai?.senderName ?? ""} required maxLength={100} aria-label="仕入先の名前" />
                  <div className="grid grid-cols-2 gap-2">
                    <Input name="category" placeholder="区分 (例: 畳材)" maxLength={40} aria-label="区分" />
                    <Select name="kind" defaultValue="supplier" aria-label="種類">
                      <option value="supplier">仕入先</option>
                      <option value="partner">協力業者</option>
                    </Select>
                  </div>
                  <Button type="submit" size="sm">仕入先として登録 (FAX {fmtFax(f.remoteNumber)})</Button>
                </form>
              )}
            </Card>
          )}

          <HistoryCard db={db} user={user} targets={[{ entity: "fax", id: f.id }]} />
        </div>
      </div>
    </div>
  );
}
