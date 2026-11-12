-- ============================================================
-- 一畳屋 統合業務システム データベース定義 (Supabase / PostgreSQL)
-- 自動生成: node scripts/import/generate-schema.mjs (元: src/lib/db/schema.ts)
-- 何度実行しても安全 (既存のテーブル・データは消さない)
-- ============================================================

begin;

-- アプリ全体のメタ情報 (データ形式のバージョン・更新リビジョン)
create table if not exists app_meta (
  id integer primary key check (id = 1),
  version integer not null default 3,
  revision bigint not null default 0,
  seeded_at timestamptz,
  source text,
  imported_at timestamptz
);
insert into app_meta (id) values (1) on conflict (id) do nothing;
comment on table app_meta is 'アプリ全体のメタ情報 (データ形式のバージョンと、インスタンス間の更新検知用リビジョン)';

-- 店舗
create table if not exists stores (
  id text primary key,
  code text not null,
  name text not null,
  short_name text not null,
  kind text not null check (kind in ('store','hq')),
  postal_code text,
  address text,
  phone text,
  manager_user_id text,
  color text not null
);
comment on table stores is '店舗';

-- 社員 (ログインユーザー)
create table if not exists users (
  id text primary key,
  name text not null,
  kana text not null default '',
  email text not null unique,
  password text check (password is null),
  password_hash text,
  role text not null check (role in ('admin','store_manager','store_staff','hq_staff')),
  store_id text not null references stores(id),
  title text not null default '',
  phone text,
  active boolean not null default true,
  hired_on date
);
comment on table users is '社員 (ログインユーザー)';

-- 顧客
create table if not exists customers (
  id text primary key,
  code text not null unique,
  name text not null,
  kana text not null default '',
  type text not null check (type in ('individual','corporate')),
  phone text not null default '',
  email text,
  line_id text,
  postal_code text not null default '',
  address text not null default '',
  area text,
  store_id text not null references stores(id),
  assigned_user_id text references users(id) on delete set null,
  preferred_channel text not null,
  first_contact_channel text not null,
  tags text[] not null default '{}',
  notes text not null default '',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table customers is '顧客';
create index if not exists customers_store_id_idx on customers (store_id);
create index if not exists customers_name_idx on customers (name);
create index if not exists customers_area_idx on customers (area);

-- 問い合わせ
create table if not exists inquiries (
  id text primary key,
  number text not null unique,
  customer_id text references customers(id) on delete set null,
  contact_name text not null,
  contact_phone text,
  channel text not null,
  store_id text not null references stores(id),
  category text not null,
  summary text not null,
  detail text not null default '',
  status text not null,
  assigned_user_id text references users(id) on delete set null,
  received_at timestamptz not null,
  next_action text,
  next_action_due date,
  quote_id text,
  created_by text not null,
  updated_at timestamptz not null,
  area text,
  result text,
  source text,
  source_ref text
);
comment on table inquiries is '問い合わせ';
create index if not exists inquiries_store_id_idx on inquiries (store_id);
create index if not exists inquiries_status_idx on inquiries (status);
create index if not exists inquiries_customer_id_idx on inquiries (customer_id);

-- 商品マスタ
create table if not exists products (
  id text primary key,
  category text not null,
  name text not null,
  grade text,
  unit text not null,
  unit_price numeric not null,
  size_label text,
  description text,
  active boolean not null default true
);
comment on table products is '商品マスタ';

-- 見積
create table if not exists quotes (
  id text primary key,
  number text not null unique,
  version integer not null default 1,
  customer_id text not null references customers(id),
  inquiry_id text references inquiries(id) on delete set null,
  store_id text not null references stores(id),
  title text not null,
  category text not null,
  items jsonb not null default '[]',
  subtotal numeric not null,
  discount numeric not null default 0,
  tax numeric not null,
  total numeric not null,
  status text not null,
  valid_until date,
  issued_at text,
  sent_via text,
  created_by text not null,
  approved_by text,
  approved_at timestamptz,
  notes text,
  source text not null default 'manual',
  document_id text,
  order_id text,
  pending_change jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table quotes is '見積';
create index if not exists quotes_store_id_idx on quotes (store_id);
create index if not exists quotes_status_idx on quotes (status);
create index if not exists quotes_customer_id_idx on quotes (customer_id);

-- 受注・施工 (売上)
create table if not exists orders (
  id text primary key,
  number text not null unique,
  quote_id text references quotes(id) on delete set null,
  customer_id text not null references customers(id),
  store_id text not null references stores(id),
  title text not null,
  category text not null,
  contract_date date not null,
  total numeric not null,
  status text not null,
  scheduled_start date,
  scheduled_end date,
  worker_ids text[] not null default '{}',
  site_address text not null default '',
  completed_at date,
  sales_date date,
  progress_notes jsonb not null default '[]',
  created_by text not null,
  approved_by text,
  invoice_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  postcard_no text,
  amounts jsonb,
  tatami_cost numeric,
  fusuma_paper text,
  source text,
  source_ref text
);
comment on table orders is '受注・施工 (売上)';
create index if not exists orders_store_id_idx on orders (store_id);
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_customer_id_idx on orders (customer_id);
create index if not exists orders_sales_date_idx on orders (sales_date);

-- 請求書
create table if not exists invoices (
  id text primary key,
  number text not null unique,
  order_id text not null references orders(id),
  customer_id text not null references customers(id),
  store_id text not null references stores(id),
  issue_date date not null,
  due_date date not null,
  subtotal numeric not null,
  tax numeric not null,
  total numeric not null,
  paid_amount numeric not null default 0,
  status text not null,
  sent_via text,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table invoices is '請求書';
create index if not exists invoices_store_id_idx on invoices (store_id);
create index if not exists invoices_status_idx on invoices (status);

-- 入金
create table if not exists payments (
  id text primary key,
  invoice_id text not null references invoices(id),
  date date not null,
  amount numeric not null,
  method text not null,
  memo text,
  recorded_by text not null,
  created_at timestamptz not null
);
comment on table payments is '入金';

-- 仕入先
create table if not exists suppliers (
  id text primary key,
  name text not null,
  category text not null default '',
  phone text,
  email text,
  payment_terms text not null default '',
  closing_day integer not null default 31
);
comment on table suppliers is '仕入先';

-- 仕入請求書 (買掛)
create table if not exists purchases (
  id text primary key,
  number text not null unique,
  supplier_id text not null references suppliers(id),
  store_id text not null references stores(id),
  invoice_date date not null,
  due_date date not null,
  amount numeric not null,
  tax_amount numeric not null default 0,
  description text not null default '',
  status text not null,
  source text not null default 'manual',
  document_id text,
  registered_by text not null,
  approved_by text,
  paid_at text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table purchases is '仕入請求書 (買掛)';

-- 経費
create table if not exists expenses (
  id text primary key,
  number text not null unique,
  store_id text not null references stores(id),
  submitted_by text not null,
  date date not null,
  vendor text not null default '',
  amount numeric not null,
  tax_amount numeric not null default 0,
  account text not null,
  payment_method text not null,
  description text not null default '',
  status text not null,
  source text not null default 'manual',
  document_id text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table expenses is '経費';
create index if not exists expenses_store_id_idx on expenses (store_id);
create index if not exists expenses_status_idx on expenses (status);

-- 承認
create table if not exists approvals (
  id text primary key,
  type text not null,
  target_id text not null,
  title text not null,
  amount numeric not null default 0,
  store_id text not null references stores(id),
  requested_by text not null,
  required_role text not null,
  status text not null,
  request_comment text,
  decided_by text,
  decided_at timestamptz,
  decision_comment text,
  created_at timestamptz not null
);
comment on table approvals is '承認';
create index if not exists approvals_status_idx on approvals (status);
create index if not exists approvals_target_id_idx on approvals (target_id);

-- 変更履歴 (監査ログ)
create table if not exists audit_logs (
  id text primary key,
  at timestamptz not null,
  user_id text not null,
  action text not null,
  entity text not null,
  entity_id text not null,
  entity_label text not null default '',
  summary text not null default '',
  changes jsonb,
  store_id text
);
comment on table audit_logs is '変更履歴 (監査ログ)';
create index if not exists audit_logs_entity_entity_id_idx on audit_logs (entity, entity_id);
create index if not exists audit_logs_at_idx on audit_logs (at);

-- 外部とのやりとり履歴
create table if not exists comm_logs (
  id text primary key,
  customer_id text not null references customers(id),
  channel text not null,
  direction text not null,
  subject text not null default '',
  body text not null default '',
  at timestamptz not null,
  user_id text not null,
  related_type text,
  related_id text
);
comment on table comm_logs is '外部とのやりとり履歴';
create index if not exists comm_logs_customer_id_idx on comm_logs (customer_id);

-- 社内連絡 (スレッド)
create table if not exists threads (
  id text primary key,
  title text not null,
  kind text not null,
  store_id text,
  created_by text not null,
  participants text[] not null default '{}',
  related_type text,
  related_id text,
  related_label text,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table threads is '社内連絡 (スレッド)';

-- 社内連絡 (投稿)
create table if not exists messages (
  id text primary key,
  thread_id text not null references threads(id) on delete cascade,
  user_id text not null,
  body text not null,
  at timestamptz not null,
  mentions text[] not null default '{}'
);
comment on table messages is '社内連絡 (投稿)';
create index if not exists messages_thread_id_idx on messages (thread_id);

-- 取込書類 (紙→データ)
create table if not exists documents (
  id text primary key,
  kind text not null,
  file_name text not null,
  uploaded_by text not null,
  store_id text not null references stores(id),
  uploaded_at timestamptz not null,
  status text not null,
  extracted jsonb,
  confidence numeric,
  linked_type text,
  linked_id text
);
comment on table documents is '取込書類 (紙→データ)';

-- 予定 (全社カレンダー)
create table if not exists schedule_events (
  id text primary key,
  title text not null,
  kind text not null,
  date date not null,
  end_date date,
  start_time text,
  end_time text,
  slot text check (slot in ('am','pm')),
  store_id text not null references stores(id),
  company_wide boolean,
  assignee_ids text[] not null default '{}',
  customer_id text references customers(id) on delete set null,
  inquiry_id text references inquiries(id) on delete set null,
  quote_id text references quotes(id) on delete set null,
  order_id text references orders(id) on delete set null,
  source text,
  series_id text,
  location text,
  memo text,
  created_by text,
  created_at timestamptz,
  updated_by text,
  updated_at timestamptz,
  source_ref text
);
comment on table schedule_events is '予定 (全社カレンダー)';
create index if not exists schedule_events_date_idx on schedule_events (date);
create index if not exists schedule_events_store_id_date_idx on schedule_events (store_id, date);
create index if not exists schedule_events_order_id_idx on schedule_events (order_id);
create index if not exists schedule_events_customer_id_idx on schedule_events (customer_id);

-- 会社の休業日
create table if not exists company_holidays (
  id text primary key,
  date date not null unique,
  label text not null default '休業日'
);
comment on table company_holidays is '会社の休業日';

-- お客様アンケート
create table if not exists survey_responses (
  id text primary key,
  received_at timestamptz not null,
  postcard_no text,
  store_id text not null references stores(id),
  order_id text references orders(id) on delete set null,
  customer_id text references customers(id) on delete set null,
  phone_score numeric,
  sales_name text,
  sales_user_id text,
  sales_score numeric,
  craftsman_name text,
  craftsman_user_id text,
  craftsman_score numeric,
  finish_score numeric,
  priorities text,
  media text,
  would_use_again text,
  source_ref text
);
comment on table survey_responses is 'お客様アンケート';
create index if not exists survey_responses_store_id_idx on survey_responses (store_id);

-- 資料台帳 (Google ドライブの共有資料)
create table if not exists source_files (
  id text primary key,
  folder text not null,
  folder_name text not null,
  path text not null,
  name text not null,
  ext text not null default '',
  kind text not null,
  bytes bigint,
  modified_on date,
  drive_url text,
  status text not null,
  imported_to text
);
comment on table source_files is '資料台帳 (Google ドライブの共有資料)';
create index if not exists source_files_folder_idx on source_files (folder);

-- 現場写真台帳
create table if not exists photo_albums (
  id text primary key,
  title text not null,
  date date,
  area text,
  customer_name text,
  customer_id text references customers(id) on delete set null,
  store_id text not null references stores(id),
  photo_count integer not null default 0,
  drive_url text,
  sample_files text[] not null default '{}'
);
comment on table photo_albums is '現場写真台帳';

-- 既存のテーブルに後から追加した列 (schema.ts に列を足したとき、作成済みのテーブルへ反映する)
-- 注意: not null で既定値のない列を、行があるテーブルへ追加すると失敗する。その場合は既定値を付けるか、手動で移行する
alter table stores add column if not exists code text not null;
alter table stores add column if not exists name text not null;
alter table stores add column if not exists short_name text not null;
alter table stores add column if not exists kind text not null check (kind in ('store','hq'));
alter table stores add column if not exists postal_code text;
alter table stores add column if not exists address text;
alter table stores add column if not exists phone text;
alter table stores add column if not exists manager_user_id text;
alter table stores add column if not exists color text not null;
alter table users add column if not exists name text not null;
alter table users add column if not exists kana text not null default '';
alter table users add column if not exists email text not null unique;
alter table users add column if not exists password text check (password is null);
alter table users add column if not exists password_hash text;
alter table users add column if not exists role text not null check (role in ('admin','store_manager','store_staff','hq_staff'));
alter table users add column if not exists store_id text not null references stores(id);
alter table users add column if not exists title text not null default '';
alter table users add column if not exists phone text;
alter table users add column if not exists active boolean not null default true;
alter table users add column if not exists hired_on date;
alter table customers add column if not exists code text not null unique;
alter table customers add column if not exists name text not null;
alter table customers add column if not exists kana text not null default '';
alter table customers add column if not exists type text not null check (type in ('individual','corporate'));
alter table customers add column if not exists phone text not null default '';
alter table customers add column if not exists email text;
alter table customers add column if not exists line_id text;
alter table customers add column if not exists postal_code text not null default '';
alter table customers add column if not exists address text not null default '';
alter table customers add column if not exists area text;
alter table customers add column if not exists store_id text not null references stores(id);
alter table customers add column if not exists assigned_user_id text references users(id) on delete set null;
alter table customers add column if not exists preferred_channel text not null;
alter table customers add column if not exists first_contact_channel text not null;
alter table customers add column if not exists tags text[] not null default '{}';
alter table customers add column if not exists notes text not null default '';
alter table customers add column if not exists created_at timestamptz not null;
alter table customers add column if not exists updated_at timestamptz not null;
alter table inquiries add column if not exists number text not null unique;
alter table inquiries add column if not exists customer_id text references customers(id) on delete set null;
alter table inquiries add column if not exists contact_name text not null;
alter table inquiries add column if not exists contact_phone text;
alter table inquiries add column if not exists channel text not null;
alter table inquiries add column if not exists store_id text not null references stores(id);
alter table inquiries add column if not exists category text not null;
alter table inquiries add column if not exists summary text not null;
alter table inquiries add column if not exists detail text not null default '';
alter table inquiries add column if not exists status text not null;
alter table inquiries add column if not exists assigned_user_id text references users(id) on delete set null;
alter table inquiries add column if not exists received_at timestamptz not null;
alter table inquiries add column if not exists next_action text;
alter table inquiries add column if not exists next_action_due date;
alter table inquiries add column if not exists quote_id text;
alter table inquiries add column if not exists created_by text not null;
alter table inquiries add column if not exists updated_at timestamptz not null;
alter table inquiries add column if not exists area text;
alter table inquiries add column if not exists result text;
alter table inquiries add column if not exists source text;
alter table inquiries add column if not exists source_ref text;
alter table products add column if not exists category text not null;
alter table products add column if not exists name text not null;
alter table products add column if not exists grade text;
alter table products add column if not exists unit text not null;
alter table products add column if not exists unit_price numeric not null;
alter table products add column if not exists size_label text;
alter table products add column if not exists description text;
alter table products add column if not exists active boolean not null default true;
alter table quotes add column if not exists number text not null unique;
alter table quotes add column if not exists version integer not null default 1;
alter table quotes add column if not exists customer_id text not null references customers(id);
alter table quotes add column if not exists inquiry_id text references inquiries(id) on delete set null;
alter table quotes add column if not exists store_id text not null references stores(id);
alter table quotes add column if not exists title text not null;
alter table quotes add column if not exists category text not null;
alter table quotes add column if not exists items jsonb not null default '[]';
alter table quotes add column if not exists subtotal numeric not null;
alter table quotes add column if not exists discount numeric not null default 0;
alter table quotes add column if not exists tax numeric not null;
alter table quotes add column if not exists total numeric not null;
alter table quotes add column if not exists status text not null;
alter table quotes add column if not exists valid_until date;
alter table quotes add column if not exists issued_at text;
alter table quotes add column if not exists sent_via text;
alter table quotes add column if not exists created_by text not null;
alter table quotes add column if not exists approved_by text;
alter table quotes add column if not exists approved_at timestamptz;
alter table quotes add column if not exists notes text;
alter table quotes add column if not exists source text not null default 'manual';
alter table quotes add column if not exists document_id text;
alter table quotes add column if not exists order_id text;
alter table quotes add column if not exists pending_change jsonb;
alter table quotes add column if not exists created_at timestamptz not null;
alter table quotes add column if not exists updated_at timestamptz not null;
alter table orders add column if not exists number text not null unique;
alter table orders add column if not exists quote_id text references quotes(id) on delete set null;
alter table orders add column if not exists customer_id text not null references customers(id);
alter table orders add column if not exists store_id text not null references stores(id);
alter table orders add column if not exists title text not null;
alter table orders add column if not exists category text not null;
alter table orders add column if not exists contract_date date not null;
alter table orders add column if not exists total numeric not null;
alter table orders add column if not exists status text not null;
alter table orders add column if not exists scheduled_start date;
alter table orders add column if not exists scheduled_end date;
alter table orders add column if not exists worker_ids text[] not null default '{}';
alter table orders add column if not exists site_address text not null default '';
alter table orders add column if not exists completed_at date;
alter table orders add column if not exists sales_date date;
alter table orders add column if not exists progress_notes jsonb not null default '[]';
alter table orders add column if not exists created_by text not null;
alter table orders add column if not exists approved_by text;
alter table orders add column if not exists invoice_id text;
alter table orders add column if not exists created_at timestamptz not null;
alter table orders add column if not exists updated_at timestamptz not null;
alter table orders add column if not exists postcard_no text;
alter table orders add column if not exists amounts jsonb;
alter table orders add column if not exists tatami_cost numeric;
alter table orders add column if not exists fusuma_paper text;
alter table orders add column if not exists source text;
alter table orders add column if not exists source_ref text;
alter table invoices add column if not exists number text not null unique;
alter table invoices add column if not exists order_id text not null references orders(id);
alter table invoices add column if not exists customer_id text not null references customers(id);
alter table invoices add column if not exists store_id text not null references stores(id);
alter table invoices add column if not exists issue_date date not null;
alter table invoices add column if not exists due_date date not null;
alter table invoices add column if not exists subtotal numeric not null;
alter table invoices add column if not exists tax numeric not null;
alter table invoices add column if not exists total numeric not null;
alter table invoices add column if not exists paid_amount numeric not null default 0;
alter table invoices add column if not exists status text not null;
alter table invoices add column if not exists sent_via text;
alter table invoices add column if not exists created_by text not null;
alter table invoices add column if not exists created_at timestamptz not null;
alter table invoices add column if not exists updated_at timestamptz not null;
alter table payments add column if not exists invoice_id text not null references invoices(id);
alter table payments add column if not exists date date not null;
alter table payments add column if not exists amount numeric not null;
alter table payments add column if not exists method text not null;
alter table payments add column if not exists memo text;
alter table payments add column if not exists recorded_by text not null;
alter table payments add column if not exists created_at timestamptz not null;
alter table suppliers add column if not exists name text not null;
alter table suppliers add column if not exists category text not null default '';
alter table suppliers add column if not exists phone text;
alter table suppliers add column if not exists email text;
alter table suppliers add column if not exists payment_terms text not null default '';
alter table suppliers add column if not exists closing_day integer not null default 31;
alter table purchases add column if not exists number text not null unique;
alter table purchases add column if not exists supplier_id text not null references suppliers(id);
alter table purchases add column if not exists store_id text not null references stores(id);
alter table purchases add column if not exists invoice_date date not null;
alter table purchases add column if not exists due_date date not null;
alter table purchases add column if not exists amount numeric not null;
alter table purchases add column if not exists tax_amount numeric not null default 0;
alter table purchases add column if not exists description text not null default '';
alter table purchases add column if not exists status text not null;
alter table purchases add column if not exists source text not null default 'manual';
alter table purchases add column if not exists document_id text;
alter table purchases add column if not exists registered_by text not null;
alter table purchases add column if not exists approved_by text;
alter table purchases add column if not exists paid_at text;
alter table purchases add column if not exists created_at timestamptz not null;
alter table purchases add column if not exists updated_at timestamptz not null;
alter table expenses add column if not exists number text not null unique;
alter table expenses add column if not exists store_id text not null references stores(id);
alter table expenses add column if not exists submitted_by text not null;
alter table expenses add column if not exists date date not null;
alter table expenses add column if not exists vendor text not null default '';
alter table expenses add column if not exists amount numeric not null;
alter table expenses add column if not exists tax_amount numeric not null default 0;
alter table expenses add column if not exists account text not null;
alter table expenses add column if not exists payment_method text not null;
alter table expenses add column if not exists description text not null default '';
alter table expenses add column if not exists status text not null;
alter table expenses add column if not exists source text not null default 'manual';
alter table expenses add column if not exists document_id text;
alter table expenses add column if not exists approved_by text;
alter table expenses add column if not exists approved_at timestamptz;
alter table expenses add column if not exists created_at timestamptz not null;
alter table expenses add column if not exists updated_at timestamptz not null;
alter table approvals add column if not exists type text not null;
alter table approvals add column if not exists target_id text not null;
alter table approvals add column if not exists title text not null;
alter table approvals add column if not exists amount numeric not null default 0;
alter table approvals add column if not exists store_id text not null references stores(id);
alter table approvals add column if not exists requested_by text not null;
alter table approvals add column if not exists required_role text not null;
alter table approvals add column if not exists status text not null;
alter table approvals add column if not exists request_comment text;
alter table approvals add column if not exists decided_by text;
alter table approvals add column if not exists decided_at timestamptz;
alter table approvals add column if not exists decision_comment text;
alter table approvals add column if not exists created_at timestamptz not null;
alter table audit_logs add column if not exists at timestamptz not null;
alter table audit_logs add column if not exists user_id text not null;
alter table audit_logs add column if not exists action text not null;
alter table audit_logs add column if not exists entity text not null;
alter table audit_logs add column if not exists entity_id text not null;
alter table audit_logs add column if not exists entity_label text not null default '';
alter table audit_logs add column if not exists summary text not null default '';
alter table audit_logs add column if not exists changes jsonb;
alter table audit_logs add column if not exists store_id text;
alter table comm_logs add column if not exists customer_id text not null references customers(id);
alter table comm_logs add column if not exists channel text not null;
alter table comm_logs add column if not exists direction text not null;
alter table comm_logs add column if not exists subject text not null default '';
alter table comm_logs add column if not exists body text not null default '';
alter table comm_logs add column if not exists at timestamptz not null;
alter table comm_logs add column if not exists user_id text not null;
alter table comm_logs add column if not exists related_type text;
alter table comm_logs add column if not exists related_id text;
alter table threads add column if not exists title text not null;
alter table threads add column if not exists kind text not null;
alter table threads add column if not exists store_id text;
alter table threads add column if not exists created_by text not null;
alter table threads add column if not exists participants text[] not null default '{}';
alter table threads add column if not exists related_type text;
alter table threads add column if not exists related_id text;
alter table threads add column if not exists related_label text;
alter table threads add column if not exists status text not null;
alter table threads add column if not exists created_at timestamptz not null;
alter table threads add column if not exists updated_at timestamptz not null;
alter table messages add column if not exists thread_id text not null references threads(id) on delete cascade;
alter table messages add column if not exists user_id text not null;
alter table messages add column if not exists body text not null;
alter table messages add column if not exists at timestamptz not null;
alter table messages add column if not exists mentions text[] not null default '{}';
alter table documents add column if not exists kind text not null;
alter table documents add column if not exists file_name text not null;
alter table documents add column if not exists uploaded_by text not null;
alter table documents add column if not exists store_id text not null references stores(id);
alter table documents add column if not exists uploaded_at timestamptz not null;
alter table documents add column if not exists status text not null;
alter table documents add column if not exists extracted jsonb;
alter table documents add column if not exists confidence numeric;
alter table documents add column if not exists linked_type text;
alter table documents add column if not exists linked_id text;
alter table schedule_events add column if not exists title text not null;
alter table schedule_events add column if not exists kind text not null;
alter table schedule_events add column if not exists date date not null;
alter table schedule_events add column if not exists end_date date;
alter table schedule_events add column if not exists start_time text;
alter table schedule_events add column if not exists end_time text;
alter table schedule_events add column if not exists slot text check (slot in ('am','pm'));
alter table schedule_events add column if not exists store_id text not null references stores(id);
alter table schedule_events add column if not exists company_wide boolean;
alter table schedule_events add column if not exists assignee_ids text[] not null default '{}';
alter table schedule_events add column if not exists customer_id text references customers(id) on delete set null;
alter table schedule_events add column if not exists inquiry_id text references inquiries(id) on delete set null;
alter table schedule_events add column if not exists quote_id text references quotes(id) on delete set null;
alter table schedule_events add column if not exists order_id text references orders(id) on delete set null;
alter table schedule_events add column if not exists source text;
alter table schedule_events add column if not exists series_id text;
alter table schedule_events add column if not exists location text;
alter table schedule_events add column if not exists memo text;
alter table schedule_events add column if not exists created_by text;
alter table schedule_events add column if not exists created_at timestamptz;
alter table schedule_events add column if not exists updated_by text;
alter table schedule_events add column if not exists updated_at timestamptz;
alter table schedule_events add column if not exists source_ref text;
alter table company_holidays add column if not exists date date not null unique;
alter table company_holidays add column if not exists label text not null default '休業日';
alter table survey_responses add column if not exists received_at timestamptz not null;
alter table survey_responses add column if not exists postcard_no text;
alter table survey_responses add column if not exists store_id text not null references stores(id);
alter table survey_responses add column if not exists order_id text references orders(id) on delete set null;
alter table survey_responses add column if not exists customer_id text references customers(id) on delete set null;
alter table survey_responses add column if not exists phone_score numeric;
alter table survey_responses add column if not exists sales_name text;
alter table survey_responses add column if not exists sales_user_id text;
alter table survey_responses add column if not exists sales_score numeric;
alter table survey_responses add column if not exists craftsman_name text;
alter table survey_responses add column if not exists craftsman_user_id text;
alter table survey_responses add column if not exists craftsman_score numeric;
alter table survey_responses add column if not exists finish_score numeric;
alter table survey_responses add column if not exists priorities text;
alter table survey_responses add column if not exists media text;
alter table survey_responses add column if not exists would_use_again text;
alter table survey_responses add column if not exists source_ref text;
alter table source_files add column if not exists folder text not null;
alter table source_files add column if not exists folder_name text not null;
alter table source_files add column if not exists path text not null;
alter table source_files add column if not exists name text not null;
alter table source_files add column if not exists ext text not null default '';
alter table source_files add column if not exists kind text not null;
alter table source_files add column if not exists bytes bigint;
alter table source_files add column if not exists modified_on date;
alter table source_files add column if not exists drive_url text;
alter table source_files add column if not exists status text not null;
alter table source_files add column if not exists imported_to text;
alter table photo_albums add column if not exists title text not null;
alter table photo_albums add column if not exists date date;
alter table photo_albums add column if not exists area text;
alter table photo_albums add column if not exists customer_name text;
alter table photo_albums add column if not exists customer_id text references customers(id) on delete set null;
alter table photo_albums add column if not exists store_id text not null references stores(id);
alter table photo_albums add column if not exists photo_count integer not null default 0;
alter table photo_albums add column if not exists drive_url text;
alter table photo_albums add column if not exists sample_files text[] not null default '{}';

-- 行レベルセキュリティ: 有効化のみ (ポリシーなし)。publishable / anon キーからはアクセスできない
-- アプリが使う secret キー (service_role) には読み書きの権限を明示的に付ける (プロジェクトの既定の権限に頼らない)
grant usage on schema public to service_role;
alter table app_meta enable row level security;
revoke all on table app_meta from anon, authenticated;
grant select, insert, update, delete on table app_meta to service_role;
alter table stores enable row level security;
revoke all on table stores from anon, authenticated;
grant select, insert, update, delete on table stores to service_role;
alter table users enable row level security;
revoke all on table users from anon, authenticated;
grant select, insert, update, delete on table users to service_role;
alter table customers enable row level security;
revoke all on table customers from anon, authenticated;
grant select, insert, update, delete on table customers to service_role;
alter table inquiries enable row level security;
revoke all on table inquiries from anon, authenticated;
grant select, insert, update, delete on table inquiries to service_role;
alter table products enable row level security;
revoke all on table products from anon, authenticated;
grant select, insert, update, delete on table products to service_role;
alter table quotes enable row level security;
revoke all on table quotes from anon, authenticated;
grant select, insert, update, delete on table quotes to service_role;
alter table orders enable row level security;
revoke all on table orders from anon, authenticated;
grant select, insert, update, delete on table orders to service_role;
alter table invoices enable row level security;
revoke all on table invoices from anon, authenticated;
grant select, insert, update, delete on table invoices to service_role;
alter table payments enable row level security;
revoke all on table payments from anon, authenticated;
grant select, insert, update, delete on table payments to service_role;
alter table suppliers enable row level security;
revoke all on table suppliers from anon, authenticated;
grant select, insert, update, delete on table suppliers to service_role;
alter table purchases enable row level security;
revoke all on table purchases from anon, authenticated;
grant select, insert, update, delete on table purchases to service_role;
alter table expenses enable row level security;
revoke all on table expenses from anon, authenticated;
grant select, insert, update, delete on table expenses to service_role;
alter table approvals enable row level security;
revoke all on table approvals from anon, authenticated;
grant select, insert, update, delete on table approvals to service_role;
alter table audit_logs enable row level security;
revoke all on table audit_logs from anon, authenticated;
grant select, insert, update, delete on table audit_logs to service_role;
alter table comm_logs enable row level security;
revoke all on table comm_logs from anon, authenticated;
grant select, insert, update, delete on table comm_logs to service_role;
alter table threads enable row level security;
revoke all on table threads from anon, authenticated;
grant select, insert, update, delete on table threads to service_role;
alter table messages enable row level security;
revoke all on table messages from anon, authenticated;
grant select, insert, update, delete on table messages to service_role;
alter table documents enable row level security;
revoke all on table documents from anon, authenticated;
grant select, insert, update, delete on table documents to service_role;
alter table schedule_events enable row level security;
revoke all on table schedule_events from anon, authenticated;
grant select, insert, update, delete on table schedule_events to service_role;
alter table company_holidays enable row level security;
revoke all on table company_holidays from anon, authenticated;
grant select, insert, update, delete on table company_holidays to service_role;
alter table survey_responses enable row level security;
revoke all on table survey_responses from anon, authenticated;
grant select, insert, update, delete on table survey_responses to service_role;
alter table source_files enable row level security;
revoke all on table source_files from anon, authenticated;
grant select, insert, update, delete on table source_files to service_role;
alter table photo_albums enable row level security;
revoke all on table photo_albums from anon, authenticated;
grant select, insert, update, delete on table photo_albums to service_role;

-- 書き込みのたびにリビジョンを +1 (他のサーバーインスタンスが変更を検知して読み直す)
create or replace function public.bump_revision() returns bigint
language sql security definer set search_path = public as $$
  update app_meta set revision = revision + 1 where id = 1 returning revision;
$$;
revoke all on function public.bump_revision() from public, anon, authenticated;
grant execute on function public.bump_revision() to service_role;

commit;

-- API (PostgREST) に新しいテーブル・列を知らせる
notify pgrst, 'reload schema';
