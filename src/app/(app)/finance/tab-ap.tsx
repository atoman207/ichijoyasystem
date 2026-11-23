import Link from "@/components/ui/Link";
import type { Database, StoreId, User } from "@/lib/db/types";
import { canSeeAllStores, canViewPurchase } from "@/lib/auth/permissions";
import { AP_METHOD_LABEL, apMethodFilter, payablesAsOf, type ApMethodFilter } from "@/lib/ar-ap";
import { PURCHASE_PAY_METHOD_LABEL, PURCHASE_STATUS } from "@/lib/constants";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { Button, EmptyRow, Field, Input, LinkButton, Note, Select, Stat, StatusBadge, StoreTag, Table, Td, Th, Tr } from "@/components/ui";

const isDate = (v?: string): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

/**
 * 買掛一覧 (基準日の残高)。税理士に渡す一覧は総合振込の分だけ (お客様のご説明 2026-11-23: 口座振替・都度振込などは通帳から仕訳)
 */
export function PayablesTab({ db, user, sp }: { db: Database; user: User; sp: Record<string, string | undefined> }) {
  const all = canSeeAllStores(user);
  const asOf = isDate(sp.asOf) ? sp.asOf : toDateKey(new Date());
  const store = all && db.stores.some((s) => s.id === sp.store) ? (sp.store as StoreId) : undefined;
  const method = apMethodFilter(sp.method);
  const payMonth = /^\d{4}-\d{2}$/.test(sp.payMonth ?? "") ? sp.payMonth : undefined;
  const view = sp.view === "lines" ? "lines" : "suppliers";
  const { suppliers, total, count, unsetSuppliers } = payablesAsOf(db, asOf, { method, payMonth, storeId: store, canView: (p) => canViewPurchase(user, p) });
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const qs = (extra: Record<string, string>) => new URLSearchParams({ asOf, method, ...(store ? { store } : {}), ...(payMonth ? { payMonth } : {}), ...extra }).toString();
  const lines = suppliers.flatMap((s) => s.lines.map((l) => ({ ...l, supplier: s })));

  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="ap" />
        <Field label="基準日"><Input type="date" name="asOf" defaultValue={asOf} /></Field>
        <Field label="支払予定の月 (任意)"><Input type="month" name="payMonth" defaultValue={payMonth} /></Field>
        <Field label="支払方法">
          <Select name="method" defaultValue={method}>
            {(["bulk", "all", ...Object.keys(PURCHASE_PAY_METHOD_LABEL).filter((m) => m !== "bulk_transfer"), "unset"] as ApMethodFilter[]).map((m) => <option key={m} value={m}>{AP_METHOD_LABEL(m)}</option>)}
          </Select>
        </Field>
        {all && (
          <Field label="店舗">
            <Select name="store" defaultValue={store ?? ""}>
              <option value="">全店舗</option>
              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="表示">
          <Select name="view" defaultValue={view}>
            <option value="suppliers">仕入先ごと</option>
            <option value="lines">仕入請求書ごと</option>
          </Select>
        </Field>
        <Button type="submit" variant="secondary">表示する</Button>
      </form>
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label={`買掛残高 (${fmtDate(asOf)} 時点)`} value={yen(total)} sub={`${suppliers.length} 社 · ${count} 件 · ${AP_METHOD_LABEL(method)}`} />
        <Stat label="支払予定日を過ぎた未払" value={yen(lines.filter((l) => l.late).reduce((a, l) => a + l.purchase.amount, 0))} sub={`${lines.filter((l) => l.late).length} 件`} tone={lines.some((l) => l.late) ? "warn" : undefined} />
        <Stat label="支払方法が未設定の仕入先" value={`${unsetSuppliers} 社`} sub="仕入先の画面の「いつもの支払方法」で設定" href="/finance?tab=ap&method=unset" tone={unsetSuppliers ? "warn" : undefined} />
      </div>
      <div className="flex flex-wrap gap-2">
        <LinkButton href={`/api/finance?${qs({ kind: "ap" })}`} size="sm" download>買掛一覧 CSV (仕入先ごと・UTF-8)</LinkButton>
        <LinkButton href={`/api/finance?${qs({ kind: "ap", encoding: "sjis" })}`} variant="secondary" size="sm" download>同 (Shift_JIS)</LinkButton>
        <LinkButton href={`/api/finance?${qs({ kind: "ap_lines" })}`} variant="secondary" size="sm" download>買掛明細 CSV (仕入請求書ごと)</LinkButton>
      </div>

      {view === "suppliers" ? (
        <Table minWidth="min-w-[960px]">
          <thead>
            <tr>
              <Th>仕入先</Th>
              <Th>いつもの支払方法</Th>
              <Th>支払条件</Th>
              <Th align="right">件数</Th>
              <Th align="right">買掛残高</Th>
              <Th>次の支払予定日</Th>
              <Th>振込先</Th>
            </tr>
          </thead>
          <tbody>
            {suppliers.length === 0 && <EmptyRow colSpan={7}>基準日の買掛残高はありません</EmptyRow>}
            {suppliers.map((s) => (
              <Tr key={s.supplierId}>
                <Td><Link href={`/suppliers/${s.supplierId}`} className="font-medium hover:text-accent">{s.name}</Link>{s.registrationNumber && <div className="text-[11px] text-ink-3">{s.registrationNumber}</div>}</Td>
                <Td className="text-xs">{s.method ? PURCHASE_PAY_METHOD_LABEL[s.method] : <span className="text-warn-ink">未設定</span>}</Td>
                <Td className="text-xs text-ink-2">{s.terms}</Td>
                <Td align="right">{s.count}</Td>
                <Td align="right" className="font-medium">{yen(s.balance)}</Td>
                <Td className={`text-xs tnum ${s.nextPayDate && s.nextPayDate < asOf ? "font-medium text-critical" : ""}`}>{fmtDate(s.nextPayDate)}</Td>
                <Td className="text-[11px] text-ink-2">{s.bankInfo ?? "-"}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <Table minWidth="min-w-[960px]">
          <thead>
            <tr>
              <Th>支払予定日</Th>
              <Th>番号</Th>
              <Th>仕入先</Th>
              <Th>店舗</Th>
              <Th>請求日</Th>
              <Th>支払方法</Th>
              <Th align="right">金額 (税込)</Th>
              <Th>状態</Th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && <EmptyRow colSpan={8}>基準日の買掛残高はありません</EmptyRow>}
            {lines.map((l) => (
              <Tr key={l.purchase.id}>
                <Td className={`text-xs tnum ${l.late ? "font-medium text-critical" : ""}`}>{fmtDate(l.payDate)}</Td>
                <Td className="font-mono text-xs"><Link href={`/purchases/${l.purchase.id}`} className="text-accent hover:underline">{l.purchase.number}</Link></Td>
                <Td>{l.supplier.name}<div className="text-[11px] text-ink-3">{l.purchase.description}</div></Td>
                <Td><StoreTag store={storeMap.get(l.purchase.storeId)} short /></Td>
                <Td className="text-xs tnum">{fmtDate(l.purchase.invoiceDate)}</Td>
                <Td className="text-xs">{l.method ? PURCHASE_PAY_METHOD_LABEL[l.method] : <span className="text-warn-ink">未設定</span>}</Td>
                <Td align="right" className="font-medium">{yen(l.purchase.amount)}</Td>
                <Td><StatusBadge value={l.purchase.status} map={PURCHASE_STATUS} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <Note>
        買掛残高 = 請求日が基準日までの仕入請求書 (却下を除く) のうち、基準日までに支払完了にしていないもの。支払方法は支払完了の方法、まだ払っていない分は仕入先の「いつもの支払方法」です。
        税理士事務所に渡す買掛一覧は「総合振込」の分だけです (口座振替・都度振込などの支払は、各銀行口座の通帳から仕訳しているため)。会計データに出す支払の方法は 会計データの出力 → 科目名・税区分の設定 で変えられます。CSV の項目は税理士事務所の形式が分かりしだい合わせます。
      </Note>
    </div>
  );
}
