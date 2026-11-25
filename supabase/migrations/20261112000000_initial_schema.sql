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

-- 変更の記録 (リビジョンごとに変わった行の ID。他のインスタンスが全件を読み直さず、変わった行だけを取り直す)
create table if not exists app_changes (
  revision bigint primary key,
  changes jsonb not null,
  at timestamptz not null default now()
);
comment on table app_changes is '変更の記録 (リビジョンごとの表と行の ID。中身は持たない。新しい 5,000 件を残す)';

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
  color text not null,
  opened_on date,
  closed_on date,
  merged_into text
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
  hired_on date,
  notify_email text,
  notify_by_email boolean,
  chatwork_account_id text,
  avatar_key text,
  avatar_updated_at timestamptz,
  signup_status text check (signup_status in ('pending')),
  signup_requested_at timestamptz,
  signup_note text
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
  updated_at timestamptz not null,
  contacts jsonb,
  trade_stopped boolean,
  trade_stop_note text,
  billing_terms jsonb
);
comment on table customers is '顧客';

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
  source_ref text,
  media text,
  promotion_id text,
  intake jsonb,
  schedule_hold jsonb,
  site_address text
);
comment on table inquiries is '問い合わせ';

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
  active boolean not null default true,
  mgmt_category text
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
  updated_at timestamptz not null,
  work_details text,
  revisions jsonb,
  tax_included boolean,
  tax_exempt boolean,
  site_info jsonb,
  paper_no text,
  handed_over boolean,
  spec_status text,
  estimator_id text,
  site_address text,
  receipt_name text,
  tatami_rooms jsonb
);
comment on table quotes is '見積';

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
  source_ref text,
  work_details text,
  site_info jsonb,
  spec_status text,
  spec_note text,
  schedule_status text,
  billing text,
  planned_payment text,
  closed_at timestamptz,
  closed_by text,
  receipt_name text,
  handovers jsonb,
  tatami_rooms jsonb,
  work_staff jsonb
);
comment on table orders is '受注・施工 (売上)';

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
  updated_at timestamptz not null,
  title text,
  items jsonb,
  tax_included boolean,
  tax_exempt boolean,
  notes text,
  expected_date date,
  expected_amount numeric,
  expected_note text,
  order_ids text[],
  period_from date,
  period_to date,
  order_lines jsonb
);
comment on table invoices is '請求書';

-- 入金
create table if not exists payments (
  id text primary key,
  invoice_id text not null references invoices(id),
  date date not null,
  amount numeric not null,
  method text not null,
  memo text,
  settled_on date,
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
  closing_day integer not null default 31,
  kind text,
  kana text,
  contact_name text,
  postal_code text,
  address text,
  fax text,
  pay_month_offset integer,
  pay_day integer,
  bank_info text,
  registration_number text,
  line_id text,
  chatwork_room_id text,
  notes text,
  active boolean,
  created_at timestamptz,
  updated_at timestamptz,
  pay_method text
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
  updated_at timestamptz not null,
  items jsonb,
  account text,
  order_id text,
  supplier_invoice_no text,
  scheduled_pay_date date,
  pay_method text,
  pay_reference text,
  paid_by text
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
  updated_at timestamptz not null,
  paid_at date,
  paid_by text
);
comment on table expenses is '経費';

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
  created_at timestamptz not null,
  changes jsonb
);
comment on table approvals is '承認';

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

-- 外部とのやりとり履歴 (お客様・協力業者・仕入先)
create table if not exists comm_logs (
  id text primary key,
  customer_id text references customers(id),
  channel text not null,
  direction text not null,
  subject text not null default '',
  body text not null default '',
  at timestamptz not null,
  user_id text not null,
  related_type text,
  related_id text,
  supplier_id text,
  store_id text,
  contact_name text,
  delivery_id text
);
comment on table comm_logs is '外部とのやりとり履歴 (お客様・協力業者・仕入先)';

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
  updated_at timestamptz not null,
  assignee_ids text[],
  due_date date,
  task_status text,
  acknowledged_at timestamptz,
  reported_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by text,
  due_at timestamptz,
  assignee_store_id text,
  purpose text,
  reminded_at timestamptz,
  remind_count integer
);
comment on table threads is '社内連絡 (スレッド)';

-- 社内連絡 (投稿)
create table if not exists messages (
  id text primary key,
  thread_id text not null references threads(id) on delete cascade,
  user_id text not null,
  body text not null,
  at timestamptz not null,
  mentions text[] not null default '{}',
  event text
);
comment on table messages is '社内連絡 (投稿)';

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
  source_ref text,
  work text
);
comment on table schedule_events is '予定 (全社カレンダー)';

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
  source_ref text,
  answered_on date,
  count_month text,
  clerk_user_id text,
  delivery_user_ids jsonb,
  priority_list jsonb,
  media_list jsonb,
  comment text,
  comment_tags jsonb,
  comment_tone text,
  document_id text,
  source text,
  created_by text,
  created_at timestamptz,
  updated_at timestamptz
);
comment on table survey_responses is 'お客様アンケート';

-- クレーム・手直し
create table if not exists quality_issues (
  id text primary key,
  number text not null,
  order_id text references orders(id) on delete cascade,
  customer_id text,
  store_id text not null references stores(id),
  kind text not null,
  points numeric not null,
  occurred_on date not null,
  responsible_user_ids jsonb not null default '[]'::jsonb,
  description text not null,
  cause text,
  countermeasure text,
  status text not null,
  resolved_on date,
  attribution text,
  category text,
  counted boolean,
  site_name text,
  origin text,
  source_ref text,
  reported_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table quality_issues is 'クレーム・手直し';

-- Google 口コミ
create table if not exists google_reviews (
  id text primary key,
  posted_on date not null,
  store_id text not null references stores(id),
  user_id text not null,
  reviewer_name text,
  rating numeric,
  comment text,
  has_photo boolean,
  points numeric not null,
  order_id text references orders(id) on delete set null,
  customer_id text,
  note text,
  source_ref text,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table google_reviews is 'Google 口コミ';

-- アンケートの過去の集計 (H26〜R4)
create table if not exists survey_history (
  id text primary key,
  fiscal_label text not null,
  start_year integer not null,
  period text not null,
  store_id text references stores(id),
  question text not null,
  answer text not null default '',
  count numeric not null,
  source_ref text not null,
  imported_at timestamptz not null
);
comment on table survey_history is 'アンケートの過去の集計 (H26〜R4)';

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

-- 設定 (帳票の会社情報・登録番号・振込先など)
create table if not exists settings (
  id text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table settings is '設定 (帳票の会社情報・登録番号・振込先など)';

-- 添付ファイル (資料・写真。本体は VPS のディスク。ここにはパスだけ)
create table if not exists attachments (
  id text primary key,
  parent_type text not null check (parent_type in ('customer','inquiry','quote','order','expense','purchase','document')),
  parent_id text not null,
  customer_id text references customers(id) on delete set null,
  store_id text not null references stores(id),
  kind text not null check (kind in ('photo','file')),
  file_name text not null,
  content_type text not null,
  size integer not null default 0,
  storage_key text not null,
  thumb_key text,
  width integer,
  height integer,
  caption text,
  taken_at timestamptz,
  uploaded_by text not null references users(id),
  uploaded_at timestamptz not null
);
comment on table attachments is '添付ファイル (資料・写真。本体は VPS のディスク。ここにはパスだけ)';

-- 現金出納 (店舗の手元現金の入出金)
create table if not exists cash_entries (
  id text primary key,
  number text not null unique,
  store_id text not null references stores(id),
  date date not null,
  direction text not null check (direction in ('in','out')),
  amount numeric not null check (amount > 0),
  account text not null,
  counterparty text,
  description text not null default '',
  source text not null default 'manual',
  source_id text,
  recorded_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table cash_entries is '現金出納 (店舗の手元現金の入出金)';

-- 送信履歴 (メール・LINE・Chatwork)
create table if not exists deliveries (
  id text primary key,
  channel text not null check (channel in ('email','line','chatwork')),
  recipient text not null,
  recipient_label text,
  subject text,
  body text not null default '',
  attachments jsonb,
  status text not null check (status in ('sent','failed','skipped')),
  error text,
  purpose text not null,
  related_type text,
  related_id text,
  user_id text not null,
  created_at timestamptz not null
);
comment on table deliveries is '送信履歴 (メール・LINE・Chatwork)';

-- 社内資料 (ナレッジ・AI の回答の根拠)
create table if not exists knowledge (
  id text primary key,
  title text not null,
  body text not null default '',
  category text not null default '',
  tags text[] not null default '{}',
  source text not null check (source in ('manual','sheet','file')),
  source_ref text,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null,
  visibility text,
  record_date date,
  owner_id text,
  review_due date,
  review_interval_days integer,
  reviewed_at timestamptz,
  reviewed_by text
);
comment on table knowledge is '社内資料 (ナレッジ・AI の回答の根拠)';

-- 発注書 (仕入先への発注。明細ごとに案件 (受注) を持つ)
create table if not exists purchase_orders (
  id text primary key,
  number text not null unique,
  supplier_id text not null references suppliers(id),
  store_id text not null references stores(id),
  status text not null check (status in ('draft','issued','sent','completed','cancelled')),
  issued_on date not null,
  desired_date date,
  delivery_place text not null default '',
  delivery_address text,
  lines jsonb not null default '[]',
  order_ids text[] not null default '{}',
  notes text,
  show_customer boolean,
  fax_to text,
  version integer not null default 1 check (version >= 1),
  copied_from text,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null,
  issued_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text
);
comment on table purchase_orders is '発注書 (仕入先への発注。明細ごとに案件 (受注) を持つ)';

-- FAX の送受信履歴 (PDF の本体は VPS のディスク。ここにはパスだけ)
create table if not exists fax_messages (
  id text primary key,
  number text not null unique,
  direction text not null check (direction in ('inbound','outbound')),
  status text not null check (status in ('queued','sending','sent','failed','unknown','manual','received')),
  triage text check (triage in ('auto','review','accepted','junk')),
  remote_number text not null default '',
  remote_name text,
  local_number text,
  at timestamptz not null,
  completed_at timestamptz,
  pages integer,
  file_key text,
  file_name text not null default '',
  size integer,
  content_type text not null default 'application/pdf',
  provider text not null,
  provider_id text,
  provider_ref text unique,
  idempotency_key text unique,
  supplier_id text references suppliers(id) on delete set null,
  customer_id text references customers(id) on delete set null,
  purchase_order_id text references purchase_orders(id) on delete set null,
  po_version integer,
  order_ids text[] not null default '{}',
  store_id text not null references stores(id),
  assigned_user_id text references users(id) on delete set null,
  user_id text not null,
  ai jsonb,
  ai_pending boolean,
  attempts integer not null default 0,
  next_retry_at timestamptz,
  last_error text,
  events jsonb not null default '[]',
  decided_by text,
  decided_at timestamptz,
  checked_by text,
  checked_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table fax_messages is 'FAX の送受信履歴 (PDF の本体は VPS のディスク。ここにはパスだけ)';

-- FAX 番号の台帳 (不要な番号・顧客と仕入先の FAX 番号)
create table if not exists fax_numbers (
  id text primary key,
  number text not null unique,
  kind text not null check (kind in ('blocked','customer','supplier')),
  customer_id text references customers(id) on delete set null,
  supplier_id text references suppliers(id) on delete set null,
  label text not null default '',
  note text,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table fax_numbers is 'FAX 番号の台帳 (不要な番号・顧客と仕入先の FAX 番号)';

-- 場所 (地図上の 1 か所。顧客・案件・予定が共有する)
create table if not exists map_locations (
  id text primary key,
  address_key text not null default '',
  address text not null default '',
  postal_code text,
  precision text not null check (precision in ('house','area','none')),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  place_id text,
  coord_source text check (coord_source in ('manual','geocode','import')),
  coord_status text check (coord_status in ('unverified','needs_review','verified')),
  coord_verified_by text,
  coord_verified_at timestamptz,
  geocode_note text,
  note text,
  status text not null default 'active' check (status in ('active','merged')),
  merged_into text,
  source text not null default 'app' check (source in ('app','batch')),
  store_id text not null references stores(id),
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table map_locations is '場所 (地図上の 1 か所。顧客・案件・予定が共有する)';

-- 記録と場所の結び付け (番地のない住所の手動の結び付け・予定の場所の指定)
create table if not exists map_location_refs (
  id text primary key,
  record_type text not null check (record_type in ('customer','quote','order','event')),
  record_id text not null,
  mode text not null check (mode in ('manual','follow','custom')),
  location_id text references map_locations(id) on delete set null,
  address_snapshot text,
  linked_by text not null,
  linked_at timestamptz not null
);
comment on table map_location_refs is '記録と場所の結び付け (番地のない住所の手動の結び付け・予定の場所の指定)';

-- 住宅地図などの地図の PDF (本体は VPS のディスク。ここには台帳とライセンスの情報)
create table if not exists map_documents (
  id text primary key,
  kind text not null check (kind in ('residential','other')),
  provider text not null check (provider in ('zenrin','other')),
  title text not null default '',
  file_name text not null,
  content_type text not null default 'application/pdf',
  size integer not null default 0,
  sha256 text not null,
  page_count integer,
  storage_key text,
  status text not null check (status in ('active','replaced','removed')),
  replaces_id text,
  replaced_by_id text,
  source text not null check (source in ('upload','bulk_import','provider_api')),
  source_ref text,
  edition text,
  copyright_notice text not null default '',
  license_ref text,
  license_note text,
  license_confirmed_by text not null,
  license_confirmed_at timestamptz not null,
  shareable boolean,
  use_purpose text,
  nameplate boolean,
  store_id text not null references stores(id),
  uploaded_by text not null,
  uploaded_at timestamptz not null,
  updated_at timestamptz not null,
  removed_by text,
  removed_at timestamptz,
  remove_reason text
);
comment on table map_documents is '住宅地図などの地図の PDF (本体は VPS のディスク。ここには台帳とライセンスの情報)';

-- 地図の PDF と場所の結び付け (1 つの PDF を複数の場所から参照)
create table if not exists map_document_links (
  id text primary key,
  document_id text not null references map_documents(id) on delete cascade,
  location_id text not null references map_locations(id) on delete cascade,
  linked_by text not null,
  linked_at timestamptz not null
);
comment on table map_document_links is '地図の PDF と場所の結び付け (1 つの PDF を複数の場所から参照)';

-- 管理会計の設定 (配分率・端数・未確定の扱い。適用期間つき)
create table if not exists mgmt_rules (
  id text primary key,
  key text not null,
  value text not null,
  valid_from date not null,
  valid_to date,
  status text not null check (status in ('confirmed','provisional')),
  note text,
  created_by text not null,
  created_at timestamptz not null
);
comment on table mgmt_rules is '管理会計の設定 (配分率・端数・未確定の扱い。適用期間つき)';

-- 品目 (管理会計の 7 区分)
create table if not exists item_categories (
  id text primary key,
  name text not null,
  sort integer not null default 0,
  active boolean not null default true,
  note text,
  updated_at timestamptz
);
comment on table item_categories is '品目 (管理会計の 7 区分)';

-- 営業エリア (町名 → 担当店舗。履歴つき)
create table if not exists sales_areas (
  id text primary key,
  municipality text not null default '',
  town text not null,
  store_id text not null references stores(id),
  valid_from date not null,
  valid_to date,
  source text not null check (source in ('import','manual')),
  source_ref text,
  note text,
  created_by text not null,
  created_at timestamptz not null
);
comment on table sales_areas is '営業エリア (町名 → 担当店舗。履歴つき)';

-- 売上の帰属 (受注店舗・施工店舗・営業エリアの店舗・工事の区分・税区分)
create table if not exists order_attributions (
  id text primary key,
  order_id text not null unique,
  area_store_id text,
  area_key text,
  received_store_id text not null references stores(id),
  work_store_id text not null references stores(id),
  work_kind text not null check (work_kind in ('normal','reform')),
  hq_special boolean,
  tax_category text,
  note text,
  updated_by text not null,
  updated_at timestamptz not null
);
comment on table order_attributions is '売上の帰属 (受注店舗・施工店舗・営業エリアの店舗・工事の区分・税区分)';

-- 店舗別売上の調整 (内部受注・本部の特殊配分・手入力。店舗の合計は 0)
create table if not exists sales_adjustments (
  id text primary key,
  number text not null unique,
  kind text not null check (kind in ('internal_order','hq_special','manual')),
  order_id text,
  date date,
  from_store_id text not null references stores(id),
  to_store_id text not null references stores(id),
  work_kind text,
  base_amount numeric,
  base text,
  rate_bp integer,
  rate_source text,
  rule_ids text[] not null default '{}',
  rounding text,
  amount numeric not null,
  treatment text,
  provisional boolean not null default false,
  status text not null check (status in ('active','reversed')),
  reversal_of text,
  reversed_by text,
  reason text,
  created_by text not null,
  created_at timestamptz not null
);
comment on table sales_adjustments is '店舗別売上の調整 (内部受注・本部の特殊配分・手入力。店舗の合計は 0)';

-- 材料マスタ (畳表・畳縁・畳床・化学畳表・副資材・クロスなど)
create table if not exists materials (
  id text primary key,
  code text not null,
  name text not null,
  kind text not null,
  spec text,
  unit text not null,
  thickness numeric,
  size text,
  item_category text not null,
  supplier_code text,
  active boolean not null default true,
  note text,
  reorder_level numeric,
  supplier_id text,
  series text,
  lineup boolean,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table materials is '材料マスタ (畳表・畳縁・畳床・化学畳表・副資材・クロスなど)';

-- 材料の原価単価の履歴 (仮原価・原価単価。適用開始日つき)
create table if not exists material_costs (
  id text primary key,
  material_id text not null references materials(id),
  unit_cost numeric not null,
  kind text not null check (kind in ('provisional','standard')),
  valid_from date not null,
  valid_to date,
  note text,
  created_by text not null,
  created_at timestamptz not null
);
comment on table material_costs is '材料の原価単価の履歴 (仮原価・原価単価。適用開始日つき)';

-- 材料構成 (BOM: 商品 1 単位あたりの材料と使用量)
create table if not exists boms (
  id text primary key,
  product_id text,
  match_name text,
  name text not null,
  lines jsonb not null default '[]',
  valid_from date not null,
  valid_to date,
  note text,
  created_by text not null,
  created_at timestamptz not null
);
comment on table boms is '材料構成 (BOM: 商品 1 単位あたりの材料と使用量)';

-- 材料の使用・原価 (受注ごと。予想 → 使用予定 → 実績)
create table if not exists material_usages (
  id text primary key,
  order_id text not null,
  store_id text not null references stores(id),
  material_id text,
  material_kind text not null,
  item_category text not null,
  qty numeric not null,
  unit_cost numeric,
  cost_id text,
  amount numeric,
  stage text not null check (stage in ('estimate','planned','actual')),
  source text not null,
  bom_id text,
  product_label text,
  sheets numeric,
  spec jsonb,
  needs_review boolean,
  review_note text,
  status text not null check (status in ('active','superseded','reversed')),
  date date not null,
  stock_move_id text,
  reversal_of text,
  created_by text not null,
  created_at timestamptz not null,
  confirmed_by text,
  confirmed_at timestamptz
);
comment on table material_usages is '材料の使用・原価 (受注ごと。予想 → 使用予定 → 実績)';

-- 在庫の移動 (受入・店舗間の移動・使用・返品・廃棄・棚卸の調整)
create table if not exists stock_moves (
  id text primary key,
  number text not null unique,
  date date not null,
  kind text not null check (kind in ('receive','transfer','use','return','dispose','adjust')),
  material_id text not null references materials(id),
  qty numeric not null,
  unit_cost numeric not null,
  amount numeric not null,
  from_loc text,
  to_loc text,
  store_id text not null references stores(id),
  order_id text,
  purchase_id text,
  purchase_item_id text,
  usage_id text,
  status text not null check (status in ('draft','confirmed','reversed')),
  reversal_of text,
  reversed_by text,
  note text,
  created_by text not null,
  created_at timestamptz not null,
  approved_by text,
  approved_at timestamptz
);
comment on table stock_moves is '在庫の移動 (受入・店舗間の移動・使用・返品・廃棄・棚卸の調整)';

-- 店舗間の材料移動 (原価の振替。渡した店舗の材料費 −・受け取った店舗の材料費 +)
create table if not exists material_transfers (
  id text primary key,
  number text not null unique,
  date date not null,
  from_store_id text not null references stores(id),
  to_store_id text not null references stores(id),
  material_id text,
  name text not null,
  item_category text not null,
  qty numeric not null,
  unit_cost numeric not null,
  amount numeric not null,
  note text,
  status text not null check (status in ('active','reversed')),
  reversal_of text,
  reversed_by text,
  created_by text not null,
  created_at timestamptz not null
);
comment on table material_transfers is '店舗間の材料移動 (原価の振替。渡した店舗の材料費 −・受け取った店舗の材料費 +)';

-- 仕入明細の振り分け (読み取り・自動判定・確定した振り分けを別々に保存)
create table if not exists purchase_line_allocs (
  id text primary key,
  purchase_id text not null,
  item_id text not null,
  line_no integer not null,
  ocr jsonb not null,
  ai jsonb,
  splits jsonb not null default '[]',
  status text not null check (status in ('unassigned','needs_review','confirmed')),
  reason text,
  confirmed_by text,
  confirmed_at timestamptz,
  updated_at timestamptz not null
);
comment on table purchase_line_allocs is '仕入明細の振り分け (読み取り・自動判定・確定した振り分けを別々に保存)';

-- 経費の区分 (店舗独自経費・共通経費 (案分) と費目)
create table if not exists expense_classes (
  id text primary key,
  expense_id text not null unique,
  alloc_class text not null check (alloc_class in ('store','common')),
  cost_kind text not null,
  note text,
  updated_by text not null,
  updated_at timestamptz not null
);
comment on table expense_classes is '経費の区分 (店舗独自経費・共通経費 (案分) と費目)';

-- 管理会計の手入力 (人件費・管理経費・共通経費・材料の差額調整・予算)
create table if not exists mgmt_entries (
  id text primary key,
  month text not null,
  store_id text not null references stores(id),
  kind text not null check (kind in ('labor','store_expense','common_expense','other_mgmt','material_adjust','budget')),
  metric text,
  item_category text,
  amount numeric not null,
  note text,
  status text not null check (status in ('active','reversed')),
  reversal_of text,
  reversed_by text,
  created_by text not null,
  created_at timestamptz not null
);
comment on table mgmt_entries is '管理会計の手入力 (人件費・管理経費・共通経費・材料の差額調整・予算)';

-- 共通経費の案分の計算・確定 (基準の粗利益・率・結果・使った設定を保存)
create table if not exists allocation_runs (
  id text primary key,
  number text not null unique,
  month text not null,
  status text not null check (status in ('draft','held','confirmed','superseded')),
  method text not null,
  method_reason text,
  target_store_ids text[] not null default '{}',
  pool jsonb not null default '[]',
  pool_total numeric not null,
  basis jsonb not null default '[]',
  basis_total numeric not null,
  results jsonb not null default '[]',
  rounding text not null,
  hold_reason text,
  rules jsonb not null default '{}',
  correction_of text,
  superseded_by text,
  reason text,
  created_by text not null,
  created_at timestamptz not null,
  confirmed_by text,
  confirmed_at timestamptz
);
comment on table allocation_runs is '共通経費の案分の計算・確定 (基準の粗利益・率・結果・使った設定を保存)';

-- 月次確定 (確定時の店舗別損益の写しと、確定・解除の履歴)
create table if not exists period_closes (
  id text primary key,
  month text not null unique,
  status text not null check (status in ('closed','open')),
  snapshot jsonb,
  history jsonb not null default '[]',
  updated_at timestamptz not null
);
comment on table period_closes is '月次確定 (確定時の店舗別損益の写しと、確定・解除の履歴)';

-- 作業の内容 (作業種別と数量・標準時間・人数・技能・車両・製造日数・期限・お客様の希望・優先度)
create table if not exists job_specs (
  id text primary key,
  record_type text not null check (record_type in ('order','quote','inquiry','event')),
  record_id text not null,
  store_id text not null references stores(id),
  items jsonb not null default '[]',
  minutes integer,
  staff_count integer,
  skills text[] not null default '{}',
  resource_kinds text[] not null default '{}',
  production_days integer,
  pickup_from date,
  deadline date,
  preferred_dates text[] not null default '{}',
  preferred_weekdays jsonb not null default '[]',
  preferred_slot text,
  preferred_time text,
  avoid_dates text[] not null default '{}',
  preference_strength text not null default 'none' check (preference_strength in ('none','soft','hard')),
  priority text not null default 'normal' check (priority in ('urgent','high','normal','low')),
  note text,
  updated_by text not null,
  updated_at timestamptz not null
);
comment on table job_specs is '作業の内容 (作業種別と数量・標準時間・人数・技能・車両・製造日数・期限・お客様の希望・優先度)';

-- 製造の予定 (引き取り → 工程ごとの製造 → 納品)
create table if not exists production_jobs (
  id text primary key,
  store_id text not null references stores(id),
  order_id text,
  quote_id text,
  customer_id text,
  title text not null,
  items jsonb not null default '[]',
  pickup_event_id text,
  delivery_event_id text,
  hold_id text,
  steps jsonb not null default '[]',
  start_date date not null,
  end_date date not null,
  due_date date,
  status text not null check (status in ('planned','in_progress','done','cancelled')),
  material_check jsonb,
  note text,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz
);
comment on table production_jobs is '製造の予定 (引き取り → 工程ごとの製造 → 納品)';

-- 車両・設備・工具の予約
create table if not exists resource_bookings (
  id text primary key,
  resource_id text not null,
  store_id text not null references stores(id),
  date date not null,
  end_date date,
  start_time text,
  end_time text,
  slot text,
  event_id text,
  hold_id text,
  production_job_id text,
  note text,
  created_by text not null,
  created_at timestamptz not null
);
comment on table resource_bookings is '車両・設備・工具の予約';

-- 予定の仮押さえ (候補日・担当者の確認・お客様への案内)
create table if not exists schedule_holds (
  id text primary key,
  group_id text not null,
  rank integer not null default 1,
  store_id text not null references stores(id),
  kind text not null,
  title text not null,
  date date not null,
  end_date date,
  start_time text,
  end_time text,
  slot text,
  assignee_ids text[] not null default '{}',
  resource_ids text[] not null default '{}',
  customer_id text,
  inquiry_id text,
  quote_id text,
  order_id text,
  location text,
  memo text,
  chain_id text,
  score integer,
  reasons jsonb not null default '[]',
  warnings jsonb not null default '[]',
  status text not null check (status in ('held','confirmed','released','expired')),
  expires_at timestamptz not null,
  acks jsonb not null default '[]',
  offered_at timestamptz,
  offered_via text,
  customer_choice_at timestamptz,
  customer_choice_note text,
  event_id text,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz
);
comment on table schedule_holds is '予定の仮押さえ (候補日・担当者の確認・お客様への案内)';

-- 休暇の申請 (有給・振休・特別休暇。承認すると予定表に「休暇」を登録)
create table if not exists leave_requests (
  id text primary key,
  number text not null unique,
  user_id text not null,
  store_id text not null references stores(id),
  leave_type text not null check (leave_type in ('paid','comp','special')),
  date date not null,
  end_date date,
  slot text not null default 'day' check (slot in ('day','am','pm')),
  dates text[] not null default '{}',
  days numeric not null check (days > 0),
  reason text,
  holiday_work_id text,
  status text not null check (status in ('pending','approved','rejected','cancelled')),
  requested_by text not null,
  requested_at timestamptz not null,
  decided_by text,
  decided_at timestamptz,
  decision_comment text,
  event_id text,
  cancelled_by text,
  cancelled_at timestamptz,
  cancel_reason text,
  updated_at timestamptz not null
);
comment on table leave_requests is '休暇の申請 (有給・振休・特別休暇。承認すると予定表に「休暇」を登録)';

-- 有給休暇の付与 (付与日・日数・有効期限。切り替え時点の残日数を含む)
create table if not exists leave_grants (
  id text primary key,
  user_id text not null,
  kind text not null default 'grant' check (kind in ('grant','opening')),
  grant_date date not null,
  base_date date,
  expires_on date not null,
  days numeric not null check (days > 0),
  note text,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz
);
comment on table leave_grants is '有給休暇の付与 (付与日・日数・有効期限。切り替え時点の残日数を含む)';

-- 休日出勤 (振休の発生。切り替え時点の振休の残を含む)
create table if not exists holiday_works (
  id text primary key,
  user_id text not null,
  store_id text not null references stores(id),
  kind text not null default 'work' check (kind in ('work','opening')),
  date date not null,
  slot text not null default 'day' check (slot in ('day','am','pm')),
  days numeric not null check (days > 0),
  note text,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz
);
comment on table holiday_works is '休日出勤 (振休の発生。切り替え時点の振休の残を含む)';

-- 作業日報の手入力 (店舗 × 日。チラシの配布人・枚数・地域、来店数)
create table if not exists work_report_days (
  id text primary key,
  store_id text not null references stores(id),
  date date not null,
  visitors integer check (visitors is null or visitors >= 0),
  flyers jsonb not null default '[]',
  note text,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table work_report_days is '作業日報の手入力 (店舗 × 日。チラシの配布人・枚数・地域、来店数)';

-- 畳製造予定 (製造日の変更・繰り越し・製造日未定・製造済み・手で足した製造の予定。予定そのものは受注の引取日・採寸日から計算)
create table if not exists tatami_production (
  id text primary key,
  source_key text not null unique,
  store_id text not null references stores(id),
  order_id text,
  event_id text,
  customer_id text,
  date date,
  undecided boolean,
  base_date date,
  status text not null check (status in ('planned','done','cancelled')),
  done_at timestamptz,
  done_by text,
  title text,
  spec text,
  qty numeric,
  herinashi numeric,
  rooms jsonb,
  note text,
  history jsonb not null default '[]',
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table tatami_production is '畳製造予定 (製造日の変更・繰り越し・製造日未定・製造済み・手で足した製造の予定。予定そのものは受注の引取日・採寸日から計算)';

-- 販促の記録 (チラシ・イベント・点検の DM・テレアポ。地域ごとの部数)
create table if not exists promotions (
  id text primary key,
  number text not null unique,
  kind text not null check (kind in ('flyer','event','dm','teleapo','other')),
  title text not null,
  store_id text not null references stores(id),
  status text not null check (status in ('planned','done','cancelled')),
  start_date date not null,
  end_date date,
  areas jsonb not null default '[]',
  copies integer not null default 0 check (copies >= 0),
  cost numeric,
  media text not null,
  vendor text,
  note text,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table promotions is '販促の記録 (チラシ・イベント・点検の DM・テレアポ。地域ごとの部数)';

-- 事務改善シート (事務のミス・気づき・原因・具体的改善策)
create table if not exists office_improvements (
  id text primary key,
  year integer not null,
  date date,
  staff_name text not null default '',
  staff_id text,
  item text not null default '',
  content text not null,
  cause text,
  measure text,
  source text not null default 'manual' check (source in ('manual','import')),
  source_ref text,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table office_improvements is '事務改善シート (事務のミス・気づき・原因・具体的改善策)';

-- 慶弔リスト (通夜・葬儀・慶事への対応。ご家族の情報を含むため事務担当・本部・管理者だけが見る)
create table if not exists condolences (
  id text primary key,
  date date not null,
  category text not null check (category in ('condolence','celebration','other')),
  kind text not null default '',
  name text not null default '',
  relation text,
  amount numeric,
  attendee text,
  note text,
  source text not null default 'manual' check (source in ('manual','import')),
  source_ref text,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table condolences is '慶弔リスト (通夜・葬儀・慶事への対応。ご家族の情報を含むため事務担当・本部・管理者だけが見る)';

-- 案件の変更のお知らせ (予定・明細・金額・担当・お客様の付け替えなどの変更を、担当店舗・本部・管理者に知らせる。案件ごとの変更の履歴)
create table if not exists change_notices (
  id text primary key,
  at timestamptz not null,
  actor_id text not null,
  store_id text not null,
  target_type text not null,
  target_id text not null,
  case_ids jsonb not null default '[]',
  number text,
  title text not null default '',
  customer_id text,
  topic text not null,
  lines jsonb not null default '[]',
  href text not null,
  recipients jsonb not null default '[]',
  read_by jsonb not null default '[]'
);
comment on table change_notices is '案件の変更のお知らせ (予定・明細・金額・担当・お客様の付け替えなどの変更を、担当店舗・本部・管理者に知らせる。案件ごとの変更の履歴)';

-- 文書の下書き (AI アシスタントで作った文面の保存・版の履歴・確認・承認・送信)
create table if not exists doc_drafts (
  id text primary key,
  number text not null unique,
  title text not null,
  template text not null,
  format text not null check (format in ('email','line','document')),
  audience text not null check (audience in ('customer','internal')),
  subject text,
  body text not null default '',
  status text not null check (status in ('draft','reviewed','approved','sent','discarded')),
  store_id text not null references stores(id),
  refs jsonb not null default '[]',
  provider text not null default 'rules',
  notes text,
  version integer not null default 1,
  versions jsonb not null default '[]',
  events jsonb not null default '[]',
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null,
  reviewed_by text,
  reviewed_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  sent_by text,
  sent_at timestamptz,
  channel text,
  recipient text,
  recipient_label text,
  delivery_ids jsonb not null default '[]',
  comm_log_id text,
  copied_from text
);
comment on table doc_drafts is '文書の下書き (AI アシスタントで作った文面の保存・版の履歴・確認・承認・送信)';

-- 施工事例の投稿 (案件の写真・商品名・施工内容と AI の投稿文の下書き → 確認 → 投稿の記録)
create table if not exists case_posts (
  id text primary key,
  number text not null unique,
  order_id text not null,
  store_id text not null references stores(id),
  title text not null default '',
  photo_ids jsonb not null default '[]',
  products text not null default '',
  work_content text not null default '',
  area text,
  channels jsonb not null default '[]',
  ai_text text,
  text text not null default '',
  hashtags text not null default '',
  provider text not null default 'rules',
  consent text not null default 'unconfirmed' check (consent in ('unconfirmed','obtained','not_needed')),
  status text not null check (status in ('draft','review','approved','returned','posted','discarded')),
  requested_by text,
  requested_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  posted_at timestamptz,
  postings jsonb not null default '[]',
  events jsonb not null default '[]',
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table case_posts is '施工事例の投稿 (案件の写真・商品名・施工内容と AI の投稿文の下書き → 確認 → 投稿の記録)';

-- 整理整頓チェック (店舗 × 日。項目ごとの 良い・要改善・対象外、写真、要改善の対応)
create table if not exists tidy_checks (
  id text primary key,
  number text not null unique,
  store_id text not null references stores(id),
  date date not null,
  checked_by text not null,
  place text,
  items jsonb not null default '[]',
  score numeric,
  ok_count integer not null default 0,
  ng_count integer not null default 0,
  na_count integer not null default 0,
  comment text,
  photos jsonb not null default '[]',
  provisional boolean,
  created_by text not null,
  created_at timestamptz not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table tidy_checks is '整理整頓チェック (店舗 × 日。項目ごとの 良い・要改善・対象外、写真、要改善の対応)';

-- クライアント資料のファイルとフォルダー (source/。画像・動画・フォルダーは場所だけ)
create table if not exists source_items (
  id text primary key,
  entry text not null check (entry in ('file','folder','system')),
  path text not null unique deferrable initially deferred,
  parent_path text not null default '',
  name text not null,
  folder text not null default '',
  folder_label text not null default '',
  ext text not null default '',
  kind text not null,
  content text not null check (content in ('text','summary','path_only','excluded')),
  bytes bigint,
  sha1 text,
  modified_on date,
  original_path text,
  source_file_id text,
  drive_url text,
  action text,
  category text,
  visibility text not null check (visibility in ('all','manager','hq','admin')),
  store_id text,
  record_date date,
  status text not null,
  note text,
  imported_to text,
  duplicate_of text,
  chars integer not null default 0,
  sections integer not null default 0,
  sheet_names jsonb,
  pii jsonb,
  summary text,
  content_hash text,
  row_hash text not null,
  registered_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table source_items is 'クライアント資料のファイルとフォルダー (source/。画像・動画・フォルダーは場所だけ)';

-- クライアント資料の中身 (文書の節。ID・パスワードは伏せ字・見られる人つき)
create table if not exists source_texts (
  id text primary key,
  item_id text not null references source_items(id) on delete cascade,
  seq integer not null,
  section text not null default '',
  part integer not null default 1,
  parts integer not null default 1,
  visibility text not null check (visibility in ('all','manager','hq','admin')),
  category text,
  knowledge boolean not null default false,
  record_date date,
  head text not null,
  body text not null,
  chars integer not null default 0
);
comment on table source_texts is 'クライアント資料の中身 (文書の節。ID・パスワードは伏せ字・見られる人つき)';

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
alter table stores add column if not exists opened_on date;
alter table stores add column if not exists closed_on date;
alter table stores add column if not exists merged_into text;
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
alter table users add column if not exists notify_email text;
alter table users add column if not exists notify_by_email boolean;
alter table users add column if not exists chatwork_account_id text;
alter table users add column if not exists avatar_key text;
alter table users add column if not exists avatar_updated_at timestamptz;
alter table users add column if not exists signup_status text check (signup_status in ('pending'));
alter table users add column if not exists signup_requested_at timestamptz;
alter table users add column if not exists signup_note text;
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
alter table customers add column if not exists contacts jsonb;
alter table customers add column if not exists trade_stopped boolean;
alter table customers add column if not exists trade_stop_note text;
alter table customers add column if not exists billing_terms jsonb;
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
alter table inquiries add column if not exists media text;
alter table inquiries add column if not exists promotion_id text;
alter table inquiries add column if not exists intake jsonb;
alter table inquiries add column if not exists schedule_hold jsonb;
alter table inquiries add column if not exists site_address text;
alter table products add column if not exists category text not null;
alter table products add column if not exists name text not null;
alter table products add column if not exists grade text;
alter table products add column if not exists unit text not null;
alter table products add column if not exists unit_price numeric not null;
alter table products add column if not exists size_label text;
alter table products add column if not exists description text;
alter table products add column if not exists active boolean not null default true;
alter table products add column if not exists mgmt_category text;
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
alter table quotes add column if not exists work_details text;
alter table quotes add column if not exists revisions jsonb;
alter table quotes add column if not exists tax_included boolean;
alter table quotes add column if not exists tax_exempt boolean;
alter table quotes add column if not exists site_info jsonb;
alter table quotes add column if not exists paper_no text;
alter table quotes add column if not exists handed_over boolean;
alter table quotes add column if not exists spec_status text;
alter table quotes add column if not exists estimator_id text;
alter table quotes add column if not exists site_address text;
alter table quotes add column if not exists receipt_name text;
alter table quotes add column if not exists tatami_rooms jsonb;
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
alter table orders add column if not exists work_details text;
alter table orders add column if not exists site_info jsonb;
alter table orders add column if not exists spec_status text;
alter table orders add column if not exists spec_note text;
alter table orders add column if not exists schedule_status text;
alter table orders add column if not exists billing text;
alter table orders add column if not exists planned_payment text;
alter table orders add column if not exists closed_at timestamptz;
alter table orders add column if not exists closed_by text;
alter table orders add column if not exists receipt_name text;
alter table orders add column if not exists handovers jsonb;
alter table orders add column if not exists tatami_rooms jsonb;
alter table orders add column if not exists work_staff jsonb;
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
alter table invoices add column if not exists title text;
alter table invoices add column if not exists items jsonb;
alter table invoices add column if not exists tax_included boolean;
alter table invoices add column if not exists tax_exempt boolean;
alter table invoices add column if not exists notes text;
alter table invoices add column if not exists expected_date date;
alter table invoices add column if not exists expected_amount numeric;
alter table invoices add column if not exists expected_note text;
alter table invoices add column if not exists order_ids text[];
alter table invoices add column if not exists period_from date;
alter table invoices add column if not exists period_to date;
alter table invoices add column if not exists order_lines jsonb;
alter table payments add column if not exists invoice_id text not null references invoices(id);
alter table payments add column if not exists date date not null;
alter table payments add column if not exists amount numeric not null;
alter table payments add column if not exists method text not null;
alter table payments add column if not exists memo text;
alter table payments add column if not exists settled_on date;
alter table payments add column if not exists recorded_by text not null;
alter table payments add column if not exists created_at timestamptz not null;
alter table suppliers add column if not exists name text not null;
alter table suppliers add column if not exists category text not null default '';
alter table suppliers add column if not exists phone text;
alter table suppliers add column if not exists email text;
alter table suppliers add column if not exists payment_terms text not null default '';
alter table suppliers add column if not exists closing_day integer not null default 31;
alter table suppliers add column if not exists kind text;
alter table suppliers add column if not exists kana text;
alter table suppliers add column if not exists contact_name text;
alter table suppliers add column if not exists postal_code text;
alter table suppliers add column if not exists address text;
alter table suppliers add column if not exists fax text;
alter table suppliers add column if not exists pay_month_offset integer;
alter table suppliers add column if not exists pay_day integer;
alter table suppliers add column if not exists bank_info text;
alter table suppliers add column if not exists registration_number text;
alter table suppliers add column if not exists line_id text;
alter table suppliers add column if not exists chatwork_room_id text;
alter table suppliers add column if not exists notes text;
alter table suppliers add column if not exists active boolean;
alter table suppliers add column if not exists created_at timestamptz;
alter table suppliers add column if not exists updated_at timestamptz;
alter table suppliers add column if not exists pay_method text;
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
alter table purchases add column if not exists items jsonb;
alter table purchases add column if not exists account text;
alter table purchases add column if not exists order_id text;
alter table purchases add column if not exists supplier_invoice_no text;
alter table purchases add column if not exists scheduled_pay_date date;
alter table purchases add column if not exists pay_method text;
alter table purchases add column if not exists pay_reference text;
alter table purchases add column if not exists paid_by text;
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
alter table expenses add column if not exists paid_at date;
alter table expenses add column if not exists paid_by text;
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
alter table approvals add column if not exists changes jsonb;
alter table audit_logs add column if not exists at timestamptz not null;
alter table audit_logs add column if not exists user_id text not null;
alter table audit_logs add column if not exists action text not null;
alter table audit_logs add column if not exists entity text not null;
alter table audit_logs add column if not exists entity_id text not null;
alter table audit_logs add column if not exists entity_label text not null default '';
alter table audit_logs add column if not exists summary text not null default '';
alter table audit_logs add column if not exists changes jsonb;
alter table audit_logs add column if not exists store_id text;
alter table comm_logs add column if not exists customer_id text references customers(id);
alter table comm_logs add column if not exists channel text not null;
alter table comm_logs add column if not exists direction text not null;
alter table comm_logs add column if not exists subject text not null default '';
alter table comm_logs add column if not exists body text not null default '';
alter table comm_logs add column if not exists at timestamptz not null;
alter table comm_logs add column if not exists user_id text not null;
alter table comm_logs add column if not exists related_type text;
alter table comm_logs add column if not exists related_id text;
alter table comm_logs add column if not exists supplier_id text;
alter table comm_logs add column if not exists store_id text;
alter table comm_logs add column if not exists contact_name text;
alter table comm_logs add column if not exists delivery_id text;
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
alter table threads add column if not exists assignee_ids text[];
alter table threads add column if not exists due_date date;
alter table threads add column if not exists task_status text;
alter table threads add column if not exists acknowledged_at timestamptz;
alter table threads add column if not exists reported_at timestamptz;
alter table threads add column if not exists confirmed_at timestamptz;
alter table threads add column if not exists confirmed_by text;
alter table threads add column if not exists due_at timestamptz;
alter table threads add column if not exists assignee_store_id text;
alter table threads add column if not exists purpose text;
alter table threads add column if not exists reminded_at timestamptz;
alter table threads add column if not exists remind_count integer;
alter table messages add column if not exists thread_id text not null references threads(id) on delete cascade;
alter table messages add column if not exists user_id text not null;
alter table messages add column if not exists body text not null;
alter table messages add column if not exists at timestamptz not null;
alter table messages add column if not exists mentions text[] not null default '{}';
alter table messages add column if not exists event text;
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
alter table schedule_events add column if not exists work text;
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
alter table survey_responses add column if not exists answered_on date;
alter table survey_responses add column if not exists count_month text;
alter table survey_responses add column if not exists clerk_user_id text;
alter table survey_responses add column if not exists delivery_user_ids jsonb;
alter table survey_responses add column if not exists priority_list jsonb;
alter table survey_responses add column if not exists media_list jsonb;
alter table survey_responses add column if not exists comment text;
alter table survey_responses add column if not exists comment_tags jsonb;
alter table survey_responses add column if not exists comment_tone text;
alter table survey_responses add column if not exists document_id text;
alter table survey_responses add column if not exists source text;
alter table survey_responses add column if not exists created_by text;
alter table survey_responses add column if not exists created_at timestamptz;
alter table survey_responses add column if not exists updated_at timestamptz;
alter table quality_issues add column if not exists number text not null;
alter table quality_issues add column if not exists order_id text references orders(id) on delete cascade;
alter table quality_issues add column if not exists customer_id text;
alter table quality_issues add column if not exists store_id text not null references stores(id);
alter table quality_issues add column if not exists kind text not null;
alter table quality_issues add column if not exists points numeric not null;
alter table quality_issues add column if not exists occurred_on date not null;
alter table quality_issues add column if not exists responsible_user_ids jsonb not null default '[]'::jsonb;
alter table quality_issues add column if not exists description text not null;
alter table quality_issues add column if not exists cause text;
alter table quality_issues add column if not exists countermeasure text;
alter table quality_issues add column if not exists status text not null;
alter table quality_issues add column if not exists resolved_on date;
alter table quality_issues add column if not exists attribution text;
alter table quality_issues add column if not exists category text;
alter table quality_issues add column if not exists counted boolean;
alter table quality_issues add column if not exists site_name text;
alter table quality_issues add column if not exists origin text;
alter table quality_issues add column if not exists source_ref text;
alter table quality_issues add column if not exists reported_by text not null;
alter table quality_issues add column if not exists created_at timestamptz not null;
alter table quality_issues add column if not exists updated_at timestamptz not null;
alter table google_reviews add column if not exists posted_on date not null;
alter table google_reviews add column if not exists store_id text not null references stores(id);
alter table google_reviews add column if not exists user_id text not null;
alter table google_reviews add column if not exists reviewer_name text;
alter table google_reviews add column if not exists rating numeric;
alter table google_reviews add column if not exists comment text;
alter table google_reviews add column if not exists has_photo boolean;
alter table google_reviews add column if not exists points numeric not null;
alter table google_reviews add column if not exists order_id text references orders(id) on delete set null;
alter table google_reviews add column if not exists customer_id text;
alter table google_reviews add column if not exists note text;
alter table google_reviews add column if not exists source_ref text;
alter table google_reviews add column if not exists created_by text not null;
alter table google_reviews add column if not exists created_at timestamptz not null;
alter table google_reviews add column if not exists updated_at timestamptz not null;
alter table survey_history add column if not exists fiscal_label text not null;
alter table survey_history add column if not exists start_year integer not null;
alter table survey_history add column if not exists period text not null;
alter table survey_history add column if not exists store_id text references stores(id);
alter table survey_history add column if not exists question text not null;
alter table survey_history add column if not exists answer text not null default '';
alter table survey_history add column if not exists count numeric not null;
alter table survey_history add column if not exists source_ref text not null;
alter table survey_history add column if not exists imported_at timestamptz not null;
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
alter table settings add column if not exists value jsonb not null;
alter table settings add column if not exists updated_by text;
alter table settings add column if not exists updated_at timestamptz not null;
alter table attachments add column if not exists parent_type text not null check (parent_type in ('customer','inquiry','quote','order','expense','purchase','document'));
alter table attachments add column if not exists parent_id text not null;
alter table attachments add column if not exists customer_id text references customers(id) on delete set null;
alter table attachments add column if not exists store_id text not null references stores(id);
alter table attachments add column if not exists kind text not null check (kind in ('photo','file'));
alter table attachments add column if not exists file_name text not null;
alter table attachments add column if not exists content_type text not null;
alter table attachments add column if not exists size integer not null default 0;
alter table attachments add column if not exists storage_key text not null;
alter table attachments add column if not exists thumb_key text;
alter table attachments add column if not exists width integer;
alter table attachments add column if not exists height integer;
alter table attachments add column if not exists caption text;
alter table attachments add column if not exists taken_at timestamptz;
alter table attachments add column if not exists uploaded_by text not null references users(id);
alter table attachments add column if not exists uploaded_at timestamptz not null;
alter table cash_entries add column if not exists number text not null unique;
alter table cash_entries add column if not exists store_id text not null references stores(id);
alter table cash_entries add column if not exists date date not null;
alter table cash_entries add column if not exists direction text not null check (direction in ('in','out'));
alter table cash_entries add column if not exists amount numeric not null check (amount > 0);
alter table cash_entries add column if not exists account text not null;
alter table cash_entries add column if not exists counterparty text;
alter table cash_entries add column if not exists description text not null default '';
alter table cash_entries add column if not exists source text not null default 'manual';
alter table cash_entries add column if not exists source_id text;
alter table cash_entries add column if not exists recorded_by text not null;
alter table cash_entries add column if not exists created_at timestamptz not null;
alter table cash_entries add column if not exists updated_at timestamptz not null;
alter table deliveries add column if not exists channel text not null check (channel in ('email','line','chatwork'));
alter table deliveries add column if not exists recipient text not null;
alter table deliveries add column if not exists recipient_label text;
alter table deliveries add column if not exists subject text;
alter table deliveries add column if not exists body text not null default '';
alter table deliveries add column if not exists attachments jsonb;
alter table deliveries add column if not exists status text not null check (status in ('sent','failed','skipped'));
alter table deliveries add column if not exists error text;
alter table deliveries add column if not exists purpose text not null;
alter table deliveries add column if not exists related_type text;
alter table deliveries add column if not exists related_id text;
alter table deliveries add column if not exists user_id text not null;
alter table deliveries add column if not exists created_at timestamptz not null;
alter table knowledge add column if not exists title text not null;
alter table knowledge add column if not exists body text not null default '';
alter table knowledge add column if not exists category text not null default '';
alter table knowledge add column if not exists tags text[] not null default '{}';
alter table knowledge add column if not exists source text not null check (source in ('manual','sheet','file'));
alter table knowledge add column if not exists source_ref text;
alter table knowledge add column if not exists active boolean not null default true;
alter table knowledge add column if not exists created_by text not null;
alter table knowledge add column if not exists created_at timestamptz not null;
alter table knowledge add column if not exists updated_by text;
alter table knowledge add column if not exists updated_at timestamptz not null;
alter table knowledge add column if not exists visibility text;
alter table knowledge add column if not exists record_date date;
alter table knowledge add column if not exists owner_id text;
alter table knowledge add column if not exists review_due date;
alter table knowledge add column if not exists review_interval_days integer;
alter table knowledge add column if not exists reviewed_at timestamptz;
alter table knowledge add column if not exists reviewed_by text;
alter table purchase_orders add column if not exists number text not null unique;
alter table purchase_orders add column if not exists supplier_id text not null references suppliers(id);
alter table purchase_orders add column if not exists store_id text not null references stores(id);
alter table purchase_orders add column if not exists status text not null check (status in ('draft','issued','sent','completed','cancelled'));
alter table purchase_orders add column if not exists issued_on date not null;
alter table purchase_orders add column if not exists desired_date date;
alter table purchase_orders add column if not exists delivery_place text not null default '';
alter table purchase_orders add column if not exists delivery_address text;
alter table purchase_orders add column if not exists lines jsonb not null default '[]';
alter table purchase_orders add column if not exists order_ids text[] not null default '{}';
alter table purchase_orders add column if not exists notes text;
alter table purchase_orders add column if not exists show_customer boolean;
alter table purchase_orders add column if not exists fax_to text;
alter table purchase_orders add column if not exists version integer not null default 1 check (version >= 1);
alter table purchase_orders add column if not exists copied_from text;
alter table purchase_orders add column if not exists created_by text not null;
alter table purchase_orders add column if not exists created_at timestamptz not null;
alter table purchase_orders add column if not exists updated_by text;
alter table purchase_orders add column if not exists updated_at timestamptz not null;
alter table purchase_orders add column if not exists issued_at timestamptz;
alter table purchase_orders add column if not exists sent_at timestamptz;
alter table purchase_orders add column if not exists completed_at timestamptz;
alter table purchase_orders add column if not exists cancelled_at timestamptz;
alter table purchase_orders add column if not exists cancel_reason text;
alter table fax_messages add column if not exists number text not null unique;
alter table fax_messages add column if not exists direction text not null check (direction in ('inbound','outbound'));
alter table fax_messages add column if not exists status text not null check (status in ('queued','sending','sent','failed','unknown','manual','received'));
alter table fax_messages add column if not exists triage text check (triage in ('auto','review','accepted','junk'));
alter table fax_messages add column if not exists remote_number text not null default '';
alter table fax_messages add column if not exists remote_name text;
alter table fax_messages add column if not exists local_number text;
alter table fax_messages add column if not exists at timestamptz not null;
alter table fax_messages add column if not exists completed_at timestamptz;
alter table fax_messages add column if not exists pages integer;
alter table fax_messages add column if not exists file_key text;
alter table fax_messages add column if not exists file_name text not null default '';
alter table fax_messages add column if not exists size integer;
alter table fax_messages add column if not exists content_type text not null default 'application/pdf';
alter table fax_messages add column if not exists provider text not null;
alter table fax_messages add column if not exists provider_id text;
alter table fax_messages add column if not exists provider_ref text unique;
alter table fax_messages add column if not exists idempotency_key text unique;
alter table fax_messages add column if not exists supplier_id text references suppliers(id) on delete set null;
alter table fax_messages add column if not exists customer_id text references customers(id) on delete set null;
alter table fax_messages add column if not exists purchase_order_id text references purchase_orders(id) on delete set null;
alter table fax_messages add column if not exists po_version integer;
alter table fax_messages add column if not exists order_ids text[] not null default '{}';
alter table fax_messages add column if not exists store_id text not null references stores(id);
alter table fax_messages add column if not exists assigned_user_id text references users(id) on delete set null;
alter table fax_messages add column if not exists user_id text not null;
alter table fax_messages add column if not exists ai jsonb;
alter table fax_messages add column if not exists ai_pending boolean;
alter table fax_messages add column if not exists attempts integer not null default 0;
alter table fax_messages add column if not exists next_retry_at timestamptz;
alter table fax_messages add column if not exists last_error text;
alter table fax_messages add column if not exists events jsonb not null default '[]';
alter table fax_messages add column if not exists decided_by text;
alter table fax_messages add column if not exists decided_at timestamptz;
alter table fax_messages add column if not exists checked_by text;
alter table fax_messages add column if not exists checked_at timestamptz;
alter table fax_messages add column if not exists created_at timestamptz not null;
alter table fax_messages add column if not exists updated_at timestamptz not null;
alter table fax_numbers add column if not exists number text not null unique;
alter table fax_numbers add column if not exists kind text not null check (kind in ('blocked','customer','supplier'));
alter table fax_numbers add column if not exists customer_id text references customers(id) on delete set null;
alter table fax_numbers add column if not exists supplier_id text references suppliers(id) on delete set null;
alter table fax_numbers add column if not exists label text not null default '';
alter table fax_numbers add column if not exists note text;
alter table fax_numbers add column if not exists created_by text not null;
alter table fax_numbers add column if not exists created_at timestamptz not null;
alter table fax_numbers add column if not exists updated_at timestamptz not null;
alter table map_locations add column if not exists address_key text not null default '';
alter table map_locations add column if not exists address text not null default '';
alter table map_locations add column if not exists postal_code text;
alter table map_locations add column if not exists precision text not null check (precision in ('house','area','none'));
alter table map_locations add column if not exists lat double precision check (lat between -90 and 90);
alter table map_locations add column if not exists lng double precision check (lng between -180 and 180);
alter table map_locations add column if not exists place_id text;
alter table map_locations add column if not exists coord_source text check (coord_source in ('manual','geocode','import'));
alter table map_locations add column if not exists coord_status text check (coord_status in ('unverified','needs_review','verified'));
alter table map_locations add column if not exists coord_verified_by text;
alter table map_locations add column if not exists coord_verified_at timestamptz;
alter table map_locations add column if not exists geocode_note text;
alter table map_locations add column if not exists note text;
alter table map_locations add column if not exists status text not null default 'active' check (status in ('active','merged'));
alter table map_locations add column if not exists merged_into text;
alter table map_locations add column if not exists source text not null default 'app' check (source in ('app','batch'));
alter table map_locations add column if not exists store_id text not null references stores(id);
alter table map_locations add column if not exists created_by text not null;
alter table map_locations add column if not exists created_at timestamptz not null;
alter table map_locations add column if not exists updated_by text;
alter table map_locations add column if not exists updated_at timestamptz not null;
alter table map_location_refs add column if not exists record_type text not null check (record_type in ('customer','quote','order','event'));
alter table map_location_refs add column if not exists record_id text not null;
alter table map_location_refs add column if not exists mode text not null check (mode in ('manual','follow','custom'));
alter table map_location_refs add column if not exists location_id text references map_locations(id) on delete set null;
alter table map_location_refs add column if not exists address_snapshot text;
alter table map_location_refs add column if not exists linked_by text not null;
alter table map_location_refs add column if not exists linked_at timestamptz not null;
alter table map_documents add column if not exists kind text not null check (kind in ('residential','other'));
alter table map_documents add column if not exists provider text not null check (provider in ('zenrin','other'));
alter table map_documents add column if not exists title text not null default '';
alter table map_documents add column if not exists file_name text not null;
alter table map_documents add column if not exists content_type text not null default 'application/pdf';
alter table map_documents add column if not exists size integer not null default 0;
alter table map_documents add column if not exists sha256 text not null;
alter table map_documents add column if not exists page_count integer;
alter table map_documents add column if not exists storage_key text;
alter table map_documents add column if not exists status text not null check (status in ('active','replaced','removed'));
alter table map_documents add column if not exists replaces_id text;
alter table map_documents add column if not exists replaced_by_id text;
alter table map_documents add column if not exists source text not null check (source in ('upload','bulk_import','provider_api'));
alter table map_documents add column if not exists source_ref text;
alter table map_documents add column if not exists edition text;
alter table map_documents add column if not exists copyright_notice text not null default '';
alter table map_documents add column if not exists license_ref text;
alter table map_documents add column if not exists license_note text;
alter table map_documents add column if not exists license_confirmed_by text not null;
alter table map_documents add column if not exists license_confirmed_at timestamptz not null;
alter table map_documents add column if not exists shareable boolean;
alter table map_documents add column if not exists use_purpose text;
alter table map_documents add column if not exists nameplate boolean;
alter table map_documents add column if not exists store_id text not null references stores(id);
alter table map_documents add column if not exists uploaded_by text not null;
alter table map_documents add column if not exists uploaded_at timestamptz not null;
alter table map_documents add column if not exists updated_at timestamptz not null;
alter table map_documents add column if not exists removed_by text;
alter table map_documents add column if not exists removed_at timestamptz;
alter table map_documents add column if not exists remove_reason text;
alter table map_document_links add column if not exists document_id text not null references map_documents(id) on delete cascade;
alter table map_document_links add column if not exists location_id text not null references map_locations(id) on delete cascade;
alter table map_document_links add column if not exists linked_by text not null;
alter table map_document_links add column if not exists linked_at timestamptz not null;
alter table mgmt_rules add column if not exists key text not null;
alter table mgmt_rules add column if not exists value text not null;
alter table mgmt_rules add column if not exists valid_from date not null;
alter table mgmt_rules add column if not exists valid_to date;
alter table mgmt_rules add column if not exists status text not null check (status in ('confirmed','provisional'));
alter table mgmt_rules add column if not exists note text;
alter table mgmt_rules add column if not exists created_by text not null;
alter table mgmt_rules add column if not exists created_at timestamptz not null;
alter table item_categories add column if not exists name text not null;
alter table item_categories add column if not exists sort integer not null default 0;
alter table item_categories add column if not exists active boolean not null default true;
alter table item_categories add column if not exists note text;
alter table item_categories add column if not exists updated_at timestamptz;
alter table sales_areas add column if not exists municipality text not null default '';
alter table sales_areas add column if not exists town text not null;
alter table sales_areas add column if not exists store_id text not null references stores(id);
alter table sales_areas add column if not exists valid_from date not null;
alter table sales_areas add column if not exists valid_to date;
alter table sales_areas add column if not exists source text not null check (source in ('import','manual'));
alter table sales_areas add column if not exists source_ref text;
alter table sales_areas add column if not exists note text;
alter table sales_areas add column if not exists created_by text not null;
alter table sales_areas add column if not exists created_at timestamptz not null;
alter table order_attributions add column if not exists order_id text not null unique;
alter table order_attributions add column if not exists area_store_id text;
alter table order_attributions add column if not exists area_key text;
alter table order_attributions add column if not exists received_store_id text not null references stores(id);
alter table order_attributions add column if not exists work_store_id text not null references stores(id);
alter table order_attributions add column if not exists work_kind text not null check (work_kind in ('normal','reform'));
alter table order_attributions add column if not exists hq_special boolean;
alter table order_attributions add column if not exists tax_category text;
alter table order_attributions add column if not exists note text;
alter table order_attributions add column if not exists updated_by text not null;
alter table order_attributions add column if not exists updated_at timestamptz not null;
alter table sales_adjustments add column if not exists number text not null unique;
alter table sales_adjustments add column if not exists kind text not null check (kind in ('internal_order','hq_special','manual'));
alter table sales_adjustments add column if not exists order_id text;
alter table sales_adjustments add column if not exists date date;
alter table sales_adjustments add column if not exists from_store_id text not null references stores(id);
alter table sales_adjustments add column if not exists to_store_id text not null references stores(id);
alter table sales_adjustments add column if not exists work_kind text;
alter table sales_adjustments add column if not exists base_amount numeric;
alter table sales_adjustments add column if not exists base text;
alter table sales_adjustments add column if not exists rate_bp integer;
alter table sales_adjustments add column if not exists rate_source text;
alter table sales_adjustments add column if not exists rule_ids text[] not null default '{}';
alter table sales_adjustments add column if not exists rounding text;
alter table sales_adjustments add column if not exists amount numeric not null;
alter table sales_adjustments add column if not exists treatment text;
alter table sales_adjustments add column if not exists provisional boolean not null default false;
alter table sales_adjustments add column if not exists status text not null check (status in ('active','reversed'));
alter table sales_adjustments add column if not exists reversal_of text;
alter table sales_adjustments add column if not exists reversed_by text;
alter table sales_adjustments add column if not exists reason text;
alter table sales_adjustments add column if not exists created_by text not null;
alter table sales_adjustments add column if not exists created_at timestamptz not null;
alter table materials add column if not exists code text not null;
alter table materials add column if not exists name text not null;
alter table materials add column if not exists kind text not null;
alter table materials add column if not exists spec text;
alter table materials add column if not exists unit text not null;
alter table materials add column if not exists thickness numeric;
alter table materials add column if not exists size text;
alter table materials add column if not exists item_category text not null;
alter table materials add column if not exists supplier_code text;
alter table materials add column if not exists active boolean not null default true;
alter table materials add column if not exists note text;
alter table materials add column if not exists reorder_level numeric;
alter table materials add column if not exists supplier_id text;
alter table materials add column if not exists series text;
alter table materials add column if not exists lineup boolean;
alter table materials add column if not exists created_at timestamptz not null;
alter table materials add column if not exists updated_at timestamptz not null;
alter table material_costs add column if not exists material_id text not null references materials(id);
alter table material_costs add column if not exists unit_cost numeric not null;
alter table material_costs add column if not exists kind text not null check (kind in ('provisional','standard'));
alter table material_costs add column if not exists valid_from date not null;
alter table material_costs add column if not exists valid_to date;
alter table material_costs add column if not exists note text;
alter table material_costs add column if not exists created_by text not null;
alter table material_costs add column if not exists created_at timestamptz not null;
alter table boms add column if not exists product_id text;
alter table boms add column if not exists match_name text;
alter table boms add column if not exists name text not null;
alter table boms add column if not exists lines jsonb not null default '[]';
alter table boms add column if not exists valid_from date not null;
alter table boms add column if not exists valid_to date;
alter table boms add column if not exists note text;
alter table boms add column if not exists created_by text not null;
alter table boms add column if not exists created_at timestamptz not null;
alter table material_usages add column if not exists order_id text not null;
alter table material_usages add column if not exists store_id text not null references stores(id);
alter table material_usages add column if not exists material_id text;
alter table material_usages add column if not exists material_kind text not null;
alter table material_usages add column if not exists item_category text not null;
alter table material_usages add column if not exists qty numeric not null;
alter table material_usages add column if not exists unit_cost numeric;
alter table material_usages add column if not exists cost_id text;
alter table material_usages add column if not exists amount numeric;
alter table material_usages add column if not exists stage text not null check (stage in ('estimate','planned','actual'));
alter table material_usages add column if not exists source text not null;
alter table material_usages add column if not exists bom_id text;
alter table material_usages add column if not exists product_label text;
alter table material_usages add column if not exists sheets numeric;
alter table material_usages add column if not exists spec jsonb;
alter table material_usages add column if not exists needs_review boolean;
alter table material_usages add column if not exists review_note text;
alter table material_usages add column if not exists status text not null check (status in ('active','superseded','reversed'));
alter table material_usages add column if not exists date date not null;
alter table material_usages add column if not exists stock_move_id text;
alter table material_usages add column if not exists reversal_of text;
alter table material_usages add column if not exists created_by text not null;
alter table material_usages add column if not exists created_at timestamptz not null;
alter table material_usages add column if not exists confirmed_by text;
alter table material_usages add column if not exists confirmed_at timestamptz;
alter table stock_moves add column if not exists number text not null unique;
alter table stock_moves add column if not exists date date not null;
alter table stock_moves add column if not exists kind text not null check (kind in ('receive','transfer','use','return','dispose','adjust'));
alter table stock_moves add column if not exists material_id text not null references materials(id);
alter table stock_moves add column if not exists qty numeric not null;
alter table stock_moves add column if not exists unit_cost numeric not null;
alter table stock_moves add column if not exists amount numeric not null;
alter table stock_moves add column if not exists from_loc text;
alter table stock_moves add column if not exists to_loc text;
alter table stock_moves add column if not exists store_id text not null references stores(id);
alter table stock_moves add column if not exists order_id text;
alter table stock_moves add column if not exists purchase_id text;
alter table stock_moves add column if not exists purchase_item_id text;
alter table stock_moves add column if not exists usage_id text;
alter table stock_moves add column if not exists status text not null check (status in ('draft','confirmed','reversed'));
alter table stock_moves add column if not exists reversal_of text;
alter table stock_moves add column if not exists reversed_by text;
alter table stock_moves add column if not exists note text;
alter table stock_moves add column if not exists created_by text not null;
alter table stock_moves add column if not exists created_at timestamptz not null;
alter table stock_moves add column if not exists approved_by text;
alter table stock_moves add column if not exists approved_at timestamptz;
alter table material_transfers add column if not exists number text not null unique;
alter table material_transfers add column if not exists date date not null;
alter table material_transfers add column if not exists from_store_id text not null references stores(id);
alter table material_transfers add column if not exists to_store_id text not null references stores(id);
alter table material_transfers add column if not exists material_id text;
alter table material_transfers add column if not exists name text not null;
alter table material_transfers add column if not exists item_category text not null;
alter table material_transfers add column if not exists qty numeric not null;
alter table material_transfers add column if not exists unit_cost numeric not null;
alter table material_transfers add column if not exists amount numeric not null;
alter table material_transfers add column if not exists note text;
alter table material_transfers add column if not exists status text not null check (status in ('active','reversed'));
alter table material_transfers add column if not exists reversal_of text;
alter table material_transfers add column if not exists reversed_by text;
alter table material_transfers add column if not exists created_by text not null;
alter table material_transfers add column if not exists created_at timestamptz not null;
alter table purchase_line_allocs add column if not exists purchase_id text not null;
alter table purchase_line_allocs add column if not exists item_id text not null;
alter table purchase_line_allocs add column if not exists line_no integer not null;
alter table purchase_line_allocs add column if not exists ocr jsonb not null;
alter table purchase_line_allocs add column if not exists ai jsonb;
alter table purchase_line_allocs add column if not exists splits jsonb not null default '[]';
alter table purchase_line_allocs add column if not exists status text not null check (status in ('unassigned','needs_review','confirmed'));
alter table purchase_line_allocs add column if not exists reason text;
alter table purchase_line_allocs add column if not exists confirmed_by text;
alter table purchase_line_allocs add column if not exists confirmed_at timestamptz;
alter table purchase_line_allocs add column if not exists updated_at timestamptz not null;
alter table expense_classes add column if not exists expense_id text not null unique;
alter table expense_classes add column if not exists alloc_class text not null check (alloc_class in ('store','common'));
alter table expense_classes add column if not exists cost_kind text not null;
alter table expense_classes add column if not exists note text;
alter table expense_classes add column if not exists updated_by text not null;
alter table expense_classes add column if not exists updated_at timestamptz not null;
alter table mgmt_entries add column if not exists month text not null;
alter table mgmt_entries add column if not exists store_id text not null references stores(id);
alter table mgmt_entries add column if not exists kind text not null check (kind in ('labor','store_expense','common_expense','other_mgmt','material_adjust','budget'));
alter table mgmt_entries add column if not exists metric text;
alter table mgmt_entries add column if not exists item_category text;
alter table mgmt_entries add column if not exists amount numeric not null;
alter table mgmt_entries add column if not exists note text;
alter table mgmt_entries add column if not exists status text not null check (status in ('active','reversed'));
alter table mgmt_entries add column if not exists reversal_of text;
alter table mgmt_entries add column if not exists reversed_by text;
alter table mgmt_entries add column if not exists created_by text not null;
alter table mgmt_entries add column if not exists created_at timestamptz not null;
alter table allocation_runs add column if not exists number text not null unique;
alter table allocation_runs add column if not exists month text not null;
alter table allocation_runs add column if not exists status text not null check (status in ('draft','held','confirmed','superseded'));
alter table allocation_runs add column if not exists method text not null;
alter table allocation_runs add column if not exists method_reason text;
alter table allocation_runs add column if not exists target_store_ids text[] not null default '{}';
alter table allocation_runs add column if not exists pool jsonb not null default '[]';
alter table allocation_runs add column if not exists pool_total numeric not null;
alter table allocation_runs add column if not exists basis jsonb not null default '[]';
alter table allocation_runs add column if not exists basis_total numeric not null;
alter table allocation_runs add column if not exists results jsonb not null default '[]';
alter table allocation_runs add column if not exists rounding text not null;
alter table allocation_runs add column if not exists hold_reason text;
alter table allocation_runs add column if not exists rules jsonb not null default '{}';
alter table allocation_runs add column if not exists correction_of text;
alter table allocation_runs add column if not exists superseded_by text;
alter table allocation_runs add column if not exists reason text;
alter table allocation_runs add column if not exists created_by text not null;
alter table allocation_runs add column if not exists created_at timestamptz not null;
alter table allocation_runs add column if not exists confirmed_by text;
alter table allocation_runs add column if not exists confirmed_at timestamptz;
alter table period_closes add column if not exists month text not null unique;
alter table period_closes add column if not exists status text not null check (status in ('closed','open'));
alter table period_closes add column if not exists snapshot jsonb;
alter table period_closes add column if not exists history jsonb not null default '[]';
alter table period_closes add column if not exists updated_at timestamptz not null;
alter table job_specs add column if not exists record_type text not null check (record_type in ('order','quote','inquiry','event'));
alter table job_specs add column if not exists record_id text not null;
alter table job_specs add column if not exists store_id text not null references stores(id);
alter table job_specs add column if not exists items jsonb not null default '[]';
alter table job_specs add column if not exists minutes integer;
alter table job_specs add column if not exists staff_count integer;
alter table job_specs add column if not exists skills text[] not null default '{}';
alter table job_specs add column if not exists resource_kinds text[] not null default '{}';
alter table job_specs add column if not exists production_days integer;
alter table job_specs add column if not exists pickup_from date;
alter table job_specs add column if not exists deadline date;
alter table job_specs add column if not exists preferred_dates text[] not null default '{}';
alter table job_specs add column if not exists preferred_weekdays jsonb not null default '[]';
alter table job_specs add column if not exists preferred_slot text;
alter table job_specs add column if not exists preferred_time text;
alter table job_specs add column if not exists avoid_dates text[] not null default '{}';
alter table job_specs add column if not exists preference_strength text not null default 'none' check (preference_strength in ('none','soft','hard'));
alter table job_specs add column if not exists priority text not null default 'normal' check (priority in ('urgent','high','normal','low'));
alter table job_specs add column if not exists note text;
alter table job_specs add column if not exists updated_by text not null;
alter table job_specs add column if not exists updated_at timestamptz not null;
alter table production_jobs add column if not exists store_id text not null references stores(id);
alter table production_jobs add column if not exists order_id text;
alter table production_jobs add column if not exists quote_id text;
alter table production_jobs add column if not exists customer_id text;
alter table production_jobs add column if not exists title text not null;
alter table production_jobs add column if not exists items jsonb not null default '[]';
alter table production_jobs add column if not exists pickup_event_id text;
alter table production_jobs add column if not exists delivery_event_id text;
alter table production_jobs add column if not exists hold_id text;
alter table production_jobs add column if not exists steps jsonb not null default '[]';
alter table production_jobs add column if not exists start_date date not null;
alter table production_jobs add column if not exists end_date date not null;
alter table production_jobs add column if not exists due_date date;
alter table production_jobs add column if not exists status text not null check (status in ('planned','in_progress','done','cancelled'));
alter table production_jobs add column if not exists material_check jsonb;
alter table production_jobs add column if not exists note text;
alter table production_jobs add column if not exists created_by text not null;
alter table production_jobs add column if not exists created_at timestamptz not null;
alter table production_jobs add column if not exists updated_by text;
alter table production_jobs add column if not exists updated_at timestamptz;
alter table resource_bookings add column if not exists resource_id text not null;
alter table resource_bookings add column if not exists store_id text not null references stores(id);
alter table resource_bookings add column if not exists date date not null;
alter table resource_bookings add column if not exists end_date date;
alter table resource_bookings add column if not exists start_time text;
alter table resource_bookings add column if not exists end_time text;
alter table resource_bookings add column if not exists slot text;
alter table resource_bookings add column if not exists event_id text;
alter table resource_bookings add column if not exists hold_id text;
alter table resource_bookings add column if not exists production_job_id text;
alter table resource_bookings add column if not exists note text;
alter table resource_bookings add column if not exists created_by text not null;
alter table resource_bookings add column if not exists created_at timestamptz not null;
alter table schedule_holds add column if not exists group_id text not null;
alter table schedule_holds add column if not exists rank integer not null default 1;
alter table schedule_holds add column if not exists store_id text not null references stores(id);
alter table schedule_holds add column if not exists kind text not null;
alter table schedule_holds add column if not exists title text not null;
alter table schedule_holds add column if not exists date date not null;
alter table schedule_holds add column if not exists end_date date;
alter table schedule_holds add column if not exists start_time text;
alter table schedule_holds add column if not exists end_time text;
alter table schedule_holds add column if not exists slot text;
alter table schedule_holds add column if not exists assignee_ids text[] not null default '{}';
alter table schedule_holds add column if not exists resource_ids text[] not null default '{}';
alter table schedule_holds add column if not exists customer_id text;
alter table schedule_holds add column if not exists inquiry_id text;
alter table schedule_holds add column if not exists quote_id text;
alter table schedule_holds add column if not exists order_id text;
alter table schedule_holds add column if not exists location text;
alter table schedule_holds add column if not exists memo text;
alter table schedule_holds add column if not exists chain_id text;
alter table schedule_holds add column if not exists score integer;
alter table schedule_holds add column if not exists reasons jsonb not null default '[]';
alter table schedule_holds add column if not exists warnings jsonb not null default '[]';
alter table schedule_holds add column if not exists status text not null check (status in ('held','confirmed','released','expired'));
alter table schedule_holds add column if not exists expires_at timestamptz not null;
alter table schedule_holds add column if not exists acks jsonb not null default '[]';
alter table schedule_holds add column if not exists offered_at timestamptz;
alter table schedule_holds add column if not exists offered_via text;
alter table schedule_holds add column if not exists customer_choice_at timestamptz;
alter table schedule_holds add column if not exists customer_choice_note text;
alter table schedule_holds add column if not exists event_id text;
alter table schedule_holds add column if not exists created_by text not null;
alter table schedule_holds add column if not exists created_at timestamptz not null;
alter table schedule_holds add column if not exists updated_by text;
alter table schedule_holds add column if not exists updated_at timestamptz;
alter table leave_requests add column if not exists number text not null unique;
alter table leave_requests add column if not exists user_id text not null;
alter table leave_requests add column if not exists store_id text not null references stores(id);
alter table leave_requests add column if not exists leave_type text not null check (leave_type in ('paid','comp','special'));
alter table leave_requests add column if not exists date date not null;
alter table leave_requests add column if not exists end_date date;
alter table leave_requests add column if not exists slot text not null default 'day' check (slot in ('day','am','pm'));
alter table leave_requests add column if not exists dates text[] not null default '{}';
alter table leave_requests add column if not exists days numeric not null check (days > 0);
alter table leave_requests add column if not exists reason text;
alter table leave_requests add column if not exists holiday_work_id text;
alter table leave_requests add column if not exists status text not null check (status in ('pending','approved','rejected','cancelled'));
alter table leave_requests add column if not exists requested_by text not null;
alter table leave_requests add column if not exists requested_at timestamptz not null;
alter table leave_requests add column if not exists decided_by text;
alter table leave_requests add column if not exists decided_at timestamptz;
alter table leave_requests add column if not exists decision_comment text;
alter table leave_requests add column if not exists event_id text;
alter table leave_requests add column if not exists cancelled_by text;
alter table leave_requests add column if not exists cancelled_at timestamptz;
alter table leave_requests add column if not exists cancel_reason text;
alter table leave_requests add column if not exists updated_at timestamptz not null;
alter table leave_grants add column if not exists user_id text not null;
alter table leave_grants add column if not exists kind text not null default 'grant' check (kind in ('grant','opening'));
alter table leave_grants add column if not exists grant_date date not null;
alter table leave_grants add column if not exists base_date date;
alter table leave_grants add column if not exists expires_on date not null;
alter table leave_grants add column if not exists days numeric not null check (days > 0);
alter table leave_grants add column if not exists note text;
alter table leave_grants add column if not exists created_by text not null;
alter table leave_grants add column if not exists created_at timestamptz not null;
alter table leave_grants add column if not exists updated_by text;
alter table leave_grants add column if not exists updated_at timestamptz;
alter table holiday_works add column if not exists user_id text not null;
alter table holiday_works add column if not exists store_id text not null references stores(id);
alter table holiday_works add column if not exists kind text not null default 'work' check (kind in ('work','opening'));
alter table holiday_works add column if not exists date date not null;
alter table holiday_works add column if not exists slot text not null default 'day' check (slot in ('day','am','pm'));
alter table holiday_works add column if not exists days numeric not null check (days > 0);
alter table holiday_works add column if not exists note text;
alter table holiday_works add column if not exists created_by text not null;
alter table holiday_works add column if not exists created_at timestamptz not null;
alter table holiday_works add column if not exists updated_by text;
alter table holiday_works add column if not exists updated_at timestamptz;
alter table work_report_days add column if not exists store_id text not null references stores(id);
alter table work_report_days add column if not exists date date not null;
alter table work_report_days add column if not exists visitors integer check (visitors is null or visitors >= 0);
alter table work_report_days add column if not exists flyers jsonb not null default '[]';
alter table work_report_days add column if not exists note text;
alter table work_report_days add column if not exists created_by text not null;
alter table work_report_days add column if not exists created_at timestamptz not null;
alter table work_report_days add column if not exists updated_by text;
alter table work_report_days add column if not exists updated_at timestamptz not null;
alter table tatami_production add column if not exists source_key text not null unique;
alter table tatami_production add column if not exists store_id text not null references stores(id);
alter table tatami_production add column if not exists order_id text;
alter table tatami_production add column if not exists event_id text;
alter table tatami_production add column if not exists customer_id text;
alter table tatami_production add column if not exists date date;
alter table tatami_production add column if not exists undecided boolean;
alter table tatami_production add column if not exists base_date date;
alter table tatami_production add column if not exists status text not null check (status in ('planned','done','cancelled'));
alter table tatami_production add column if not exists done_at timestamptz;
alter table tatami_production add column if not exists done_by text;
alter table tatami_production add column if not exists title text;
alter table tatami_production add column if not exists spec text;
alter table tatami_production add column if not exists qty numeric;
alter table tatami_production add column if not exists herinashi numeric;
alter table tatami_production add column if not exists rooms jsonb;
alter table tatami_production add column if not exists note text;
alter table tatami_production add column if not exists history jsonb not null default '[]';
alter table tatami_production add column if not exists created_by text not null;
alter table tatami_production add column if not exists created_at timestamptz not null;
alter table tatami_production add column if not exists updated_by text;
alter table tatami_production add column if not exists updated_at timestamptz not null;
alter table promotions add column if not exists number text not null unique;
alter table promotions add column if not exists kind text not null check (kind in ('flyer','event','dm','teleapo','other'));
alter table promotions add column if not exists title text not null;
alter table promotions add column if not exists store_id text not null references stores(id);
alter table promotions add column if not exists status text not null check (status in ('planned','done','cancelled'));
alter table promotions add column if not exists start_date date not null;
alter table promotions add column if not exists end_date date;
alter table promotions add column if not exists areas jsonb not null default '[]';
alter table promotions add column if not exists copies integer not null default 0 check (copies >= 0);
alter table promotions add column if not exists cost numeric;
alter table promotions add column if not exists media text not null;
alter table promotions add column if not exists vendor text;
alter table promotions add column if not exists note text;
alter table promotions add column if not exists created_by text not null;
alter table promotions add column if not exists created_at timestamptz not null;
alter table promotions add column if not exists updated_by text;
alter table promotions add column if not exists updated_at timestamptz not null;
alter table office_improvements add column if not exists year integer not null;
alter table office_improvements add column if not exists date date;
alter table office_improvements add column if not exists staff_name text not null default '';
alter table office_improvements add column if not exists staff_id text;
alter table office_improvements add column if not exists item text not null default '';
alter table office_improvements add column if not exists content text not null;
alter table office_improvements add column if not exists cause text;
alter table office_improvements add column if not exists measure text;
alter table office_improvements add column if not exists source text not null default 'manual' check (source in ('manual','import'));
alter table office_improvements add column if not exists source_ref text;
alter table office_improvements add column if not exists created_by text not null;
alter table office_improvements add column if not exists created_at timestamptz not null;
alter table office_improvements add column if not exists updated_by text;
alter table office_improvements add column if not exists updated_at timestamptz not null;
alter table condolences add column if not exists date date not null;
alter table condolences add column if not exists category text not null check (category in ('condolence','celebration','other'));
alter table condolences add column if not exists kind text not null default '';
alter table condolences add column if not exists name text not null default '';
alter table condolences add column if not exists relation text;
alter table condolences add column if not exists amount numeric;
alter table condolences add column if not exists attendee text;
alter table condolences add column if not exists note text;
alter table condolences add column if not exists source text not null default 'manual' check (source in ('manual','import'));
alter table condolences add column if not exists source_ref text;
alter table condolences add column if not exists created_by text not null;
alter table condolences add column if not exists created_at timestamptz not null;
alter table condolences add column if not exists updated_by text;
alter table condolences add column if not exists updated_at timestamptz not null;
alter table change_notices add column if not exists at timestamptz not null;
alter table change_notices add column if not exists actor_id text not null;
alter table change_notices add column if not exists store_id text not null;
alter table change_notices add column if not exists target_type text not null;
alter table change_notices add column if not exists target_id text not null;
alter table change_notices add column if not exists case_ids jsonb not null default '[]';
alter table change_notices add column if not exists number text;
alter table change_notices add column if not exists title text not null default '';
alter table change_notices add column if not exists customer_id text;
alter table change_notices add column if not exists topic text not null;
alter table change_notices add column if not exists lines jsonb not null default '[]';
alter table change_notices add column if not exists href text not null;
alter table change_notices add column if not exists recipients jsonb not null default '[]';
alter table change_notices add column if not exists read_by jsonb not null default '[]';
alter table doc_drafts add column if not exists number text not null unique;
alter table doc_drafts add column if not exists title text not null;
alter table doc_drafts add column if not exists template text not null;
alter table doc_drafts add column if not exists format text not null check (format in ('email','line','document'));
alter table doc_drafts add column if not exists audience text not null check (audience in ('customer','internal'));
alter table doc_drafts add column if not exists subject text;
alter table doc_drafts add column if not exists body text not null default '';
alter table doc_drafts add column if not exists status text not null check (status in ('draft','reviewed','approved','sent','discarded'));
alter table doc_drafts add column if not exists store_id text not null references stores(id);
alter table doc_drafts add column if not exists refs jsonb not null default '[]';
alter table doc_drafts add column if not exists provider text not null default 'rules';
alter table doc_drafts add column if not exists notes text;
alter table doc_drafts add column if not exists version integer not null default 1;
alter table doc_drafts add column if not exists versions jsonb not null default '[]';
alter table doc_drafts add column if not exists events jsonb not null default '[]';
alter table doc_drafts add column if not exists created_by text not null;
alter table doc_drafts add column if not exists created_at timestamptz not null;
alter table doc_drafts add column if not exists updated_by text;
alter table doc_drafts add column if not exists updated_at timestamptz not null;
alter table doc_drafts add column if not exists reviewed_by text;
alter table doc_drafts add column if not exists reviewed_at timestamptz;
alter table doc_drafts add column if not exists approved_by text;
alter table doc_drafts add column if not exists approved_at timestamptz;
alter table doc_drafts add column if not exists sent_by text;
alter table doc_drafts add column if not exists sent_at timestamptz;
alter table doc_drafts add column if not exists channel text;
alter table doc_drafts add column if not exists recipient text;
alter table doc_drafts add column if not exists recipient_label text;
alter table doc_drafts add column if not exists delivery_ids jsonb not null default '[]';
alter table doc_drafts add column if not exists comm_log_id text;
alter table doc_drafts add column if not exists copied_from text;
alter table case_posts add column if not exists number text not null unique;
alter table case_posts add column if not exists order_id text not null;
alter table case_posts add column if not exists store_id text not null references stores(id);
alter table case_posts add column if not exists title text not null default '';
alter table case_posts add column if not exists photo_ids jsonb not null default '[]';
alter table case_posts add column if not exists products text not null default '';
alter table case_posts add column if not exists work_content text not null default '';
alter table case_posts add column if not exists area text;
alter table case_posts add column if not exists channels jsonb not null default '[]';
alter table case_posts add column if not exists ai_text text;
alter table case_posts add column if not exists text text not null default '';
alter table case_posts add column if not exists hashtags text not null default '';
alter table case_posts add column if not exists provider text not null default 'rules';
alter table case_posts add column if not exists consent text not null default 'unconfirmed' check (consent in ('unconfirmed','obtained','not_needed'));
alter table case_posts add column if not exists status text not null check (status in ('draft','review','approved','returned','posted','discarded'));
alter table case_posts add column if not exists requested_by text;
alter table case_posts add column if not exists requested_at timestamptz;
alter table case_posts add column if not exists approved_by text;
alter table case_posts add column if not exists approved_at timestamptz;
alter table case_posts add column if not exists posted_at timestamptz;
alter table case_posts add column if not exists postings jsonb not null default '[]';
alter table case_posts add column if not exists events jsonb not null default '[]';
alter table case_posts add column if not exists created_by text not null;
alter table case_posts add column if not exists created_at timestamptz not null;
alter table case_posts add column if not exists updated_by text;
alter table case_posts add column if not exists updated_at timestamptz not null;
alter table tidy_checks add column if not exists number text not null unique;
alter table tidy_checks add column if not exists store_id text not null references stores(id);
alter table tidy_checks add column if not exists date date not null;
alter table tidy_checks add column if not exists checked_by text not null;
alter table tidy_checks add column if not exists place text;
alter table tidy_checks add column if not exists items jsonb not null default '[]';
alter table tidy_checks add column if not exists score numeric;
alter table tidy_checks add column if not exists ok_count integer not null default 0;
alter table tidy_checks add column if not exists ng_count integer not null default 0;
alter table tidy_checks add column if not exists na_count integer not null default 0;
alter table tidy_checks add column if not exists comment text;
alter table tidy_checks add column if not exists photos jsonb not null default '[]';
alter table tidy_checks add column if not exists provisional boolean;
alter table tidy_checks add column if not exists created_by text not null;
alter table tidy_checks add column if not exists created_at timestamptz not null;
alter table tidy_checks add column if not exists updated_by text;
alter table tidy_checks add column if not exists updated_at timestamptz not null;
alter table source_items add column if not exists entry text not null check (entry in ('file','folder','system'));
alter table source_items add column if not exists path text not null unique deferrable initially deferred;
alter table source_items add column if not exists parent_path text not null default '';
alter table source_items add column if not exists name text not null;
alter table source_items add column if not exists folder text not null default '';
alter table source_items add column if not exists folder_label text not null default '';
alter table source_items add column if not exists ext text not null default '';
alter table source_items add column if not exists kind text not null;
alter table source_items add column if not exists content text not null check (content in ('text','summary','path_only','excluded'));
alter table source_items add column if not exists bytes bigint;
alter table source_items add column if not exists sha1 text;
alter table source_items add column if not exists modified_on date;
alter table source_items add column if not exists original_path text;
alter table source_items add column if not exists source_file_id text;
alter table source_items add column if not exists drive_url text;
alter table source_items add column if not exists action text;
alter table source_items add column if not exists category text;
alter table source_items add column if not exists visibility text not null check (visibility in ('all','manager','hq','admin'));
alter table source_items add column if not exists store_id text;
alter table source_items add column if not exists record_date date;
alter table source_items add column if not exists status text not null;
alter table source_items add column if not exists note text;
alter table source_items add column if not exists imported_to text;
alter table source_items add column if not exists duplicate_of text;
alter table source_items add column if not exists chars integer not null default 0;
alter table source_items add column if not exists sections integer not null default 0;
alter table source_items add column if not exists sheet_names jsonb;
alter table source_items add column if not exists pii jsonb;
alter table source_items add column if not exists summary text;
alter table source_items add column if not exists content_hash text;
alter table source_items add column if not exists row_hash text not null;
alter table source_items add column if not exists registered_at timestamptz not null;
alter table source_items add column if not exists updated_at timestamptz not null;
alter table source_texts add column if not exists item_id text not null references source_items(id) on delete cascade;
alter table source_texts add column if not exists seq integer not null;
alter table source_texts add column if not exists section text not null default '';
alter table source_texts add column if not exists part integer not null default 1;
alter table source_texts add column if not exists parts integer not null default 1;
alter table source_texts add column if not exists visibility text not null check (visibility in ('all','manager','hq','admin'));
alter table source_texts add column if not exists category text;
alter table source_texts add column if not exists knowledge boolean not null default false;
alter table source_texts add column if not exists record_date date;
alter table source_texts add column if not exists head text not null;
alter table source_texts add column if not exists body text not null;
alter table source_texts add column if not exists chars integer not null default 0;

-- 索引 (検索・読み込みの並び順)
create index if not exists stores_load_order_idx on stores (code, id);
create index if not exists customers_store_id_idx on customers (store_id);
create index if not exists customers_name_idx on customers (name);
create index if not exists customers_area_idx on customers (area);
create index if not exists customers_load_order_idx on customers (code, id);
create index if not exists inquiries_store_id_idx on inquiries (store_id);
create index if not exists inquiries_status_idx on inquiries (status);
create index if not exists inquiries_customer_id_idx on inquiries (customer_id);
create index if not exists inquiries_load_order_idx on inquiries (received_at, id);
create index if not exists quotes_store_id_idx on quotes (store_id);
create index if not exists quotes_status_idx on quotes (status);
create index if not exists quotes_customer_id_idx on quotes (customer_id);
create index if not exists quotes_load_order_idx on quotes (created_at, id);
create index if not exists orders_store_id_idx on orders (store_id);
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_customer_id_idx on orders (customer_id);
create index if not exists orders_sales_date_idx on orders (sales_date);
create index if not exists orders_load_order_idx on orders (created_at, id);
create index if not exists invoices_store_id_idx on invoices (store_id);
create index if not exists invoices_status_idx on invoices (status);
create index if not exists invoices_load_order_idx on invoices (created_at, id);
create index if not exists payments_load_order_idx on payments (created_at, id);
create index if not exists purchases_status_idx on purchases (status);
create index if not exists purchases_supplier_id_idx on purchases (supplier_id);
create index if not exists purchases_load_order_idx on purchases (created_at, id);
create index if not exists expenses_store_id_idx on expenses (store_id);
create index if not exists expenses_status_idx on expenses (status);
create index if not exists expenses_load_order_idx on expenses (created_at, id);
create index if not exists approvals_status_idx on approvals (status);
create index if not exists approvals_target_id_idx on approvals (target_id);
create index if not exists approvals_load_order_idx on approvals (created_at, id);
create index if not exists audit_logs_entity_entity_id_idx on audit_logs (entity, entity_id);
create index if not exists audit_logs_at_idx on audit_logs (at);
create index if not exists audit_logs_load_order_idx on audit_logs (at, id);
create index if not exists comm_logs_customer_id_idx on comm_logs (customer_id);
create index if not exists comm_logs_supplier_id_idx on comm_logs (supplier_id);
create index if not exists comm_logs_related_type_related_id_idx on comm_logs (related_type, related_id);
create index if not exists comm_logs_load_order_idx on comm_logs (at, id);
create index if not exists threads_load_order_idx on threads (created_at, id);
create index if not exists messages_thread_id_idx on messages (thread_id);
create index if not exists messages_load_order_idx on messages (at, id);
create index if not exists documents_load_order_idx on documents (uploaded_at, id);
create index if not exists schedule_events_date_idx on schedule_events (date);
create index if not exists schedule_events_store_id_date_idx on schedule_events (store_id, date);
create index if not exists schedule_events_order_id_idx on schedule_events (order_id);
create index if not exists schedule_events_customer_id_idx on schedule_events (customer_id);
create index if not exists schedule_events_load_order_idx on schedule_events (date, start_time, id);
create index if not exists company_holidays_load_order_idx on company_holidays (date, id);
create index if not exists survey_responses_store_id_idx on survey_responses (store_id);
create index if not exists survey_responses_load_order_idx on survey_responses (received_at, id);
create index if not exists quality_issues_store_id_idx on quality_issues (store_id);
create index if not exists quality_issues_order_id_idx on quality_issues (order_id);
create index if not exists quality_issues_load_order_idx on quality_issues (occurred_on, id);
create index if not exists google_reviews_store_id_idx on google_reviews (store_id);
create index if not exists google_reviews_load_order_idx on google_reviews (posted_on, id);
create index if not exists survey_history_start_year_idx on survey_history (start_year);
create index if not exists survey_history_load_order_idx on survey_history (start_year, question, id);
create index if not exists source_files_folder_idx on source_files (folder);
create index if not exists source_files_load_order_idx on source_files (folder, path, id);
create index if not exists photo_albums_load_order_idx on photo_albums (date, id);
create index if not exists attachments_parent_type_parent_id_idx on attachments (parent_type, parent_id);
create index if not exists attachments_customer_id_idx on attachments (customer_id);
create index if not exists attachments_load_order_idx on attachments (uploaded_at, id);
create index if not exists cash_entries_store_id_date_idx on cash_entries (store_id, date);
create index if not exists cash_entries_source_id_idx on cash_entries (source_id);
create index if not exists cash_entries_load_order_idx on cash_entries (date, created_at, id);
create index if not exists deliveries_related_type_related_id_idx on deliveries (related_type, related_id);
create index if not exists deliveries_load_order_idx on deliveries (created_at, id);
create index if not exists knowledge_source_ref_idx on knowledge (source_ref);
create index if not exists knowledge_load_order_idx on knowledge (created_at, id);
create index if not exists purchase_orders_supplier_id_idx on purchase_orders (supplier_id);
create index if not exists purchase_orders_store_id_idx on purchase_orders (store_id);
create index if not exists purchase_orders_load_order_idx on purchase_orders (created_at, id);
create index if not exists fax_messages_supplier_id_idx on fax_messages (supplier_id);
create index if not exists fax_messages_purchase_order_id_idx on fax_messages (purchase_order_id);
create index if not exists fax_messages_remote_number_idx on fax_messages (remote_number);
create index if not exists fax_messages_load_order_idx on fax_messages (at, id);
create index if not exists fax_numbers_load_order_idx on fax_numbers (created_at, id);
create index if not exists map_locations_address_key_idx on map_locations (address_key);
create index if not exists map_locations_load_order_idx on map_locations (created_at, id);
create index if not exists map_location_refs_record_type_record_id_idx on map_location_refs (record_type, record_id);
create index if not exists map_location_refs_location_id_idx on map_location_refs (location_id);
create index if not exists map_location_refs_load_order_idx on map_location_refs (linked_at, id);
create index if not exists map_documents_sha256_idx on map_documents (sha256);
create index if not exists map_documents_source_ref_idx on map_documents (source_ref);
create index if not exists map_documents_load_order_idx on map_documents (uploaded_at, id);
create index if not exists map_document_links_document_id_idx on map_document_links (document_id);
create index if not exists map_document_links_location_id_idx on map_document_links (location_id);
create index if not exists map_document_links_load_order_idx on map_document_links (linked_at, id);
create index if not exists mgmt_rules_load_order_idx on mgmt_rules (key, valid_from, id);
create index if not exists item_categories_load_order_idx on item_categories (sort, id);
create index if not exists sales_areas_store_id_idx on sales_areas (store_id);
create index if not exists sales_areas_load_order_idx on sales_areas (town, valid_from, id);
create index if not exists order_attributions_load_order_idx on order_attributions (order_id, id);
create index if not exists sales_adjustments_order_id_idx on sales_adjustments (order_id);
create index if not exists sales_adjustments_date_idx on sales_adjustments (date);
create index if not exists sales_adjustments_load_order_idx on sales_adjustments (created_at, id);
create index if not exists materials_load_order_idx on materials (code, id);
create index if not exists material_costs_load_order_idx on material_costs (material_id, valid_from, id);
create index if not exists boms_load_order_idx on boms (name, valid_from, id);
create index if not exists material_usages_order_id_idx on material_usages (order_id);
create index if not exists material_usages_load_order_idx on material_usages (created_at, id);
create index if not exists stock_moves_material_id_date_idx on stock_moves (material_id, date);
create index if not exists stock_moves_store_id_idx on stock_moves (store_id);
create index if not exists stock_moves_purchase_id_idx on stock_moves (purchase_id);
create index if not exists stock_moves_load_order_idx on stock_moves (date, created_at, id);
create index if not exists material_transfers_date_idx on material_transfers (date);
create index if not exists material_transfers_from_store_id_idx on material_transfers (from_store_id);
create index if not exists material_transfers_to_store_id_idx on material_transfers (to_store_id);
create index if not exists material_transfers_load_order_idx on material_transfers (date, created_at, id);
create index if not exists purchase_line_allocs_purchase_id_item_id_idx on purchase_line_allocs (purchase_id, item_id);
create index if not exists purchase_line_allocs_load_order_idx on purchase_line_allocs (purchase_id, line_no, id);
create index if not exists expense_classes_load_order_idx on expense_classes (expense_id, id);
create index if not exists mgmt_entries_month_idx on mgmt_entries (month);
create index if not exists mgmt_entries_load_order_idx on mgmt_entries (month, created_at, id);
create index if not exists allocation_runs_load_order_idx on allocation_runs (month, created_at, id);
create index if not exists period_closes_load_order_idx on period_closes (month, id);
create index if not exists job_specs_record_type_record_id_idx on job_specs (record_type, record_id);
create index if not exists job_specs_load_order_idx on job_specs (updated_at, id);
create index if not exists production_jobs_order_id_idx on production_jobs (order_id);
create index if not exists production_jobs_store_id_start_date_idx on production_jobs (store_id, start_date);
create index if not exists production_jobs_load_order_idx on production_jobs (start_date, id);
create index if not exists resource_bookings_resource_id_date_idx on resource_bookings (resource_id, date);
create index if not exists resource_bookings_event_id_idx on resource_bookings (event_id);
create index if not exists resource_bookings_load_order_idx on resource_bookings (date, id);
create index if not exists schedule_holds_group_id_idx on schedule_holds (group_id);
create index if not exists schedule_holds_status_date_idx on schedule_holds (status, date);
create index if not exists schedule_holds_load_order_idx on schedule_holds (date, id);
create index if not exists leave_requests_user_id_date_idx on leave_requests (user_id, date);
create index if not exists leave_requests_status_idx on leave_requests (status);
create index if not exists leave_requests_load_order_idx on leave_requests (date, requested_at, id);
create index if not exists leave_grants_user_id_grant_date_idx on leave_grants (user_id, grant_date);
create index if not exists leave_grants_load_order_idx on leave_grants (grant_date, id);
create index if not exists holiday_works_user_id_date_idx on holiday_works (user_id, date);
create index if not exists holiday_works_load_order_idx on holiday_works (date, created_at, id);
create index if not exists work_report_days_store_id_date_idx on work_report_days (store_id, date);
create index if not exists work_report_days_load_order_idx on work_report_days (date, id);
create index if not exists tatami_production_store_id_date_idx on tatami_production (store_id, date);
create index if not exists tatami_production_order_id_idx on tatami_production (order_id);
create index if not exists tatami_production_load_order_idx on tatami_production (date, created_at, id);
create index if not exists promotions_store_id_start_date_idx on promotions (store_id, start_date);
create index if not exists promotions_kind_idx on promotions (kind);
create index if not exists promotions_load_order_idx on promotions (start_date, id);
create index if not exists office_improvements_load_order_idx on office_improvements (year, date, created_at, id);
create index if not exists condolences_load_order_idx on condolences (date, created_at, id);
create index if not exists change_notices_store_id_at_idx on change_notices (store_id, at);
create index if not exists change_notices_target_id_idx on change_notices (target_id);
create index if not exists change_notices_load_order_idx on change_notices (at, id);
create index if not exists doc_drafts_store_id_idx on doc_drafts (store_id);
create index if not exists doc_drafts_status_idx on doc_drafts (status);
create index if not exists doc_drafts_load_order_idx on doc_drafts (created_at, id);
create index if not exists case_posts_order_id_idx on case_posts (order_id);
create index if not exists case_posts_store_id_status_idx on case_posts (store_id, status);
create index if not exists case_posts_load_order_idx on case_posts (created_at, id);
create index if not exists tidy_checks_store_id_date_idx on tidy_checks (store_id, date);
create index if not exists tidy_checks_load_order_idx on tidy_checks (date, created_at, id);
create index if not exists source_items_folder_idx on source_items (folder);
create index if not exists source_items_parent_path_idx on source_items (parent_path);
create index if not exists source_items_entry_idx on source_items (entry);
create index if not exists source_items_content_idx on source_items (content);
create index if not exists source_items_load_order_idx on source_items (path, id);
create index if not exists source_texts_visibility_idx on source_texts (visibility);
create index if not exists source_texts_load_order_idx on source_texts (item_id, seq, id);

-- 後から not null を外した列 (データは変えない。外した後に実行しても変化なし)
alter table comm_logs alter column customer_id drop not null;
alter table quality_issues alter column order_id drop not null;

-- 行レベルセキュリティ: 有効化のみ (ポリシーなし)。publishable / anon キーからはアクセスできない
-- アプリが使う secret キー (service_role) には読み書きの権限を明示的に付ける (プロジェクトの既定の権限に頼らない)
grant usage on schema public to service_role;
alter table app_meta enable row level security;
revoke all on table app_meta from anon, authenticated;
grant select, insert, update, delete on table app_meta to service_role;
alter table app_changes enable row level security;
revoke all on table app_changes from anon, authenticated;
grant select, insert, update, delete on table app_changes to service_role;
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
alter table quality_issues enable row level security;
revoke all on table quality_issues from anon, authenticated;
grant select, insert, update, delete on table quality_issues to service_role;
alter table google_reviews enable row level security;
revoke all on table google_reviews from anon, authenticated;
grant select, insert, update, delete on table google_reviews to service_role;
alter table survey_history enable row level security;
revoke all on table survey_history from anon, authenticated;
grant select, insert, update, delete on table survey_history to service_role;
alter table source_files enable row level security;
revoke all on table source_files from anon, authenticated;
grant select, insert, update, delete on table source_files to service_role;
alter table photo_albums enable row level security;
revoke all on table photo_albums from anon, authenticated;
grant select, insert, update, delete on table photo_albums to service_role;
alter table settings enable row level security;
revoke all on table settings from anon, authenticated;
grant select, insert, update, delete on table settings to service_role;
alter table attachments enable row level security;
revoke all on table attachments from anon, authenticated;
grant select, insert, update, delete on table attachments to service_role;
alter table cash_entries enable row level security;
revoke all on table cash_entries from anon, authenticated;
grant select, insert, update, delete on table cash_entries to service_role;
alter table deliveries enable row level security;
revoke all on table deliveries from anon, authenticated;
grant select, insert, update, delete on table deliveries to service_role;
alter table knowledge enable row level security;
revoke all on table knowledge from anon, authenticated;
grant select, insert, update, delete on table knowledge to service_role;
alter table purchase_orders enable row level security;
revoke all on table purchase_orders from anon, authenticated;
grant select, insert, update, delete on table purchase_orders to service_role;
alter table fax_messages enable row level security;
revoke all on table fax_messages from anon, authenticated;
grant select, insert, update, delete on table fax_messages to service_role;
alter table fax_numbers enable row level security;
revoke all on table fax_numbers from anon, authenticated;
grant select, insert, update, delete on table fax_numbers to service_role;
alter table map_locations enable row level security;
revoke all on table map_locations from anon, authenticated;
grant select, insert, update, delete on table map_locations to service_role;
alter table map_location_refs enable row level security;
revoke all on table map_location_refs from anon, authenticated;
grant select, insert, update, delete on table map_location_refs to service_role;
alter table map_documents enable row level security;
revoke all on table map_documents from anon, authenticated;
grant select, insert, update, delete on table map_documents to service_role;
alter table map_document_links enable row level security;
revoke all on table map_document_links from anon, authenticated;
grant select, insert, update, delete on table map_document_links to service_role;
alter table mgmt_rules enable row level security;
revoke all on table mgmt_rules from anon, authenticated;
grant select, insert, update, delete on table mgmt_rules to service_role;
alter table item_categories enable row level security;
revoke all on table item_categories from anon, authenticated;
grant select, insert, update, delete on table item_categories to service_role;
alter table sales_areas enable row level security;
revoke all on table sales_areas from anon, authenticated;
grant select, insert, update, delete on table sales_areas to service_role;
alter table order_attributions enable row level security;
revoke all on table order_attributions from anon, authenticated;
grant select, insert, update, delete on table order_attributions to service_role;
alter table sales_adjustments enable row level security;
revoke all on table sales_adjustments from anon, authenticated;
grant select, insert, update, delete on table sales_adjustments to service_role;
alter table materials enable row level security;
revoke all on table materials from anon, authenticated;
grant select, insert, update, delete on table materials to service_role;
alter table material_costs enable row level security;
revoke all on table material_costs from anon, authenticated;
grant select, insert, update, delete on table material_costs to service_role;
alter table boms enable row level security;
revoke all on table boms from anon, authenticated;
grant select, insert, update, delete on table boms to service_role;
alter table material_usages enable row level security;
revoke all on table material_usages from anon, authenticated;
grant select, insert, update, delete on table material_usages to service_role;
alter table stock_moves enable row level security;
revoke all on table stock_moves from anon, authenticated;
grant select, insert, update, delete on table stock_moves to service_role;
alter table material_transfers enable row level security;
revoke all on table material_transfers from anon, authenticated;
grant select, insert, update, delete on table material_transfers to service_role;
alter table purchase_line_allocs enable row level security;
revoke all on table purchase_line_allocs from anon, authenticated;
grant select, insert, update, delete on table purchase_line_allocs to service_role;
alter table expense_classes enable row level security;
revoke all on table expense_classes from anon, authenticated;
grant select, insert, update, delete on table expense_classes to service_role;
alter table mgmt_entries enable row level security;
revoke all on table mgmt_entries from anon, authenticated;
grant select, insert, update, delete on table mgmt_entries to service_role;
alter table allocation_runs enable row level security;
revoke all on table allocation_runs from anon, authenticated;
grant select, insert, update, delete on table allocation_runs to service_role;
alter table period_closes enable row level security;
revoke all on table period_closes from anon, authenticated;
grant select, insert, update, delete on table period_closes to service_role;
alter table job_specs enable row level security;
revoke all on table job_specs from anon, authenticated;
grant select, insert, update, delete on table job_specs to service_role;
alter table production_jobs enable row level security;
revoke all on table production_jobs from anon, authenticated;
grant select, insert, update, delete on table production_jobs to service_role;
alter table resource_bookings enable row level security;
revoke all on table resource_bookings from anon, authenticated;
grant select, insert, update, delete on table resource_bookings to service_role;
alter table schedule_holds enable row level security;
revoke all on table schedule_holds from anon, authenticated;
grant select, insert, update, delete on table schedule_holds to service_role;
alter table leave_requests enable row level security;
revoke all on table leave_requests from anon, authenticated;
grant select, insert, update, delete on table leave_requests to service_role;
alter table leave_grants enable row level security;
revoke all on table leave_grants from anon, authenticated;
grant select, insert, update, delete on table leave_grants to service_role;
alter table holiday_works enable row level security;
revoke all on table holiday_works from anon, authenticated;
grant select, insert, update, delete on table holiday_works to service_role;
alter table work_report_days enable row level security;
revoke all on table work_report_days from anon, authenticated;
grant select, insert, update, delete on table work_report_days to service_role;
alter table tatami_production enable row level security;
revoke all on table tatami_production from anon, authenticated;
grant select, insert, update, delete on table tatami_production to service_role;
alter table promotions enable row level security;
revoke all on table promotions from anon, authenticated;
grant select, insert, update, delete on table promotions to service_role;
alter table office_improvements enable row level security;
revoke all on table office_improvements from anon, authenticated;
grant select, insert, update, delete on table office_improvements to service_role;
alter table condolences enable row level security;
revoke all on table condolences from anon, authenticated;
grant select, insert, update, delete on table condolences to service_role;
alter table change_notices enable row level security;
revoke all on table change_notices from anon, authenticated;
grant select, insert, update, delete on table change_notices to service_role;
alter table doc_drafts enable row level security;
revoke all on table doc_drafts from anon, authenticated;
grant select, insert, update, delete on table doc_drafts to service_role;
alter table case_posts enable row level security;
revoke all on table case_posts from anon, authenticated;
grant select, insert, update, delete on table case_posts to service_role;
alter table tidy_checks enable row level security;
revoke all on table tidy_checks from anon, authenticated;
grant select, insert, update, delete on table tidy_checks to service_role;
alter table source_items enable row level security;
revoke all on table source_items from anon, authenticated;
grant select, insert, update, delete on table source_items to service_role;
alter table source_texts enable row level security;
revoke all on table source_texts from anon, authenticated;
grant select, insert, update, delete on table source_texts to service_role;

-- 書き込みのたびにリビジョンを +1 (他のサーバーインスタンスが変更を検知して読み直す)
create or replace function public.bump_revision() returns bigint
language sql security definer set search_path = public as $$
  update app_meta set revision = revision + 1 where id = 1 returning revision;
$$;
revoke all on function public.bump_revision() from public, anon, authenticated;
grant execute on function public.bump_revision() to service_role;

-- 書き込んだ表と行の ID を記録して、リビジョンを +1 (1 つのトランザクション。記録のないリビジョンは「全件を読み直す」の合図)
create or replace function public.record_changes(p_changes jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare r bigint;
begin
  update app_meta set revision = revision + 1 where id = 1 returning revision into r;
  insert into app_changes (revision, changes) values (r, p_changes);
  delete from app_changes where revision <= r - 5000;
  return r;
end $$;
revoke all on function public.record_changes(jsonb) from public, anon, authenticated;
grant execute on function public.record_changes(jsonb) to service_role;

commit;

-- API (PostgREST) に新しいテーブル・列を知らせる
notify pgrst, 'reload schema';
