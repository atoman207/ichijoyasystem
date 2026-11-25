import "server-only";
import type { Role, StoreId, User } from "@/lib/db/types";
import { STAFF_AUDIT_ENTITIES, canSeeAllCustomerRecords, canSeeAllStoreFigures, canSeeAllStores } from "@/lib/auth/permissions";
import {
  APPROVAL_STATUS,
  APPROVAL_TYPE_LABEL,
  CATEGORY_LABEL,
  CHANNEL_LABEL,
  EXPENSE_METHOD_LABEL,
  EXPENSE_STATUS,
  INQUIRY_STATUS,
  INVOICE_STATUS,
  ORDER_STATUS,
  PAYMENT_METHOD_LABEL,
  PURCHASE_ORDER_STATUS,
  PURCHASE_PAY_METHOD_LABEL,
  PURCHASE_STATUS,
  QUOTE_STATUS,
  ROLE_LABEL,
  SCHEDULE_KIND,
  CASH_SOURCE_LABEL,
  DOCUMENT_KIND_LABEL,
  DOCUMENT_STATUS,
  FAX_STATUS,
  FAX_TRIAGE,
  TASK_STATUS,
  THREAD_KIND_LABEL,
  AUDIT_ACTION_LABEL,
  ENTITY_LABEL,
} from "@/lib/constants";
import { AMOUNT_KEYS, AMOUNT_LABEL } from "@/lib/assistant/facts";
import { MEDIA_LABEL } from "@/lib/media";

/**
 * システムの全データの「統合データモデル」(AI アシスタントが正確に答えるための意味の層)
 * ------------------------------------------------------------
 * VPS のデータベース (mirror.ts) の生の表の上に、次の 3 つを重ねる:
 *  1) _labels: 状態・受付経路・種別・予定の種類などのコードと、画面と同じ日本語の名前 (constants.ts から作る)
 *  2) 統合ビュー (v_*): 業務の流れ (問い合わせ → 見積 → 受注・施工 → 請求 → 入金) と顧客 360°・予定・経費などを、
 *     名前と日本語の状態つきで 1 行にまとめたもの。AI は表の結合を組み立てずに、これを読めば正しく答えられる
 *  3) データ辞書 (dataModelText): 表と列の意味・表どうしのつながり・指標の定義 (売上・粗利・受注…)・言葉の言い換え
 * ビューは問い合わせのたびに一時ビュー (TEMP VIEW) として作る。全店舗を見られない人には、その前に生の表を
 * 閲覧範囲で絞った一時ビューで覆う (scopeStatements)。そのためビューも自動で閲覧範囲の内側になる
 */

/* ================================================================== */
/* 1) ラベル                                                             */
/* ================================================================== */

const labelOf = (m: Record<string, string | { label: string }>) => Object.entries(m).map(([code, v]) => [code, typeof v === "string" ? v : v.label] as [string, string]);

export function labelRows(): [string, string, string][] {
  const kinds: Record<string, [string, string][]> = {
    order_status: labelOf(ORDER_STATUS),
    quote_status: labelOf(QUOTE_STATUS),
    inquiry_status: labelOf(INQUIRY_STATUS),
    invoice_status: labelOf(INVOICE_STATUS),
    expense_status: labelOf(EXPENSE_STATUS),
    purchase_status: labelOf(PURCHASE_STATUS),
    purchase_order_status: labelOf(PURCHASE_ORDER_STATUS),
    approval_status: labelOf(APPROVAL_STATUS),
    approval_type: labelOf(APPROVAL_TYPE_LABEL),
    channel: labelOf(CHANNEL_LABEL),
    category: labelOf(CATEGORY_LABEL),
    schedule_kind: labelOf(SCHEDULE_KIND),
    role: labelOf(ROLE_LABEL),
    payment_method: labelOf(PAYMENT_METHOD_LABEL),
    expense_method: labelOf(EXPENSE_METHOD_LABEL),
    purchase_pay_method: labelOf(PURCHASE_PAY_METHOD_LABEL),
    amount_category: AMOUNT_KEYS.map((k) => [k, AMOUNT_LABEL[k]]),
    quality_kind: [
      ["rework", "手直し"],
      ["claim", "クレーム"],
      ["claim_rework", "クレーム・手直し"],
    ],
    quality_status: [
      ["open", "対応中"],
      ["resolved", "解決"],
    ],
    cash_direction: [
      ["in", "入金"],
      ["out", "出金"],
    ],
    cash_source: labelOf(CASH_SOURCE_LABEL),
    document_kind: labelOf(DOCUMENT_KIND_LABEL),
    document_status: labelOf(DOCUMENT_STATUS),
    thread_kind: labelOf(THREAD_KIND_LABEL),
    task_status: labelOf(TASK_STATUS),
    fax_status: labelOf(FAX_STATUS),
    fax_triage: labelOf(FAX_TRIAGE),
    required_role: [
      ["store_manager", "店長"],
      ["admin", "管理者"],
    ],
    customer_type: [
      ["individual", "個人"],
      ["corporate", "法人"],
    ],
    // 媒体 (お客様が当社を知ったきっかけ。全社共通の分類 src/lib/media.ts)
    media: labelOf(MEDIA_LABEL),
    // 変更履歴 (社内の活動) の操作と対象
    audit_action: labelOf(AUDIT_ACTION_LABEL),
    audit_entity: labelOf(ENTITY_LABEL),
  };
  return Object.entries(kinds).flatMap(([kind, rows]) => rows.map(([code, label]) => [kind, code, label] as [string, string, string]));
}

/**
 * コードの列 (表・ビュー → 列 → コードの種類)。SQL の「列 = 'コード'」が正しいコードか確かめるのに使う (sql.ts の checkCodes)
 */
export const CODE_COLUMNS: Record<string, Record<string, string>> = {
  orders: { status: "order_status", category: "category" },
  quotes: { status: "quote_status", category: "category" },
  inquiries: { status: "inquiry_status", channel: "channel", category: "category", media: "media" },
  invoices: { status: "invoice_status" },
  payments: { method: "payment_method" },
  expenses: { status: "expense_status", payment_method: "expense_method" },
  purchases: { status: "purchase_status", pay_method: "purchase_pay_method" },
  suppliers: { pay_method: "purchase_pay_method" },
  purchase_orders: { status: "purchase_order_status" },
  approvals: { status: "approval_status", type: "approval_type", required_role: "required_role" },
  schedule_events: { kind: "schedule_kind" },
  users: { role: "role" },
  customers: { type: "customer_type", first_contact_channel: "channel", preferred_channel: "channel" },
  comm_logs: { channel: "channel" },
  quality_issues: { kind: "quality_kind", status: "quality_status" },
  cash_entries: { direction: "cash_direction", source: "cash_source" },
  documents: { kind: "document_kind", status: "document_status" },
  threads: { kind: "thread_kind", task_status: "task_status" },
  fax_messages: { status: "fax_status", triage: "fax_triage" },
  products: { category: "category" },
  sales_orders: { status: "order_status" },
  v_customers: { customer_type: "customer_type", first_contact_channel: "channel" },
  v_cases: { inquiry_status: "inquiry_status", channel: "channel", quote_status: "quote_status", order_status: "order_status", category: "category", invoice_status: "invoice_status" },
  v_schedule: { kind: "schedule_kind" },
  v_inquiries: { channel: "channel", category: "category", status: "inquiry_status" },
  v_quotes: { category: "category", status: "quote_status" },
  v_invoices: { status: "invoice_status" },
  v_payments: { method: "payment_method" },
  v_expenses: { status: "expense_status", payment_method: "expense_method" },
  v_purchases: { status: "purchase_status" },
  v_purchase_orders: { status: "purchase_order_status" },
  v_comm_logs: { channel: "channel" },
  v_quality: { kind: "quality_kind", status: "quality_status" },
  v_cashbook: { direction: "cash_direction", source: "cash_source" },
  v_approvals: { type: "approval_type", status: "approval_status", required_role: "required_role" },
  v_threads: { kind: "thread_kind", task_status: "task_status" },
  v_documents: { kind: "document_kind", status: "document_status" },
  v_products: { category: "category" },
  v_staff: { role: "role" },
  v_fax: { status: "fax_status", triage: "fax_triage" },
  audit_logs: { action: "audit_action" },
  v_activity: { action: "audit_action" },
};

export const LABELS_SQL = "create table if not exists _labels (kind text not null, code text not null, label text not null, primary key (kind, code));";

/* ================================================================== */
/* 2) 統合ビュー                                                          */
/* ================================================================== */

const L = (kind: string, alias: string, col: string) => `(select label from _labels where kind = '${kind}' and code = ${alias}.${col})`;
const NAMES = (jsonCol: string) => `(select group_concat(u.name, '・') from json_each(${jsonCol}) j join users u on u.id = j.value)`;
const TODAY = "date('now', 'localtime')";

export interface ViewDef {
  name: string;
  label: string;
  /** AI 向けの説明 (何が 1 行か・主な列・使い方) */
  description: string;
  sql: string;
}

export const VIEWS: ViewDef[] = [
  {
    name: "v_customers",
    label: "顧客 360° (顧客ごとの連絡先・担当・受注の回数と累計売上・最初と最後の受注・前回の担当者・問い合わせ・未入金)",
    description:
      "顧客 1 人 = 1 行。customer_id・code・name・kana・customer_type (individual/corporate) と customer_type_label (個人/法人)・phone・other_phones (ほかの連絡先)・address・area・store_id・store_name・assigned_staff (顧客の担当)・first_contact_channel と first_contact_channel_label・trade_stopped (1=取引停止)・registered_on・order_count・lifetime_sales (累計売上・税込)・first_order_date・last_order_date・last_order_number・last_order_title・last_staff (前回の担当者)・last_workers (前回の施工担当)・inquiry_count・open_inquiries・last_inquiry_at・receivable (未入金残高)・overdue (期日超過)",
    sql: `
      with ord as (
        select customer_id, count(*) order_count, sum(total) lifetime_sales, min(coalesce(sales_date, contract_date)) first_order_date, max(coalesce(sales_date, contract_date)) last_order_date
        from orders where status <> 'cancelled' group by customer_id
      ), lastord as (
        select customer_id, number last_order_number, title last_order_title, staff_names last_staff, worker_names last_workers from (
          select o.customer_id, o.number, o.title, so.staff_names, so.worker_names,
                 row_number() over (partition by o.customer_id order by coalesce(o.sales_date, o.contract_date) desc, o.created_at desc) rn
          from orders o left join sales_orders so on so.order_id = o.id where o.status <> 'cancelled'
        ) where rn = 1
      ), inq as (
        select customer_id, count(*) inquiry_count, sum(status in ('new', 'in_progress', 'quoted')) open_inquiries, max(received_at) last_inquiry_at
        from inquiries where customer_id is not null group by customer_id
      ), inv as (
        select customer_id,
               sum(case when status in ('issued', 'partially_paid', 'overdue') then total - paid_amount else 0 end) receivable,
               sum(case when status in ('issued', 'partially_paid', 'overdue') and due_date < ${TODAY} then total - paid_amount else 0 end) overdue
        from invoices group by customer_id
      )
      select c.id customer_id, c.code, c.name, c.kana, c.type customer_type, ${L("customer_type", "c", "type")} customer_type_label, c.phone,
             (select group_concat(coalesce(json_extract(j.value, '$.relation'), '') || ' ' || coalesce(json_extract(j.value, '$.name') || ' ', '') || coalesce(json_extract(j.value, '$.phone'), ''), ' / ') from json_each(c.contacts) j) other_phones,
             c.email, c.postal_code, c.address, c.area, c.store_id, s.name store_name, au.name assigned_staff,
             c.first_contact_channel, ${L("channel", "c", "first_contact_channel")} first_contact_channel_label, coalesce(c.trade_stopped, 0) trade_stopped, c.trade_stop_note, c.notes,
             substr(c.created_at, 1, 10) registered_on,
             coalesce(ord.order_count, 0) order_count, coalesce(ord.lifetime_sales, 0) lifetime_sales, ord.first_order_date, ord.last_order_date,
             lastord.last_order_number, lastord.last_order_title, lastord.last_staff, lastord.last_workers,
             coalesce(inq.inquiry_count, 0) inquiry_count, coalesce(inq.open_inquiries, 0) open_inquiries, inq.last_inquiry_at,
             coalesce(inv.receivable, 0) receivable, coalesce(inv.overdue, 0) overdue
      from customers c
      left join stores s on s.id = c.store_id
      left join users au on au.id = c.assigned_user_id
      left join ord on ord.customer_id = c.id
      left join lastord on lastord.customer_id = c.id
      left join inq on inq.customer_id = c.id
      left join inv on inv.customer_id = c.id`,
  },
  {
    name: "v_cases",
    label: "案件の流れ (問い合わせ → 見積 → 受注・施工 → 請求 → 入金 を 1 行に)",
    description:
      "案件 1 件 = 1 行。case_type = order (受注あり)/quote (見積まで)/inquiry (問い合わせだけ)。inquiry_number・inquiry_date・inquiry_status と _label・channel と channel_label・quote_number・quote_date・quote_total・quote_status と _label・order_number・contract_date・order_status と order_status_label・scheduled_start・sales_date (売上計上日=施工完了)・total (受注金額・税込)・title・category と category_label・site_address・staff (担当者)・workers (施工担当)・invoice_number・invoice_date・due_date・invoice_status と _label・paid_amount・balance (未入金)・last_payment_date・store_id・store_name・customer_name・customer_code。「どこで止まっている案件か」「見積から受注までの日数」などに使う",
    sql: `
      select 'order' case_type, o.id case_id,
             i.number inquiry_number, substr(i.received_at, 1, 10) inquiry_date, i.status inquiry_status, ${L("inquiry_status", "i", "status")} inquiry_status_label,
             i.channel, ${L("channel", "i", "channel")} channel_label,
             q.number quote_number, coalesce(q.issued_at, substr(q.created_at, 1, 10)) quote_date, q.total quote_total, q.status quote_status, ${L("quote_status", "q", "status")} quote_status_label,
             o.number order_number, o.contract_date, o.status order_status, ${L("order_status", "o", "status")} order_status_label, o.scheduled_start, o.sales_date, o.total,
             o.title, o.category, ${L("category", "o", "category")} category_label, o.site_address, so.staff_names staff, so.worker_names workers,
             inv.number invoice_number, inv.issue_date invoice_date, inv.due_date, inv.status invoice_status, ${L("invoice_status", "inv", "status")} invoice_status_label, inv.paid_amount, (inv.total - inv.paid_amount) balance,
             (select max(p.date) from payments p where p.invoice_id = inv.id) last_payment_date,
             o.store_id, s.name store_name, o.customer_id, c.name customer_name, c.code customer_code
      from orders o
      left join quotes q on q.id = o.quote_id
      left join inquiries i on i.id = q.inquiry_id
      left join invoices inv on inv.id = (select x.id from invoices x where (x.order_id = o.id or x.id = o.invoice_id) and x.status <> 'void' order by x.issue_date desc limit 1)
      left join sales_orders so on so.order_id = o.id
      left join stores s on s.id = o.store_id
      left join customers c on c.id = o.customer_id
      union all
      select 'quote', q.id,
             i.number, substr(i.received_at, 1, 10), i.status, ${L("inquiry_status", "i", "status")},
             i.channel, ${L("channel", "i", "channel")},
             q.number, coalesce(q.issued_at, substr(q.created_at, 1, 10)), q.total, q.status, ${L("quote_status", "q", "status")},
             null, null, null, null, null, null, null,
             q.title, q.category, ${L("category", "q", "category")}, q.site_address, (select name from users where id = coalesce(q.estimator_id, q.created_by)), null,
             null, null, null, null, null, null, null, null,
             q.store_id, s.name, q.customer_id, c.name, c.code
      from quotes q
      left join inquiries i on i.id = q.inquiry_id
      left join stores s on s.id = q.store_id
      left join customers c on c.id = q.customer_id
      where q.order_id is null and not exists (select 1 from orders o where o.quote_id = q.id)
      union all
      select 'inquiry', i.id,
             i.number, substr(i.received_at, 1, 10), i.status, ${L("inquiry_status", "i", "status")},
             i.channel, ${L("channel", "i", "channel")},
             null, null, null, null, null,
             null, null, null, null, null, null, null,
             i.summary, i.category, ${L("category", "i", "category")}, null, (select name from users where id = i.assigned_user_id), null,
             null, null, null, null, null, null, null, null,
             i.store_id, s.name, i.customer_id, coalesce(c.name, i.contact_name), c.code
      from inquiries i
      left join stores s on s.id = i.store_id
      left join customers c on c.id = i.customer_id
      where i.quote_id is null`,
  },
  {
    name: "v_schedule",
    label: "予定 (担当者・店舗・顧客・受注の名前つき)",
    description:
      "予定 1 件 = 1 行。event_id・date・end_date・time (開始時刻または 午前/午後/終日)・end_time・kind (コード) と kind_label (引き取り・納品など)・title・store_id・store_name・company_wide (1=全社共通)・assignees (担当者の名前。「・」区切り)・customer_name・order_number・location・memo。期間は date (と end_date) で絞る",
    sql: `
      select e.id event_id, e.date, e.end_date, coalesce(e.start_time, case e.slot when 'am' then '午前' when 'pm' then '午後' end, '終日') time, e.end_time,
             e.kind, ${L("schedule_kind", "e", "kind")} kind_label, e.title, e.store_id, s.name store_name, coalesce(e.company_wide, 0) company_wide,
             ${NAMES("e.assignee_ids")} assignees, e.customer_id, c.name customer_name, o.number order_number, e.location, e.memo
      from schedule_events e
      left join stores s on s.id = e.store_id
      left join customers c on c.id = e.customer_id
      left join orders o on o.id = e.order_id`,
  },
  {
    name: "v_inquiries",
    label: "問い合わせ (受付経路・状態・担当者の名前つき)",
    description: "問い合わせ 1 件 = 1 行。number・received_date・channel と channel_label・category と category_label・status と status_label・summary・customer_name (未登録は contact_name)・contact_phone・store_id・store_name・assigned_staff・next_action・next_action_due・quote_number・result・area",
    sql: `
      select i.id inquiry_id, i.number, substr(i.received_at, 1, 10) received_date, i.received_at, i.channel, ${L("channel", "i", "channel")} channel_label,
             i.category, ${L("category", "i", "category")} category_label, i.status, ${L("inquiry_status", "i", "status")} status_label,
             i.summary, coalesce(c.name, i.contact_name) customer_name, i.customer_id, i.contact_phone,
             i.store_id, s.name store_name, u.name assigned_staff, i.next_action, i.next_action_due, q.number quote_number, i.result, i.area
      from inquiries i
      left join customers c on c.id = i.customer_id
      left join stores s on s.id = i.store_id
      left join users u on u.id = i.assigned_user_id
      left join quotes q on q.id = i.quote_id`,
  },
  {
    name: "v_quotes",
    label: "見積 (顧客・見積担当・状態の名前つき)",
    description: "見積 1 件 = 1 行。number・quote_date・customer_name・store_id・store_name・title・category と category_label・total (税込)・status と status_label・estimator (見積担当)・valid_until・order_number・site_address",
    sql: `
      select q.id quote_id, q.number, coalesce(q.issued_at, substr(q.created_at, 1, 10)) quote_date, c.name customer_name, q.customer_id, q.store_id, s.name store_name,
             q.title, q.category, ${L("category", "q", "category")} category_label, q.total, q.status, ${L("quote_status", "q", "status")} status_label,
             (select name from users where id = coalesce(q.estimator_id, q.created_by)) estimator, q.valid_until, o.number order_number, q.site_address
      from quotes q
      left join customers c on c.id = q.customer_id
      left join stores s on s.id = q.store_id
      left join orders o on o.id = q.order_id`,
  },
  {
    name: "v_invoices",
    label: "請求 (未入金残高・期日超過の判定つき)",
    description: "請求 1 件 = 1 行 (無効は除く)。number・issue_date・due_date・customer_name・store_id・store_name・order_number・total・paid_amount・balance (未入金)・status と status_label・is_overdue (1=今日の時点で期日超過)・expected_date (入金予定日)",
    sql: `
      select v.id invoice_id, v.number, v.issue_date, v.due_date, c.name customer_name, v.customer_id, v.store_id, s.name store_name, o.number order_number,
             v.total, v.paid_amount, (v.total - v.paid_amount) balance, v.status, ${L("invoice_status", "v", "status")} status_label,
             case when v.status in ('issued', 'partially_paid', 'overdue') and v.due_date < ${TODAY} and v.total > v.paid_amount then 1 else 0 end is_overdue,
             v.expected_date
      from invoices v
      left join customers c on c.id = v.customer_id
      left join stores s on s.id = v.store_id
      left join orders o on o.id = v.order_id
      where v.status <> 'void'`,
  },
  {
    name: "v_payments",
    label: "入金 (請求・顧客・店舗の名前つき)",
    description: "入金 1 件 = 1 行。date・amount・method と method_label (支払方法)・invoice_number・customer_name・store_id・store_name・memo",
    sql: `
      select p.id payment_id, p.date, p.amount, p.method, ${L("payment_method", "p", "method")} method_label, v.number invoice_number, c.name customer_name, v.customer_id, v.store_id, s.name store_name, p.memo
      from payments p
      join invoices v on v.id = p.invoice_id
      left join customers c on c.id = v.customer_id
      left join stores s on s.id = v.store_id`,
  },
  {
    name: "v_expenses",
    label: "経費 (申請者・状態の名前つき)",
    description: "経費 1 件 = 1 行。number・date・store_id・store_name・submitter・vendor (支払先)・account (勘定科目)・amount (税込)・status と status_label・payment_method と payment_method_label・description。集計は status in ('approved','paid') (承認済・精算済)",
    sql: `
      select e.id expense_id, e.number, e.date, e.store_id, s.name store_name, u.name submitter, e.vendor, e.account, e.amount, e.tax_amount,
             e.status, ${L("expense_status", "e", "status")} status_label, e.payment_method, ${L("expense_method", "e", "payment_method")} payment_method_label, e.description
      from expenses e
      left join stores s on s.id = e.store_id
      left join users u on u.id = e.submitted_by`,
  },
  {
    name: "v_purchases",
    label: "仕入 (仕入先・状態・案件の名前つき)",
    description: "仕入請求 1 件 = 1 行。number・invoice_date・due_date・supplier_name・store_id・store_name・amount (税込)・account・description・status と status_label・order_number (ひも付いた案件)",
    sql: `
      select p.id purchase_id, p.number, p.invoice_date, p.due_date, sp.name supplier_name, p.supplier_id, p.store_id, s.name store_name, p.amount, p.account, p.description,
             p.status, ${L("purchase_status", "p", "status")} status_label, o.number order_number
      from purchases p
      left join suppliers sp on sp.id = p.supplier_id
      left join stores s on s.id = p.store_id
      left join orders o on o.id = p.order_id`,
  },
  {
    name: "v_purchase_orders",
    label: "発注書 (仕入先・明細の要約つき)",
    description: "発注書 1 枚 = 1 行。number・issued_on・supplier_name・store_id・store_name・status と status_label・lines (明細: 品名×数量)・order_numbers (明細の案件番号)",
    sql: `
      select po.id purchase_order_id, po.number, po.issued_on, sp.name supplier_name, po.supplier_id, po.store_id, s.name store_name, po.status, ${L("purchase_order_status", "po", "status")} status_label,
             (select group_concat(coalesce(json_extract(j.value, '$.name'), '') || '×' || coalesce(json_extract(j.value, '$.qty'), '') || coalesce(json_extract(j.value, '$.unit'), ''), '、') from json_each(po.lines) j) lines,
             (select group_concat(distinct json_extract(j.value, '$.orderNumber')) from json_each(po.lines) j) order_numbers
      from purchase_orders po
      left join suppliers sp on sp.id = po.supplier_id
      left join stores s on s.id = po.store_id`,
  },
  {
    name: "v_comm_logs",
    label: "連絡履歴 (お客様・協力業者とのやりとり)",
    description: "やりとり 1 件 = 1 行。at・channel と channel_label・direction (inbound=受/outbound=発)・customer_name・supplier_name・contact_name・subject・body・staff",
    sql: `
      select l.id comm_id, l.at, l.channel, ${L("channel", "l", "channel")} channel_label, l.direction,
             c.name customer_name, l.customer_id, sp.name supplier_name, l.contact_name, l.subject, l.body, u.name staff, coalesce(l.store_id, c.store_id) store_id
      from comm_logs l
      left join customers c on c.id = l.customer_id
      left join suppliers sp on sp.id = l.supplier_id
      left join users u on u.id = l.user_id`,
  },
  {
    name: "v_staff_sales",
    label: "担当者ごとの売上 (受注と担当者を結合済み)",
    description: "受注 × 担当者 = 1 行 (1 件に複数の担当者がいるときはそれぞれに全額)。staff_name (空白なしの氏名。例: 中村花子)・order_number・sales_date・contract_date・store_id・store_name・customer_name・total。担当者別の売上は sum(total) group by staff_name。人で絞るときは staff_name like '%中村花子%' (空白を除いた名前)",
    sql: `
      select os.staff_name, so.order_id, so.number order_number, so.sales_date, so.contract_date, so.store_id, so.store_name, so.customer_name, so.total, so.title
      from order_staff os join sales_orders so on so.order_id = os.order_id`,
  },
  {
    name: "v_surveys",
    label: "お客様アンケート (はがき。評価・担当者・コメント)",
    description: "アンケート 1 枚 = 1 行。answered_on (回答日)・store_id・store_name・order_number・customer_name・phone_score (①電話対応)・sales_score (②営業対応)・craftsman_score (③職人対応)・finish_score (④仕上がり) (いずれも 5 段階)・sales_name (営業担当)・craftsman_name (担当職人)・would_use_again (また利用したいか)・priorities (重視したこと)・media (知ったきっかけ)・comment (お客様の声)・comment_tone (praise=お褒め/request=要望/complaint=不満/neutral)",
    sql: `
      select sv.id survey_id, coalesce(sv.answered_on, substr(sv.received_at, 1, 10)) answered_on, sv.store_id, s.name store_name, o.number order_number, c.name customer_name,
             sv.phone_score, sv.sales_score, sv.craftsman_score, sv.finish_score,
             coalesce(su.name, sv.sales_name) sales_name, coalesce(cu.name, sv.craftsman_name) craftsman_name,
             sv.would_use_again, sv.priorities, sv.media, sv.comment, sv.comment_tone, sv.postcard_no
      from survey_responses sv
      left join stores s on s.id = sv.store_id
      left join orders o on o.id = sv.order_id
      left join customers c on c.id = sv.customer_id
      left join users su on su.id = sv.sales_user_id
      left join users cu on cu.id = sv.craftsman_user_id`,
  },
  {
    name: "v_quality",
    label: "クレーム・手直し (原因・対策・担当者つき)",
    description: "1 件 = 1 行。number・occurred_on・kind と kind_label (手直し/クレーム/クレーム・手直し)・points・store_id・store_name・attribution (store=店舗 / office=事務のポイント)・order_number (案件。空 = まだひも付いていない)・site_name (現場名)・customer_name・description・cause (原因)・countermeasure (対策)・status と status_label (対応中/解決)・resolved_on・responsible (担当者の名前)・counted (0=集計に入れない)・category (精度・確認不足・説明不足・その他)・origin (発生のきっかけ)・from_sheet (1=スプレッドシートから取込)",
    sql: `
      select q.id quality_id, q.number, q.occurred_on, q.kind, ${L("quality_kind", "q", "kind")} kind_label, q.points, q.store_id, s.name store_name, coalesce(q.attribution, 'store') attribution, o.number order_number, q.site_name, c.name customer_name,
             q.description, q.cause, q.countermeasure, q.status, ${L("quality_status", "q", "status")} status_label, q.resolved_on,
             ${NAMES("q.responsible_user_ids")} responsible, coalesce(q.counted, 1) counted, q.category, q.origin, case when q.source_ref is null then 0 else 1 end from_sheet
      from quality_issues q
      left join stores s on s.id = q.store_id
      left join orders o on o.id = q.order_id
      left join customers c on c.id = q.customer_id`,
  },
  {
    name: "v_reviews",
    label: "Google 口コミ (店舗・社員・評価)",
    description: "口コミ 1 件 = 1 行。posted_on (事務の入力日 = 集計月)・store_id・store_name・staff (名前の挙がった社員。アカウントのない人は名前)・reviewer_name・rating (★)・comment・has_photo・points・order_number・note (支払日・確認などのメモ)",
    sql: `
      select r.id review_id, r.posted_on, r.store_id, s.name store_name, coalesce(u.name, case when r.user_id like 'name:%' then substr(r.user_id, 6) end) staff, r.reviewer_name, r.rating, r.comment, coalesce(r.has_photo, 0) has_photo, r.points, o.number order_number, r.note
      from google_reviews r
      left join stores s on s.id = r.store_id
      left join users u on u.id = r.user_id
      left join orders o on o.id = r.order_id`,
  },
  {
    name: "v_survey_history",
    label: "アンケートの過去の集計 (H26〜R4 の集計表。年度 × 店舗 × 設問 × 回答の件数)",
    description: "スプレッドシート「お客様アンケート集計表」の集計表 1 行 = 1 行。fiscal_label (H26・R2 など)・start_year (西暦の始まりの年)・period (期間)・store_id・store_name (空 = 全社の表。令和は店舗ごと、工場 = 合志店)・question (回答数・電話応対・営業担当者・職人の対応・工事の仕上り・重視したこと・情報媒体・次回)・answer (大変満足・チラシ など)・count。はがき 1 枚ごとの回答は survey_responses (2024 年〜)",
    sql: `
      select h.fiscal_label, h.start_year, h.period, h.store_id, s.name store_name, h.question, h.answer, h.count
      from survey_history h
      left join stores s on s.id = h.store_id`,
  },
  {
    name: "v_cashbook",
    label: "現金出納帳 (店舗の手元現金の入出金)",
    description: "1 件 = 1 行。number・date・store_id・store_name・direction と direction_label (入金/出金)・amount・account (科目)・counterparty (相手)・description (摘要)・source と source_label (手入力・入金・経費の精算など)・recorded_by",
    sql: `
      select x.id cash_id, x.number, x.date, x.store_id, s.name store_name, x.direction, ${L("cash_direction", "x", "direction")} direction_label, x.amount, x.account, x.counterparty, x.description,
             x.source, ${L("cash_source", "x", "source")} source_label, u.name recorded_by
      from cash_entries x
      left join stores s on s.id = x.store_id
      left join users u on u.id = x.recorded_by`,
  },
  {
    name: "v_activity",
    label: "社内の活動 (変更履歴: 誰が・いつ・何を登録・変更・削除・承認・取込したか。見られる範囲だけ)",
    description:
      "操作 1 件 = 1 行。at (UTC)・date / hour (日本時間の日付・時)・user_id・user_name・action (create・update・delete・approve・reject・submit・send・status・login・export・import)・action_label・entity (customer・order・schedule・approval・knowledge・user・settings など)・entity_label・entity_id・target (対象の名前)・summary (内容)・store_id・store_name。人ごと・日ごとの件数は count(*) group by",
    sql: `
      select a.id, a.at, date(a.at, '+9 hours') date, cast(strftime('%H', a.at, '+9 hours') as integer) hour,
             a.user_id, coalesce(u.name, case when a.user_id = 'system' then 'システム' end) user_name,
             a.action, ${L("audit_action", "a", "action")} action_label,
             a.entity, coalesce(${L("audit_entity", "a", "entity")}, a.entity) entity_label, a.entity_id,
             a.entity_label target, a.summary, a.store_id, s.name store_name
      from audit_logs a
      left join users u on u.id = a.user_id
      left join stores s on s.id = a.store_id`,
  },
  {
    name: "v_approvals",
    label: "承認 (申請・承認者・状態)",
    description: "承認 1 件 = 1 行。type と type_label (見積・契約・経費・支払など)・title・amount・store_id・store_name・requested_by (申請者)・required_role と _label (店長/管理者)・status と status_label (承認待ち/承認/差戻し/却下)・request_comment・created_at・decided_by・decided_at・decision_comment",
    sql: `
      select a.id approval_id, a.type, ${L("approval_type", "a", "type")} type_label, a.title, a.amount, a.store_id, s.name store_name, ru.name requested_by,
             a.required_role, ${L("required_role", "a", "required_role")} required_role_label, a.status, ${L("approval_status", "a", "status")} status_label,
             a.request_comment, a.created_at, du.name decided_by, a.decided_at, a.decision_comment
      from approvals a
      left join stores s on s.id = a.store_id
      left join users ru on ru.id = a.requested_by
      left join users du on du.id = a.decided_by`,
  },
  {
    name: "v_threads",
    label: "社内連絡・業務依頼 (スレッドと最新の投稿)",
    description: "スレッド 1 件 = 1 行。title・kind と kind_label (依頼/報告/質問/お知らせ)・store_name・created_by・participants・assignees (依頼先)・due_date・task_status と task_status_label・status (open/done)・related_label (関係する案件など)・message_count・last_message・last_message_at・updated_at",
    sql: `
      select t.id thread_id, t.title, t.kind, ${L("thread_kind", "t", "kind")} kind_label, t.store_id, s.name store_name, cu.name created_by,
             ${NAMES("t.participants")} participants, ${NAMES("t.assignee_ids")} assignees, t.due_date, t.task_status, ${L("task_status", "t", "task_status")} task_status_label,
             t.status, t.related_label, (select count(*) from messages m where m.thread_id = t.id) message_count,
             (select m.body from messages m where m.thread_id = t.id order by m.at desc limit 1) last_message,
             (select max(m.at) from messages m where m.thread_id = t.id) last_message_at, t.updated_at
      from threads t
      left join stores s on s.id = t.store_id
      left join users cu on cu.id = t.created_by`,
  },
  {
    name: "v_attachments",
    label: "資料・写真 (登録先・顧客・説明つき。ファイルの中身は入っていない)",
    description: "ファイル 1 件 = 1 行。file_name・kind (photo/file)・parent_type (登録先の種類: customer・inquiry・quote・order・expense・purchase・document)・parent_id・customer_name・store_name・caption (説明)・taken_at・uploaded_by・uploaded_at・size",
    sql: `
      select f.id attachment_id, f.file_name, f.kind, f.parent_type, f.parent_id, c.name customer_name, f.store_id, s.name store_name, f.caption, f.taken_at,
             u.name uploaded_by, f.uploaded_at, f.size, f.content_type
      from attachments f
      left join customers c on c.id = f.customer_id
      left join stores s on s.id = f.store_id
      left join users u on u.id = f.uploaded_by`,
  },
  {
    name: "v_documents",
    label: "書類取込 (紙→データ。読み取りの状態と登録先)",
    description: "取り込んだ書類 1 件 = 1 行。kind と kind_label (手書き見積・レシート・請求書・アンケートなど)・file_name・status と status_label・store_name・uploaded_by・uploaded_at・linked_type・linked_id・confidence (読み取りの確からしさ)",
    sql: `
      select d.id document_id, d.kind, ${L("document_kind", "d", "kind")} kind_label, d.file_name, d.status, ${L("document_status", "d", "status")} status_label,
             d.store_id, s.name store_name, u.name uploaded_by, d.uploaded_at, d.linked_type, d.linked_id, d.confidence
      from documents d
      left join stores s on s.id = d.store_id
      left join users u on u.id = d.uploaded_by`,
  },
  {
    name: "v_products",
    label: "商品マスタ (品名・等級・サイズ・単価)",
    description: "商品 1 件 = 1 行。category と category_label・name・grade・size_label・unit・unit_price (税抜の標準単価)・description・active (1=使用中)。実際に売れた単価は sales_items",
    sql: `
      select p.id product_id, p.category, ${L("category", "p", "category")} category_label, p.name, p.grade, p.size_label, p.unit, p.unit_price, p.description, coalesce(p.active, 1) active
      from products p`,
  },
  {
    name: "v_staff",
    label: "社員 (ロール・所属)",
    description: "社員 1 人 = 1 行。user_id・name・kana・role と role_label・store_id・store_name・title (役職)・active (1=在籍)",
    sql: `
      select u.id user_id, u.name, u.kana, u.role, ${L("role", "u", "role")} role_label, u.store_id, s.name store_name, u.title, coalesce(u.active, 1) active
      from users u
      left join stores s on s.id = u.store_id`,
  },
  {
    name: "v_suppliers",
    label: "仕入先・協力業者 (取引の件数と金額つき)",
    description: "仕入先 1 社 = 1 行。supplier_id・name・kind (supplier=仕入先/partner=協力業者)・category (取扱品目)・phone・fax・contact_name・payment_terms・purchase_count・purchase_total (仕入の合計・税込)・last_purchase_date・po_count (発注書の数)・last_po_date・active",
    sql: `
      select sp.id supplier_id, sp.name, sp.kind, sp.category, sp.phone, sp.fax, sp.contact_name, sp.payment_terms,
             (select count(*) from purchases p where p.supplier_id = sp.id and p.status <> 'rejected') purchase_count,
             (select coalesce(sum(p.amount), 0) from purchases p where p.supplier_id = sp.id and p.status <> 'rejected') purchase_total,
             (select max(p.invoice_date) from purchases p where p.supplier_id = sp.id) last_purchase_date,
             (select count(*) from purchase_orders po where po.supplier_id = sp.id and po.status <> 'cancelled') po_count,
             (select max(po.issued_on) from purchase_orders po where po.supplier_id = sp.id) last_po_date,
             coalesce(sp.active, 1) active
      from suppliers sp`,
  },
  {
    name: "v_fax",
    label: "FAX の送受信 (相手・状態・AI の要約)",
    description: "FAX 1 件 = 1 行。number・direction (inbound=受信/outbound=送信)・at・status と status_label・triage と triage_label (受信の仕分け)・remote_name・remote_number・supplier_name・customer_name・store_name・document_type と summary (AI の読み取り)",
    sql: `
      select fx.id fax_id, fx.number, fx.direction, fx.at, fx.status, ${L("fax_status", "fx", "status")} status_label, fx.triage, ${L("fax_triage", "fx", "triage")} triage_label,
             fx.remote_name, fx.remote_number, sp.name supplier_name, c.name customer_name, fx.store_id, s.name store_name,
             json_extract(fx.ai, '$.documentType') document_type, json_extract(fx.ai, '$.summary') summary
      from fax_messages fx
      left join suppliers sp on sp.id = fx.supplier_id
      left join customers c on c.id = fx.customer_id
      left join stores s on s.id = fx.store_id`,
  },
  {
    name: "v_knowledge",
    label: "社内資料 (業務ルール・議事録・マニュアル・価格など。見られる範囲のものだけ)",
    description: "資料 1 件 = 1 行。title・category・record_date (議事録の日付)・body (本文)・tags・updated_at・owner_name (内容の担当者)・review_due (次に確かめる日)・reviewed_at (最後に確かめた日時)・is_stale (確認期限切れ = 1)。言葉で探すときは body like '%…%'",
    sql: `
      select k.id knowledge_id, k.title, k.category, k.record_date, k.body, k.tags, k.updated_at,
        (select u.name from users u where u.id = k.owner_id) owner_name, k.review_due, k.reviewed_at,
        case when k.review_due is not null and k.review_due < date('now', 'localtime') then 1 else 0 end is_stale
      from knowledge k where coalesce(k.active, 1) = 1`,
  },
  {
    name: "v_holidays",
    label: "会社の休業日",
    description: "休業日 1 日 = 1 行。date・label",
    sql: `select h.date, h.label from company_holidays h`,
  },
];

/* ================================================================== */
/* 閲覧範囲 (全店舗を見られない人は、生の表をその人の範囲で覆う)                  */
/* ================================================================== */

const sq = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** 店舗のロールの閲覧範囲で、生の表を覆う一時ビュー。全店舗を見られる人は空 (覆わない) */
export function scopeStatements(user: Pick<User, "id" | "role" | "storeId">): string[] {
  // 削除した問い合わせ (誤って登録したもの。src/lib/inquiry-delete.ts) は全員の SQL から外す (集計に入れない)
  const liveInquiries = (extra = "") => `create temp view inquiries as select * from main.inquiries where deleted is null${extra};`;
  if (canSeeAllStores(user as User)) return [liveInquiries()];
  const store = sq(user.storeId as StoreId);
  const me = sq(user.id);
  const manager = user.role === "store_manager";
  // 閲覧の範囲の設定 (src/lib/access-policy.ts。AI の読み取りの写し = assistantReadUser): 経営の数字 (figures)・顧客情報 (records) を全店舗に広げる
  const figures = canSeeAllStoreFigures(user as User);
  const records = canSeeAllCustomerRecords(user as User);
  const v = (name: string, sql: string) => `create temp view ${name} as ${sql};`;
  const none = (name: string) => v(name, `select * from main.${name} where 0`);
  const byStore = (name: string) => v(name, `select * from main.${name} where store_id = ${store}`);
  /** 全店舗に広げるときは覆わない (生の表のまま) */
  const unless = (open: boolean, stmt: string) => (open ? [] : [stmt]);
  const knowledgeVis: Record<Role, string> = { admin: "", hq_staff: "", store_manager: "('all', 'manager')", store_staff: "('all')" };
  const mgmtTables = ["sales_adjustments", "material_usages", "mgmt_entries", "stock_moves", "material_transfers", "order_attributions", "expense_classes", "allocation_runs", "period_closes", "purchase_line_allocs", "mgmt_rules", "materials", "material_costs", "boms"];
  // 分析用の表 (sales_orders など): 経営の数字だけ全店舗のとき、顧客情報を見られない店舗の行はお客様の名前・ID・地区・件名を空にする
  const salesCols = `order_id, number, sales_date, contract_date, status, store_id, store_name, null as customer_id, null as customer_code, null as customer_name, customer_type, null as area, null as title, total, ${AMOUNT_KEYS.map((k) => `amt_${k}`).join(", ")}, tatami_cost, purchase_cost, staff_names, worker_names, item_source`;
  return [
    // 顧客情報の表 (顧客・問い合わせ・見積・受注・請求書・クレーム・アンケート・写真・取込書類)
    ...(records ? [] : ["customers", "quotes", "orders", "invoices", "quality_issues", "survey_responses", "photo_albums"].map(byStore)),
    liveInquiries(records ? "" : ` and store_id = ${store}`),
    // 写真・資料: 顧客情報を全店舗に広げたときも、ほかの店舗の分はお客様・案件の写真だけ (経費のレシートなどは自店舗)
    records ? v("attachments", `select * from main.attachments where store_id = ${store} or parent_type in ('customer', 'inquiry', 'quote', 'order')`) : byStore("attachments"),
    // 店舗の表 (現金出納・承認・発注書・取込書類 (レシート・仕入の請求書を含む) は従来どおり自店舗)
    ...["cash_entries", "approvals", "purchase_orders", "documents"].map(byStore),
    // Google 口コミ・アンケートの過去の集計 (自店舗の表だけ。全社の表 = store_id が空は見せない): 経営の数字
    ...unless(figures, byStore("google_reviews")),
    ...unless(figures, byStore("survey_history")),
    // 売上の分析用の表: 経営の数字
    ...(figures
      ? records
        ? []
        : [
            v("sales_orders", `select * from main.sales_orders where store_id = ${store} union all select ${salesCols} from main.sales_orders where store_id is null or store_id != ${store}`),
            v("sales_items", `select order_id, line_no, sales_date, store_id, case when store_id = ${store} then customer_id end as customer_id, category, product, qty, unit_price, amount from main.sales_items`),
          ]
      : ["sales_orders", "sales_items"].map(byStore)),
    ...(figures ? [] : [v("order_staff", `select * from main.order_staff where order_id in (select order_id from main.sales_orders where store_id = ${store})`)]),
    // 予定の計画 (作業の内容・製造の予定・車両の予約・仮押さえ。src/lib/scheduling/access.ts と同じ: 自店舗)
    ...["job_specs", "production_jobs", "resource_bookings", "schedule_holds"].map(byStore),
    // 作業日報の手入力 (permissions.ts の canViewWorkReport: 自店舗)・販促の記録 (canViewPromoAnalysis: 経営の数字。全社員でなければ店長は自店舗、店舗スタッフは見ない)
    byStore("work_report_days"),
    ...(figures ? [] : [manager ? byStore("promotions") : none("promotions")]),
    ...unless(records, v("payments", "select * from main.payments where invoice_id in (select id from main.invoices where store_id = " + store + ")")),
    // 領収書・帳票の出力記録 (お客様の名前・金額): 請求書と同じ (顧客情報を全店舗に広げたときは全店舗)
    ...(records ? [] : ["receipts", "doc_outputs"].map(byStore)),
    // 経費: 店長は自店舗、店舗スタッフは自分の申請 / 仕入: 店長は自店舗 / 仕入先: 店長のみ
    v("expenses", `select * from main.expenses where ${manager ? `store_id = ${store}` : `submitted_by = ${me}`}`),
    manager ? byStore("purchases") : none("purchases"),
    manager ? v("suppliers", "select * from main.suppliers") : none("suppliers"),
    // 連絡履歴: 見える顧客のもの・店舗のもの (仕入先とのやりとりは店長)。顧客情報を全店舗に広げたときは、お客様とのやりとりは全店舗
    v(
      "comm_logs",
      records
        ? `select * from main.comm_logs where customer_id is not null or (supplier_id is null and store_id = ${store})${manager ? ` or (customer_id is null and supplier_id is not null)` : ""}`
        : `select * from main.comm_logs where customer_id in (select id from main.customers where store_id = ${store}) or (customer_id is null and supplier_id is null and store_id = ${store})${manager ? ` or (customer_id is null and supplier_id is not null)` : ""}`,
    ),
    // 社内連絡: 自店舗・全社・参加/作成したもの
    v("threads", `select * from main.threads where store_id is null or store_id = ${store} or created_by = ${me} or participants like ${sq(`%"${user.id}"%`)}`),
    v("messages", `select * from main.messages where thread_id in (select id from main.threads where store_id is null or store_id = ${store} or created_by = ${me} or participants like ${sq(`%"${user.id}"%`)})`),
    // 社内資料: 見られる人の設定
    v("knowledge", `select * from main.knowledge where active = 1 and (visibility is null or visibility in ${knowledgeVis[user.role]})`),
    // 案件の変更のお知らせ (src/lib/change-notices.ts の canViewNotice と同じ: 自分あて・自分が変更したもの)
    v("change_notices", `select * from main.change_notices where actor_id = ${me} or recipients like ${sq(`%"${user.id}"%`)}`),
    // 文書の下書き (permissions.ts の canViewDocDraft と同じ: 所属店舗の文書と自分が作った文書)
    v("doc_drafts", `select * from main.doc_drafts where store_id = ${store} or created_by = ${me}`),
    // 施工事例の投稿 (canViewCasePost: 案件の店舗と自分が作った投稿)・整理整頓チェック (canViewTidyCheck: 店長は全店舗、店舗スタッフは自店舗)
    v("case_posts", `select * from main.case_posts where store_id = ${store} or created_by = ${me}`),
    ...(manager ? [] : [byStore("tidy_checks")]),
    // 社員: 名前・ロール・所属だけ
    v("users", "select id, name, kana, role, store_id, title, active from main.users"),
    // FAX: 自店舗の送信・仕分け済みの受信、担当・登録したもの
    v("fax_messages", `select * from main.fax_messages where user_id = ${me} or assigned_user_id = ${me} or (store_id = ${store} and (direction = 'outbound' or triage in ('auto', 'accepted')))`),
    // 変更履歴 (社内の活動): permissions.ts の canViewAuditEntry と同じ (本人の操作 + 所属店舗の操作。ほかの人のログインは除く。店舗スタッフは案件・顧客・予定などの対象だけ)
    v(
      "audit_logs",
      `select * from main.audit_logs where user_id = ${me} or (entity != 'session' and store_id = ${store}${manager ? "" : ` and entity in (${[...STAFF_AUDIT_ENTITIES].map(sq).join(", ")})`})`,
    ),
    // 見せない表 (送信履歴・設定・資料台帳・FAX 番号・地図・検索の索引)
    ...["deliveries", "settings", "source_files", "fax_numbers", "map_locations", "map_location_refs", "map_documents", "map_document_links", "search_docs", "_rowhash"].map(none),
    // 慶弔リスト (ご家族の情報。permissions.ts の canViewCondolences。事務担当の店舗ロールも SQL では見せない)
    none("condolences"),
    // 管理会計 (src/lib/mgmt/access.ts と同じ範囲): 経営の数字を全社員に公開しているときは全店舗。そうでなければ店長は自店舗の行と設定・マスタ、店舗スタッフは品目・営業エリアだけ
    ...(figures
      ? []
      : manager
        ? [
            v("sales_adjustments", `select * from main.sales_adjustments where from_store_id = ${store} or to_store_id = ${store}`),
            v("material_transfers", `select * from main.material_transfers where from_store_id = ${store} or to_store_id = ${store}`),
            ...["material_usages", "mgmt_entries"].map(byStore),
            v("stock_moves", `select * from main.stock_moves where store_id = ${store} or from_loc = ${sq(`store:${user.storeId}`)} or to_loc = ${sq(`store:${user.storeId}`)}`),
            v("order_attributions", `select * from main.order_attributions where order_id in (select id from main.orders where store_id = ${store}) or received_store_id = ${store} or work_store_id = ${store}`),
            v("expense_classes", `select * from main.expense_classes where expense_id in (select id from main.expenses where store_id = ${store})`),
            // 案分・月次確定の写し・仕入明細の振り分けは全店舗の数字を含むため見せない
            ...["allocation_runs", "period_closes", "purchase_line_allocs"].map(none),
          ]
        : mgmtTables.map(none)),
    // 有給・休日出勤 (permissions.ts の canViewLeaveOf と同じ): 店長は自店舗の社員、店舗スタッフは本人
    ...["leave_requests", "leave_grants", "holiday_works"].map((t) => v(t, `select * from main.${t} where ${manager ? `user_id in (select id from main.users where store_id = ${store})` : `user_id = ${me}`}`)),
  ];
}

/** 統合ビューを作る一時ビューの文 (閲覧範囲で覆ったあとに作るので、ビューも範囲の内側になる) */
export function viewStatements(): string[] {
  return VIEWS.map((v) => `create temp view ${v.name} as ${v.sql.trim()};`);
}

/* ================================================================== */
/* 3) データ辞書                                                          */
/* ================================================================== */

/** 指標の定義 (画面・経営ダッシュボードと同じ) */
export const METRICS: { name: string; definition: string }[] = [
  { name: "売上", definition: "受注の金額 (税込) を売上計上日 (sales_date = 施工完了日) で数える。キャンセルは除く。SQL: select sum(total) from sales_orders where sales_date between …" },
  { name: "受注金額・受注件数", definition: "契約日 (contract_date) で数える (キャンセルを除く)。sales_orders の contract_date" },
  { name: "種別ごとの売上", definition: "sales_orders の amt_tatami (畳)・amt_fusuma (襖)・amt_shoji (障子)・amt_amido (網戸)・amt_curtain (カーテン)・amt_cloth (クロス)・amt_own (自社商品・小売)・amt_misc (諸経費・雑工事)・amt_discount (値引)。合計すると total" },
  { name: "商品別の売上・数量・平均単価", definition: "sales_items (明細のある受注だけ)。平均単価 = sum(amount) / sum(qty)。品名は表記ゆれがあるので product like '%きずな%' のように探す" },
  { name: "粗利", definition: "売上 − 記録された原価 (tatami_cost + purchase_cost)。襖・障子などの材料原価は記録がなく、粗利は実際より大きく出ることを必ず添える" },
  { name: "簡易粗利 (経営ダッシュボード)", definition: "売上 − 畳原価 (sales_orders の tatami_cost、売上計上日) − 仕入 (purchases の amount、請求日) − 経費 (expenses の承認済・精算済の amount)" },
  { name: "担当者別の売上", definition: "v_staff_sales (order_staff と sales_orders) で sum(total) group by staff_name。担当 = 見積の担当者 (移行データは販売管理ソフトの担当者欄の 1 番目。3 番目の伝票の入力者は数えない)。経営ダッシュボードの担当者別と同じ" },
  { name: "未入金・売掛", definition: "v_invoices の balance (total − paid_amount)。状態が 発行済・一部入金・期日超過 のもの。期日超過は is_overdue = 1。お客様ごとの未入金残高は v_customers.receivable (その人の請求の残高の合計。MAX ではなく合計)" },
  { name: "人・店舗・顧客ごとの合計", definition: "ごとの合計は sum() で数える (1 件の最大 max() と取り違えない)。件数は count(*)、平均は avg() か 合計÷件数" },
  { name: "成約率", definition: "受注になった見積 ÷ 結果が出た見積 (受注・失注・期限切れ)。v_quotes の status と order_number" },
  { name: "前回の担当者", definition: "v_customers の last_staff (最後の受注の担当者)・last_workers (施工担当)" },
  { name: "アンケートの返信率 (KPI)", definition: "はがきの枚数 ÷ 個人件数 × 100。個人件数は年間チラシ計画の値 (ない月は個人のお客様の案件から、同じお客様・同じ店舗の 30 日以内のリピートを 1 件にまとめた数)。SQL では作らず、会社の全体像 (KPI と同じ集計) の値を使う" },
  { name: "クレーム・手直しの件数と率 (経営管理)", definition: "v_quality の counted = 1 の行。クレーム = kind が claim か claim_rework、手直し = rework か claim_rework (クレーム＋手直しはそれぞれに 1 件)。率 = 件数 ÷ 全案件数 (売上台帳の行 + 新システムで完了した受注)。率は会社の全体像の値を使う" },
  { name: "クレーム・手直しポイント (インセンティブ)", definition: "クレーム 2 点・手直し 1 点・クレーム＋手直し 3 点。同じ案件 (受注) の同じ月は合わせて最大 3 点 (月締め)。ポイント率 = ポイント ÷ 全案件数 × 100。販促の KPI (チラシの反響・客単価) はインセンティブに入れない" },
];

/** 言葉の言い換え (質問の言葉 → 表・列) */
export const GLOSSARY: [string, string][] = [
  ["お客様・顧客・得意先・施主", "customers / v_customers"],
  ["案件・工事・現場・施工・受注・契約", "orders / sales_orders / v_cases"],
  ["売上・売り上げ・実績", "sales_orders (sales_date)"],
  ["見積・見積書・お見積り", "quotes / v_quotes"],
  ["問い合わせ・依頼・相談・反響・TEL", "inquiries / v_inquiries"],
  ["請求・請求書・売掛・未入金・督促", "invoices / v_invoices"],
  ["入金・支払い (お客様から)", "payments / v_payments"],
  ["予定・スケジュール・引き取り・納品・見積り・現地調査・現調・現場見積・現見・訪問・現場管理", "schedule_events / v_schedule"],
  ["経費・レシート・精算", "expenses / v_expenses"],
  ["仕入・買掛・材料費・外注 (請求)", "purchases / v_purchases"],
  ["発注・発注書・注文 (仕入先へ)", "purchase_orders / v_purchase_orders"],
  ["仕入先・協力業者・業者・取引先", "suppliers"],
  ["連絡・やりとり・電話の記録・着信", "comm_logs / v_comm_logs"],
  ["議事録・会議・決定事項・ルール・マニュアル", "knowledge (category・record_date)。クライアントから受け取った資料の中身 (表計算・Word・PDF) は SQL には入っていない: 道具 search_materials"],
  ["活動・操作・誰が何をした・最近の変更・削除された記録・ログイン", "audit_logs / v_activity (日本時間の date・hour。集計は道具 data_registry の activity でもよい)"],
  ["クレーム・手直し", "quality_issues"],
  ["アンケート・お客様の声", "survey_responses"],
  ["口コミ・レビュー", "google_reviews"],
  ["社員・スタッフ・職人・担当", "users (名前で結合)"],
  ["店舗: 合志・中央・西・玉名・本部 (本社)", "store_id = koshi・chuo・nishi・tamana・hq (store_name に店舗名)"],
  ["アンケート・はがき・お客様の評価・満足度", "survey_responses / v_surveys"],
  ["過去のアンケートの集計・H26〜R4・4年比較・年度の比較", "survey_history / v_survey_history"],
  ["クレーム・手直し・不具合・やり直し", "quality_issues / v_quality"],
  ["口コミ・レビュー・Google", "google_reviews / v_reviews"],
  ["現金・手元現金・出納", "cash_entries / v_cashbook"],
  ["承認・申請・決裁", "approvals / v_approvals"],
  ["社内連絡・業務依頼・メッセージ・報告", "threads・messages / v_threads"],
  ["写真・資料・ファイル・添付", "attachments / v_attachments"],
  ["書類取込・読み取り・紙の書類", "documents / v_documents"],
  ["商品・価格表・単価の標準・マスタ", "products / v_products"],
  ["FAX・ファックス", "fax_messages / v_fax"],
  ["休み・休業日・定休日", "company_holidays / v_holidays"],
  ["管理会計・店舗別損益・独立採算・管理売上・粗利益 (管理会計)・材料原価率・案分", "道具 management_accounting を使う (計算は画面と同じ。SQL で計算し直さない)"],
  ["内部受注・店舗間の売上配分・本部の特殊配分", "sales_adjustments (依頼元 from_store_id に +amount、施工店舗 to_store_id に −amount。reversal_of があれば取消しの行)"],
  ["材料原価・材料構成・畳表の仮原価・畳床", "materials・material_costs (単価の履歴)・boms・material_usages (受注ごと。stage と status)"],
  ["在庫・材料移動", "stock_moves (在庫の移動。from_loc → to_loc。store:<店舗>)・material_transfers (店舗間の材料移動 = 原価の振替。from_store_id の材料費 −・to_store_id の材料費 +)"],
  ["仕入明細の振り分け・未確認の仕入請求書", "purchase_line_allocs (status = confirmed / needs_review / unassigned)"],
];

const CODE_KINDS: [string, string][] = [
  ["inquiry_status", "問い合わせの状態"],
  ["quote_status", "見積の状態"],
  ["order_status", "受注の状態"],
  ["invoice_status", "請求の状態"],
  ["expense_status", "経費の状態"],
  ["purchase_status", "仕入の状態"],
  ["purchase_order_status", "発注書の状態"],
  ["channel", "受付経路 (channel)"],
  ["category", "種別 (category)"],
  ["schedule_kind", "予定の種類 (kind)"],
  ["payment_method", "入金の方法 (method)"],
  ["expense_method", "経費の支払方法"],
  ["role", "社員のロール (role)"],
  ["quality_kind", "クレーム・手直しの種類"],
  ["quality_status", "クレーム・手直しの状態"],
  ["approval_type", "承認の種類"],
  ["approval_status", "承認の状態"],
  ["cash_direction", "現金の入出金"],
  ["document_kind", "取込書類の種類"],
  ["thread_kind", "社内連絡の種類"],
  ["task_status", "業務依頼の状態"],
  ["fax_status", "FAX の状態"],
  ["fax_triage", "受信 FAX の仕分け"],
  ["audit_action", "変更履歴の操作 (action)"],
];

function codeLines(): string[] {
  const rows = labelRows();
  return CODE_KINDS.map(([kind, name]) => `- ${name}: ${rows.filter((r) => r[0] === kind).map((r) => `${r[1]}=${r[2]}`).join(", ")}`);
}

/** AI に渡すデータ辞書 (describe_database で返す。topic で表・ビューを絞れる) */
export function dataModelText(user: Pick<User, "role">, topics: string[] = [], opts: { brief?: boolean } = {}): string {
  const scoped = !canSeeAllStores(user as User);
  const want = topics.map((t) => t.toLowerCase());
  const views = want.length ? VIEWS.filter((v) => want.some((t) => v.name.includes(t) || v.label.includes(t))) : VIEWS;
  // brief: データの質問に先に添える版 (ビューの列・指標の定義・名前の比べ方)。言葉と表・コードの一覧は describe_database で見る
  if (opts.brief) {
    return [
      "# 一畳屋 統合データモデル (要点)",
      "業務の流れ: 問い合わせ → 見積 → 受注・施工 → 請求 → 入金。顧客と予定がすべてにつながる。",
      "## 統合ビュー (名前・日本語の状態つき。結合を組み立てなくてよい)",
      ...views.map((v) => `- ${v.name}: ${v.label}\n  ${v.description}`),
      "## 分析用の表",
      "- sales_orders: 受注 1 件 = 1 行 (キャンセルを除く)。sales_date・contract_date・store_id・store_name・customer_name・total・amt_*・tatami_cost・purchase_cost・staff_names・worker_names・area",
      "- sales_items: 明細 1 行 = 1 行。product・category・qty・unit_price・amount・sales_date・store_id",
      "## 指標の定義 (必ずこの定義で数える)",
      ...METRICS.map((m) => `- ${m.name}: ${m.definition}`),
      "## 注意",
      "- 状態などの列はコード、_label の列が日本語。条件はコードで書く (例: 承認待ちは approvals.status = 'pending'、経費の承認待ちは pending_approval)。コードが分からない・ここにない表や列を使うときだけ describe_database",
      "- 日付は 'YYYY-MM-DD' の文字列、今日は date('now','localtime')。金額は税込。真偽は 0/1",
      "- 人の名前で絞るときは空白を除いて比べる: replace(replace(列, ' ', ''), '　', '') like '%中村花子%'",
    ].join("\n");
  }
  return [
    "# 一畳屋 統合データモデル",
    "業務の流れ: 問い合わせ (inquiries) → 見積 (quotes) → 受注・施工 (orders) → 請求 (invoices) → 入金 (payments)。顧客 (customers) と予定 (schedule_events) がすべてにつながる。",
    "つながり: quotes.inquiry_id → inquiries.id / orders.quote_id → quotes.id / invoices.order_id → orders.id (法人のまとめ請求は 1 枚に複数の受注: invoices.order_ids と orders.invoice_id) / payments.invoice_id → invoices.id / *.customer_id → customers.id / *.store_id → stores.id / schedule_events.order_id → orders.id / purchases.order_id → orders.id / 社員は users.id (JSON の配列 assignee_ids・worker_ids は json_each で展開)",
    scoped ? "※ あなたの閲覧範囲 (自店舗) のデータだけが入っています。ほかの店舗の数字は出せません。" : "",
    "",
    "## まず使う統合ビュー (名前・日本語の状態つき。結合を組み立てなくてよい)",
    ...views.map((v) => `- ${v.name}: ${v.label}\n  ${v.description}`),
    "",
    "## 分析用の表",
    "- sales_orders: 受注 1 件 = 1 行 (キャンセルを除く)。sales_date・contract_date・store_id・store_name・customer_name・total・amt_*・tatami_cost・purchase_cost・staff_names・worker_names・area",
    "- sales_items: 明細 1 行 = 1 行。product・category・qty・unit_price・amount・sales_date・store_id",
    "- order_staff: 受注と担当者",
    "",
    "## 指標の定義 (必ずこの定義で数える)",
    ...METRICS.map((m) => `- ${m.name}: ${m.definition}`),
    "",
    "## 言葉と表",
    ...GLOSSARY.map(([w, t]) => `- ${w} → ${t}`),
    "",
    "## コードと日本語の名前 (状態・受付経路などの列にはコードが入る。_label の列が日本語。条件はコードで書く: 例 status = 'pending_approval')",
    ...codeLines(),
    "- 日付は 'YYYY-MM-DD' の文字列、日時は ISO (UTC)。今日は date('now','localtime')。金額は税込。真偽は 0/1",
    "",
    "## 人の名前の比べ方 (必ず)",
    "- 分析用の表の担当者名 (sales_orders.staff_names・order_staff.staff_name・v_staff_sales.staff_name) は空白なし (例: 中村花子)。ほかの列 (assignees・workers・assigned_staff・users.name) は空白あり (例: 中村 花子)",
    "- 人の名前で絞るときは、両方の空白を除いて比べる: replace(replace(列, ' ', ''), '　', '') like '%中村花子%'。姓だけ (like '%中村%') でもよいが、同じ姓の人に注意",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
