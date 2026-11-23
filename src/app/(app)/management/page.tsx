import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { canAdminMgmt, canEditMgmt, canViewMgmt, mgmtStores } from "@/lib/mgmt/access";
import { policyReader } from "@/lib/access-policy";
import { Flash, LinkTabs, Note, PageHeader } from "@/components/ui";
import type { Ctx } from "./parts";
import { PnlTab } from "./tab-pnl";
import { ItemsTab } from "./tab-items";
import { SalesTab } from "./tab-sales";
import { CostTab } from "./tab-cost";
import { StockTab } from "./tab-stock";
import { PurchasesTab } from "./tab-purchases";
import { AllocTab } from "./tab-alloc";
import { EntriesTab } from "./tab-entries";
import { CloseTab } from "./tab-close";
import { SettingsTab } from "./tab-settings";
import { MastersTab } from "./tab-masters";

// 仕入明細の AI の候補 (generateJson) を呼ぶため
export const maxDuration = 60;

const TABS: { id: string; label: string; edit?: boolean }[] = [
  { id: "pnl", label: "店舗別損益" },
  { id: "items", label: "品目別" },
  { id: "sales", label: "売上配分 (内部受注)" },
  { id: "cost", label: "材料原価" },
  { id: "stock", label: "在庫・材料移動" },
  { id: "purchases", label: "仕入明細の振り分け", edit: true },
  { id: "alloc", label: "共通経費の案分" },
  { id: "entries", label: "人件費・手入力" },
  { id: "close", label: "月次確定・照合" },
  { id: "masters", label: "材料・単価・材料構成" },
  { id: "settings", label: "設定 (配分率・エリア・品目)" },
];

export default async function ManagementPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  // 見る範囲は閲覧の範囲の設定 (経営の数字は全社員 = 既定。src/lib/access-policy.ts)。登録・設定・確定は本物の利用者の権限
  const reader = policyReader(db, user);
  if (!canViewMgmt(reader)) redirect("/?err=" + encodeURIComponent("管理会計は店長・本部スタッフ・管理者が見られます。"));
  const today = toDateKey(new Date());
  const canEdit = canEditMgmt(user);
  const tabs = TABS.filter((t) => !t.edit || canEdit);
  const tab = tabs.some((t) => t.id === sp.tab) ? sp.tab! : "pnl";
  const isDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? "");
  const from = isDate(sp.from) ? sp.from! : `${today.slice(0, 7)}-01`;
  const to = isDate(sp.to) ? sp.to! : today;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : today.slice(0, 7);
  const ctx: Ctx = { db, user, sp, tab, canEdit, canAdmin: canAdminMgmt(user), storeIds: mgmtStores(reader), from, to, month, today };

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="管理会計 (店舗別独立採算)"
        description="店舗別・品目別の売上・材料費・外注費・粗利益・経費・損益。内部受注の配分、材料原価、在庫と材料移動、仕入明細の振り分け、共通経費の案分、月次確定をここで行います。金額の計算はすべて決まった計算式 (AI は計算しません)"
      />
      {!ctx.storeIds ? null : <Note>自店舗の数字だけが表示されます。</Note>}
      <LinkTabs current={`/management?tab=${tab}`} items={tabs.map((t) => ({ href: `/management?tab=${t.id}`, label: t.label }))} />
      {from > to && <Note tone="warn">期間の「から」が「まで」より後になっています。</Note>}
      {tab === "pnl" && <PnlTab ctx={ctx} />}
      {tab === "items" && <ItemsTab ctx={ctx} />}
      {tab === "sales" && <SalesTab ctx={ctx} />}
      {tab === "cost" && <CostTab ctx={ctx} />}
      {tab === "stock" && <StockTab ctx={ctx} />}
      {tab === "purchases" && <PurchasesTab ctx={ctx} />}
      {tab === "alloc" && <AllocTab ctx={ctx} />}
      {tab === "entries" && <EntriesTab ctx={ctx} />}
      {tab === "close" && <CloseTab ctx={ctx} />}
      {tab === "masters" && <MastersTab ctx={ctx} />}
      {tab === "settings" && <SettingsTab ctx={ctx} />}
    </div>
  );
}
