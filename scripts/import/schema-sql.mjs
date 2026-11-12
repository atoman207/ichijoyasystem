/**
 * テーブル定義の SQL を組み立てる (generate-schema.mjs と generate-data-sql.mjs で共通)
 * 元: src/lib/db/schema.ts
 *
 * - 何度実行しても同じ結果になる (create ... if not exists / add column if not exists)。既存のデータは消さない
 * - 列の削除・型の変更は自動では行わない (手動で移行 SQL を書く)
 * - すべてのテーブルで RLS を有効にし、ポリシーは作らない (= publishable キーからは読めない)。
 *   アプリはサーバー側で secret キーを使って読み書きする
 */
import { META_TABLE, TABLES, snake } from "../../src/lib/db/schema.ts";

const q = (s) => s.replace(/'/g, "''");

/** @param {{ header?: boolean }} [opts] header: false で先頭の説明コメントを省く (1 つのファイルにまとめるとき) */
export function buildSchemaSql({ header = true } = {}) {
  const lines = [];
  if (header) {
    lines.push("-- ============================================================");
    lines.push("-- 一畳屋 統合業務システム データベース定義 (Supabase / PostgreSQL)");
    lines.push("-- 自動生成: node scripts/import/generate-schema.mjs (元: src/lib/db/schema.ts)");
    lines.push("-- 何度実行しても安全 (既存のテーブル・データは消さない)");
    lines.push("-- ============================================================");
    lines.push("");
  }
  lines.push("begin;");
  lines.push("");
  lines.push(`-- アプリ全体のメタ情報 (データ形式のバージョン・更新リビジョン)`);
  lines.push(`create table if not exists ${META_TABLE} (`);
  lines.push("  id integer primary key check (id = 1),");
  lines.push("  version integer not null default 3,");
  lines.push("  revision bigint not null default 0,");
  lines.push("  seeded_at timestamptz,");
  lines.push("  source text,");
  lines.push("  imported_at timestamptz");
  lines.push(");");
  lines.push(`insert into ${META_TABLE} (id) values (1) on conflict (id) do nothing;`);
  lines.push(`comment on table ${META_TABLE} is 'アプリ全体のメタ情報 (データ形式のバージョンと、インスタンス間の更新検知用リビジョン)';`);
  lines.push("");

  for (const t of TABLES) {
    lines.push(`-- ${t.label}`);
    lines.push(`create table if not exists ${t.table} (`);
    lines.push(t.columns.map(([name, spec]) => `  ${snake(name)} ${spec}`).join(",\n"));
    lines.push(");");
    lines.push(`comment on table ${t.table} is '${q(t.label)}';`);
    for (const cols of t.indexes ?? []) lines.push(`create index if not exists ${t.table}_${cols.join("_")}_idx on ${t.table} (${cols.join(", ")});`);
    lines.push("");
  }

  lines.push("-- 既存のテーブルに後から追加した列 (schema.ts に列を足したとき、作成済みのテーブルへ反映する)");
  lines.push("-- 注意: not null で既定値のない列を、行があるテーブルへ追加すると失敗する。その場合は既定値を付けるか、手動で移行する");
  for (const t of TABLES) {
    for (const [name, spec] of t.columns) {
      if (/primary key/.test(spec)) continue;
      lines.push(`alter table ${t.table} add column if not exists ${snake(name)} ${spec};`);
    }
  }
  lines.push("");
  lines.push("-- 行レベルセキュリティ: 有効化のみ (ポリシーなし)。publishable / anon キーからはアクセスできない");
  lines.push("-- アプリが使う secret キー (service_role) には読み書きの権限を明示的に付ける (プロジェクトの既定の権限に頼らない)");
  lines.push("grant usage on schema public to service_role;");
  for (const t of [{ table: META_TABLE }, ...TABLES]) {
    lines.push(`alter table ${t.table} enable row level security;`);
    lines.push(`revoke all on table ${t.table} from anon, authenticated;`);
    lines.push(`grant select, insert, update, delete on table ${t.table} to service_role;`);
  }
  lines.push("");
  lines.push("-- 書き込みのたびにリビジョンを +1 (他のサーバーインスタンスが変更を検知して読み直す)");
  lines.push("create or replace function public.bump_revision() returns bigint");
  lines.push("language sql security definer set search_path = public as $$");
  lines.push(`  update ${META_TABLE} set revision = revision + 1 where id = 1 returning revision;`);
  lines.push("$$;");
  lines.push("revoke all on function public.bump_revision() from public, anon, authenticated;");
  lines.push("grant execute on function public.bump_revision() to service_role;");
  lines.push("");
  lines.push("commit;");
  lines.push("");
  lines.push("-- API (PostgREST) に新しいテーブル・列を知らせる");
  lines.push("notify pgrst, 'reload schema';");
  lines.push("");
  return lines.join("\n");
}

export const TABLE_COUNT = TABLES.length + 1;
