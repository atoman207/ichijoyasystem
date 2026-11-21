import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "@/components/ui/Link";
import { Activity, ArrowRight, Brain, Cpu, Database, FileInput, FileSearch, HardDrive, MonitorSmartphone, RefreshCw, Upload } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { BACKEND, getDb } from "@/lib/db/store";
import type { AuditAction, StoreId } from "@/lib/db/types";
import { canManageRegistry, canViewRegistry, knowledgeVisibilities } from "@/lib/auth/permissions";
import { AUDIT_ACTION_LABEL, ENTITY_LABEL } from "@/lib/constants";
import { KNOWLEDGE_VISIBILITY_LABEL } from "@/lib/knowledge";
import { fmtDateTime } from "@/lib/format";
import { ACTION_LABEL, REGISTRY_CATEGORIES } from "@/lib/registry/classify";
import { effAction, effCategory, effVisibility, listDocs, materialsStats, openMaterials, recentRuns, searchMaterials, type MaterialDoc } from "@/lib/registry/materials-db";
import { CATALOG_GROUPS, dataCatalog, dataStores } from "@/lib/registry/catalog";
import { ACTION_KEYS, ACTION_TONE, STATUS_LABEL, STORE_STATUS, VIS_KEYS, fmtBytes, num } from "./shared";
import { activityReport, jstParts } from "@/lib/registry/activity";
import { mirrorStatus } from "@/lib/datastore/mirror";
import { UPLOAD_EXTS } from "@/lib/registry/ingest";
import { MATERIAL_REF_PREFIX } from "@/lib/registry/promote";
import { syncAllMaterialKnowledge, uploadMaterials } from "@/lib/actions/registry";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Flash, Input, LinkTabs, Note, PageHeader, Pager, Select, Stat, Table, Td, Textarea, Th, Tr, type Paged } from "@/components/ui";

export const metadata: Metadata = { title: "データ台帳" };

type SP = Record<string, string | undefined>;
type Tab = "overview" | "materials" | "activity" | "intake";

const PAGE_SIZE = 50;

export default async function RegistryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canViewRegistry(user)) {
    return (
      <div>
        <PageHeader title="データ台帳" icon={<Database />} />
        <Note>データ台帳 (全データの一覧・クライアント資料・社内の活動) は本部スタッフ・管理者が見られます。クライアント資料の中身は「質問する」(AI アシスタント) で、見られる範囲の資料を探せます。</Note>
      </div>
    );
  }
  const db = getDb();
  const manage = canManageRegistry(user);
  const tab: Tab = sp.tab === "materials" || sp.tab === "activity" || (sp.tab === "intake" && manage) ? (sp.tab as Tab) : "overview";
  const mdb = openMaterials();
  const stats = mdb ? materialsStats(mdb) : undefined;
  const tabs = [
    { href: "/registry", label: "概要" },
    { href: "/registry?tab=materials", label: "資料", count: stats?.docs },
    { href: "/registry?tab=activity", label: "活動" },
    ...(manage ? [{ href: "/registry?tab=intake", label: "追加・同期" }] : []),
  ];
  const current = tab === "overview" ? "/registry" : `/registry?tab=${tab}`;
  const body: ReactNode = tab === "overview" ? await renderOverview() : tab === "materials" ? renderMaterials() : tab === "activity" ? renderActivity() : renderIntake();

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="データ台帳"
        icon={<Database />}
        description="システムのすべてのデータ・クライアントから受け取った資料・社内の活動を 1 か所で管理します。データは「入力 → 解読 → 記憶 → 実行 → 出力」の順にここを通り、AI アシスタントも同じデータで答えます"
      />
      <LinkTabs items={tabs} current={current} />
      {body}
    </div>
  );

  /* ================================================================ */
  /* 概要                                                              */
  /* ================================================================ */
  async function renderOverview() {
    const cat = dataCatalog(db);
    const { stores } = await dataStores(db, BACKEND);
    let mirror: { status: string; rows: number } | undefined;
    try {
      const m = mirrorStatus();
      mirror = { status: m.status, rows: m.tables.reduce((a, t) => a + t.rows, 0) };
    } catch {
      mirror = undefined;
    }
    const materialKnowledge = db.knowledge.filter((k) => k.sourceRef?.startsWith(MATERIAL_REF_PREFIX));
    const today = jstParts(new Date().toISOString()).date;
    const weekAgo = new Date(Date.now() - 6 * 86400_000);
    const from = jstParts(weekAgo.toISOString()).date;
    const recentAudit = db.auditLogs.filter((l) => {
      const d = jstParts(l.at).date;
      return d >= from && d <= today;
    }).length;
    const stages: { title: string; icon: ReactNode; desc: string; figures: [string, string][]; href?: string }[] = [
      {
        title: "入力",
        icon: <FileInput />,
        desc: "画面の入力・CSV/スプレッドシートの取込・LINE/FAX/メールの受信・クライアント資料",
        figures: [
          ["直近 7 日の操作", `${num(recentAudit)} 件`],
          ["クライアント資料", stats ? `${num(stats.docs)} ファイル` : "未読み取り"],
        ],
        href: "/registry?tab=activity",
      },
      {
        title: "解読",
        icon: <FileSearch />,
        desc: "表計算・Word・PDF を文字にして節に分け、分類・見られる人・個人情報を判定",
        figures: [
          ["検索の単位 (節)", stats ? `${num(stats.chunks)} 節` : "-"],
          ["取り込まない (個人情報)", stats ? `${num(stats.byAction.exclude ?? 0)} 件` : "-"],
        ],
        href: "/registry?tab=materials",
      },
      {
        title: "記憶",
        icon: <HardDrive />,
        desc: "Supabase (正本) → メモリ → VPS の写し・資料庫・ファイル",
        figures: [
          [BACKEND === "supabase" ? "Supabase" : "サンプルデータ", `${num(cat.totalRows)} 行`],
          ["VPS の写し", mirror ? `${num(mirror.rows)} 行 (${mirror.status === "ready" ? "同期済み" : mirror.status})` : "-"],
        ],
      },
      {
        title: "実行",
        icon: <Cpu />,
        desc: "集計・横断検索・SQL・資料庫の検索。AI アシスタントは道具を選んで計算する",
        figures: [
          ["社内資料 (資料から登録)", `${num(materialKnowledge.length)} 件`],
          ["社内資料 (全部)", `${num(db.knowledge.length)} 件`],
        ],
        href: "/knowledge",
      },
      {
        title: "出力",
        icon: <MonitorSmartphone />,
        desc: "画面・AI の回答・CSV/PDF・通知。どれも同じデータと権限で作る",
        figures: [
          ["表の数", `${num(cat.tables.length)} 表`],
          ["データのある表", `${num(cat.tables.filter((t) => t.rows > 0).length)} 表`],
        ],
        href: "/ai",
      },
    ];
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader title="データの流れ (中央処理の 5 段階)" icon={<Brain />} description="すべてのデータはこの順に処理されます。数字はいまの件数です" />
          <ol className="grid grid-cols-1 gap-3 @3xl:grid-cols-5">
            {stages.map((s, i) => (
              <li key={s.title} className="relative flex min-w-0 flex-col rounded-xl border border-line/70 bg-subtle p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent-ink [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
                    {s.icon}
                  </span>
                  <span>
                    {i + 1}. {s.title}
                  </span>
                  {i < stages.length - 1 && <ArrowRight className="ml-auto hidden h-4 w-4 text-ink-3 @3xl:block" aria-hidden />}
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">{s.desc}</p>
                <dl className="mt-2 space-y-1 text-xs">
                  {s.figures.map(([k, v]) => (
                    <div key={k} className="flex flex-wrap justify-between gap-x-2">
                      <dt className="text-ink-2">{k}</dt>
                      <dd className="font-semibold text-ink tnum">{v}</dd>
                    </div>
                  ))}
                </dl>
                {s.href && (
                  <Link href={s.href} className="mt-2 text-[11px] font-medium text-accent hover:underline">
                    詳しく見る
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </Card>

        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="データの置き場所" icon={<HardDrive />} description="正本 (Supabase) と、VPS のデータフォルダーにあるもの" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="bg-subtle text-left text-xs text-ink-2">
                  <th className="px-5 py-2 font-medium">名前</th>
                  <th className="px-3 py-2 font-medium">状態</th>
                  <th className="px-3 py-2 font-medium">内容</th>
                  <th className="px-3 py-2 text-right font-medium">大きさ</th>
                  <th className="px-5 py-2 font-medium">場所</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((s) => (
                  <tr key={s.key} className="border-t border-line align-top">
                    <td className="px-5 py-2">
                      <div className="font-medium text-ink">{s.name}</div>
                      <div className="text-[11px] text-ink-3">{s.role}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={STORE_STATUS[s.status].tone}>{STORE_STATUS[s.status].label}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-2">{s.detail}</td>
                    <td className="px-3 py-2 text-right text-xs tnum">{fmtBytes(s.bytes)}</td>
                    <td className="px-5 py-2 text-[11px] break-all text-ink-3">{s.location}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="システムの全データ (表ごと)" icon={<Database />} description={`${cat.tables.length} 表・${num(cat.totalRows)} 行。業務の日付の範囲は、受付日・施工日・発行日など表ごとの主な日付です`} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="bg-subtle text-left text-xs text-ink-2">
                  <th className="px-5 py-2 font-medium">表</th>
                  <th className="px-3 py-2 text-right font-medium">件数</th>
                  <th className="px-3 py-2 font-medium">業務の日付の範囲</th>
                  <th className="px-5 py-2 font-medium">最終更新</th>
                </tr>
              </thead>
              {CATALOG_GROUPS.map((g) => {
                const rows = cat.tables.filter((t) => t.group === g);
                if (!rows.length) return null;
                return (
                  <tbody key={g}>
                    <tr className="border-t border-line bg-panel">
                      <td colSpan={4} className="px-5 pt-3 pb-1 text-xs font-semibold text-accent-ink">
                        {g} ({num(rows.reduce((a, t) => a + t.rows, 0))} 行)
                      </td>
                    </tr>
                    {rows.map((t) => (
                      <tr key={t.table} className="border-t border-line/60">
                        <td className="px-5 py-1.5">
                          <span className={t.rows ? "text-ink" : "text-ink-3"}>{t.label}</span> <span className="text-[11px] text-ink-3">{t.table}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right tnum">{t.rows ? num(t.rows) : <span className="text-ink-3">0</span>}</td>
                        <td className="px-3 py-1.5 text-xs text-ink-2 tnum">{t.from ? `${t.from} 〜 ${t.to}` : "-"}</td>
                        <td className="px-5 py-1.5 text-xs text-ink-2 tnum">{t.updatedAt ? fmtDateTime(t.updatedAt) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                );
              })}
            </table>
          </div>
        </Card>
      </div>
    );
  }

  /* ================================================================ */
  /* 資料                                                              */
  /* ================================================================ */
  function renderMaterials() {
    if (!mdb || !stats) {
      return <Note tone="warn">資料庫がまだありません。サーバーで node scripts/registry/scan-materials.mjs を実行すると、クライアント資料を読み取って作ります。</Note>;
    }
    const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
    const pick = <T extends string>(v: string | undefined, list: readonly T[]) => (v && list.includes(v as T) ? (v as T) : undefined);
    const filter = {
      folder: sp.folder || undefined,
      action: pick(sp.act, ACTION_KEYS),
      category: pick(sp.cat, REGISTRY_CATEGORIES),
      status: pick(sp.status, Object.keys(STATUS_LABEL) as MaterialDoc["status"][]),
      visibility: pick(sp.vis, VIS_KEYS),
      q: sp.q?.trim() || undefined,
    };
    const { rows, total } = listDocs(mdb, { ...filter, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const paged: Paged<MaterialDoc> = { items: rows, page, pages, total, from: total ? (page - 1) * PAGE_SIZE + 1 : 0, to: (page - 1) * PAGE_SIZE + rows.length };
    const find = sp.find?.trim();
    const hits = find ? searchMaterials(mdb, find, { visibilities: knowledgeVisibilities(user), limit: 20 }) : [];
    const spForPager = { tab: "materials", folder: sp.folder, act: sp.act, cat: sp.cat, status: sp.status, vis: sp.vis, q: sp.q };

    return (
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
          <Stat label="資料 (ファイル)" value={num(stats.docs)} sub={`同じ内容 ${num(stats.duplicates)} 件はまとめて保存`} icon={<Database />} />
          <Stat label="社内資料に登録" value={num(stats.byAction.knowledge ?? 0)} sub={`節 ${num(stats.knowledgeSections)}`} icon={<Brain />} href="/registry?tab=materials&act=knowledge" />
          <Stat label="資料庫 (AI が検索)" value={num(stats.byAction.materials ?? 0)} sub={`${num(stats.chars)} 文字・節 ${num(stats.chunks)}`} icon={<FileSearch />} href="/registry?tab=materials&act=materials" />
          <Stat label="取り込まない (個人情報)" value={num(stats.byAction.exclude ?? 0)} sub={`取込済みのデータ ${num(stats.byAction.structured ?? 0)}・写真など ${num(stats.byAction.ledger ?? 0)}`} tone="warn" icon={<FileInput />} href="/registry?tab=materials&act=exclude" />
        </div>

        <Card>
          <CardHeader title="資料の中身を探す" icon={<FileSearch />} description="AI アシスタントと同じ全文検索です (見られる範囲の資料だけ)" />
          <form method="get" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="materials" />
            <div className="w-full @xl:w-96">
              <Input name="find" defaultValue={find} placeholder="例: 表替え 価格 / イベント 準備物 / elTAX" aria-label="資料の中身を探す" />
            </div>
            <Button type="submit" variant="secondary">
              探す
            </Button>
          </form>
          {find && (
            <div className="mt-4 space-y-2">
              {!hits.length && <p className="text-xs text-ink-3">「{find}」に当てはまる資料はありません。</p>}
              {hits.map((h) => (
                <div key={h.chunk.id} className="rounded-xl border border-line/70 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/registry/materials/${encodeURIComponent(h.doc.id)}`} className="text-sm font-medium text-accent hover:underline">
                      {h.chunk.head}
                    </Link>
                    <Badge tone={ACTION_TONE[effAction(h.doc)]} dot={false}>
                      {ACTION_LABEL[effAction(h.doc)]}
                    </Badge>
                    <span className="text-[11px] text-ink-3">{h.chunk.category || effCategory(h.doc)}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed break-words text-ink-2">{h.snippet}</p>
                  <p className="mt-0.5 truncate text-[11px] text-ink-3">
                    {h.doc.folderLabel || h.doc.folder} / {h.doc.path}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="materials" />
          <Select name="folder" defaultValue={sp.folder ?? ""} aria-label="フォルダ" className="w-auto">
            <option value="">すべてのフォルダ</option>
            {stats.byFolder.map((f) => (
              <option key={f.folder} value={f.folder}>
                {f.label || f.folder || "(直下)"} ({f.docs})
              </option>
            ))}
          </Select>
          <Select name="act" defaultValue={filter.action ?? ""} aria-label="扱い" className="w-auto">
            <option value="">すべての扱い</option>
            {ACTION_KEYS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]} ({stats.byAction[a] ?? 0})
              </option>
            ))}
          </Select>
          <Select name="cat" defaultValue={filter.category ?? ""} aria-label="分類" className="w-auto">
            <option value="">すべての分類</option>
            {stats.byCategory.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.docs})
              </option>
            ))}
          </Select>
          <Select name="status" defaultValue={filter.status ?? ""} aria-label="状態" className="w-auto">
            <option value="">すべての状態</option>
            {(Object.keys(STATUS_LABEL) as MaterialDoc["status"][]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s].label} ({stats.byStatus[s] ?? 0})
              </option>
            ))}
          </Select>
          <Select name="vis" defaultValue={filter.visibility ?? ""} aria-label="見られる人" className="w-auto">
            <option value="">すべての見られる人</option>
            {VIS_KEYS.map((v) => (
              <option key={v} value={v}>
                {KNOWLEDGE_VISIBILITY_LABEL[v]}
              </option>
            ))}
          </Select>
          <div className="w-full @xl:w-64">
            <Input name="q" defaultValue={sp.q} placeholder="ファイル名・分類・説明で絞る" aria-label="ファイル名で絞る" />
          </div>
          <Button type="submit" variant="secondary">
            表示
          </Button>
        </form>

        {rows.length === 0 ? (
          <EmptyState title="当てはまる資料はありません" icon={<Database />} />
        ) : (
          <>
            <Table minWidth="min-w-[980px]">
              <thead>
                <tr>
                  <Th>資料</Th>
                  <Th>扱い</Th>
                  <Th>分類</Th>
                  <Th>見られる人</Th>
                  <Th>状態</Th>
                  <Th align="right">文字数</Th>
                  <Th align="right">社内資料</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const act = effAction(d);
                  return (
                    <Tr key={d.id}>
                      <Td>
                        <div className="min-w-0 max-w-[420px]">
                          <Link href={`/registry/materials/${encodeURIComponent(d.id)}`} className="block truncate font-medium text-accent hover:underline">
                            {d.name}
                          </Link>
                          <div className="truncate text-[11px] text-ink-3">
                            {d.folderLabel || d.folder} / {d.path}
                          </div>
                          {d.duplicateOf && <div className="text-[11px] text-ink-3">同じ内容のファイルあり (中身は 1 か所に保存)</div>}
                        </div>
                      </Td>
                      <Td>
                        <Badge tone={ACTION_TONE[act]}>{ACTION_LABEL[act]}</Badge>
                        {d.override?.action && <div className="mt-0.5 text-[10px] text-ink-3">人が変更</div>}
                      </Td>
                      <Td className="text-xs">{effCategory(d)}</Td>
                      <Td className="text-xs">{KNOWLEDGE_VISIBILITY_LABEL[effVisibility(d)]}</Td>
                      <Td>
                        <Badge tone={STATUS_LABEL[d.status].tone} dot={false}>
                          {STATUS_LABEL[d.status].label}
                        </Badge>
                      </Td>
                      <Td align="right" className="text-xs tnum">
                        {d.chars ? num(d.chars) : "-"}
                      </Td>
                      <Td align="right" className="text-xs tnum">
                        {d.knowledgeIds.length || "-"}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager paged={paged} path="/registry" sp={spForPager} />
          </>
        )}

        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="フォルダごとの取込状況" icon={<FileInput />} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="bg-subtle text-left text-xs text-ink-2">
                  <th className="px-5 py-2 font-medium">フォルダ</th>
                  <th className="px-3 py-2 text-right font-medium">ファイル</th>
                  <th className="px-3 py-2 text-right font-medium">文字あり</th>
                  <th className="px-5 py-2 text-right font-medium">文字数</th>
                </tr>
              </thead>
              <tbody>
                {stats.byFolder.map((f) => (
                  <tr key={f.folder} className="border-t border-line">
                    <td className="px-5 py-1.5">
                      <Link href={`/registry?tab=materials&folder=${encodeURIComponent(f.folder)}`} className="text-accent hover:underline">
                        {f.label || f.folder || "(直下)"}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 text-right tnum">{num(f.docs)}</td>
                    <td className="px-3 py-1.5 text-right tnum">{num(f.ok)}</td>
                    <td className="px-5 py-1.5 text-right tnum">{num(f.chars)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  }

  /* ================================================================ */
  /* 活動                                                              */
  /* ================================================================ */
  function renderActivity() {
    const userId = db.users.some((u) => u.id === sp.user) ? sp.user : undefined;
    const storeId = db.stores.some((s) => s.id === sp.store) ? (sp.store as StoreId) : undefined;
    const action = sp.action && sp.action in AUDIT_ACTION_LABEL ? (sp.action as AuditAction) : undefined;
    const entity = sp.entity && sp.entity in ENTITY_LABEL ? sp.entity : undefined;
    const r = activityReport(db, user, { from: sp.from, to: sp.to, userId, storeId, entity, action, q: sp.aq, limit: 100 });
    const maxDay = Math.max(1, ...r.byDay.map((d) => d.count));
    const maxHour = Math.max(1, ...r.byHour);
    const list = (title: string, rows: { key: string; label: string; count: number; href?: string }[]) => (
      <Card>
        <CardHeader title={title} />
        {rows.length ? (
          <ul className="space-y-1 text-sm">
            {rows.slice(0, 12).map((x) => (
              <li key={x.key} className="flex justify-between gap-2">
                {x.href ? (
                  <Link href={x.href} className="truncate text-accent hover:underline">
                    {x.label}
                  </Link>
                ) : (
                  <span className="truncate text-ink">{x.label}</span>
                )}
                <span className="shrink-0 font-semibold tnum">{num(x.count)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">なし</p>
        )}
      </Card>
    );
    const base = (extra: Record<string, string>) => {
      const q = new URLSearchParams({ tab: "activity", from: r.from, to: r.to, ...extra });
      return `/registry?${q.toString()}`;
    };
    return (
      <div className="space-y-5">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="activity" />
          <Field label="から">
            <Input type="date" name="from" defaultValue={r.from} />
          </Field>
          <Field label="まで">
            <Input type="date" name="to" defaultValue={r.to} />
          </Field>
          <Field label="人">
            <Select name="user" defaultValue={userId ?? ""}>
              <option value="">全員</option>
              {db.users
                .filter((u) => u.active !== false)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="店舗">
            <Select name="store" defaultValue={storeId ?? ""}>
              <option value="">すべて</option>
              {db.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="操作">
            <Select name="action" defaultValue={action ?? ""}>
              <option value="">すべて</option>
              {(Object.keys(AUDIT_ACTION_LABEL) as AuditAction[]).map((a) => (
                <option key={a} value={a}>
                  {AUDIT_ACTION_LABEL[a]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="対象">
            <Select name="entity" defaultValue={entity ?? ""}>
              <option value="">すべて</option>
              {Object.entries(ENTITY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="言葉">
            <Input name="aq" defaultValue={sp.aq} placeholder="要約・対象の名前" />
          </Field>
          <Button type="submit" variant="secondary">
            表示
          </Button>
        </form>
        {r.scoped && <Note>あなたの閲覧の範囲 (所属店舗と本人の操作) だけを数えています。</Note>}

        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
          <Stat label={`操作 (${r.from} 〜 ${r.to})`} value={num(r.total)} icon={<Activity />} />
          <Stat label="削除" value={num(r.notable.deletes)} tone={r.notable.deletes ? "warn" : undefined} sub={`取込 ${num(r.notable.imports)}・書き出し ${num(r.notable.exports)}`} href={base({ action: "delete" })} />
          <Stat label="承認・却下" value={`${num(r.notable.approvals)} / ${num(r.notable.rejects)}`} sub={`ログイン ${num(r.notable.logins)}`} />
          <Stat
            label="業務時間外 (7 時前・20 時以降)"
            value={num(r.notable.offHours)}
            tone={r.notable.offHours ? "warn" : undefined}
            sub={r.notable.failedDeliveries !== undefined ? `送信 ${num(r.notable.sentDeliveries ?? 0)} (失敗 ${num(r.notable.failedDeliveries)})` : undefined}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3">
          {list("人", r.byUser.map((x) => ({ key: x.userId, label: x.name, count: x.count, href: db.users.some((u) => u.id === x.userId) ? base({ user: x.userId }) : undefined })))}
          {list("対象", r.byEntity.map((x) => ({ key: x.entity, label: x.label, count: x.count, href: base({ entity: x.entity }) })))}
          {list("操作の種類", r.byAction.map((x) => ({ key: x.action, label: x.label, count: x.count, href: base({ action: x.action }) })))}
        </div>

        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
          <Card>
            <CardHeader title="日ごとの操作" />
            <ul className="space-y-1">
              {r.byDay.slice(-62).map((d) => (
                <li key={d.date} className="flex items-center gap-2 text-xs">
                  <span className="w-20 shrink-0 text-ink-2 tnum">{d.date.slice(5)}</span>
                  <span className="relative h-3 flex-1 overflow-hidden rounded-full bg-subtle" aria-hidden>
                    <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${(d.count / maxDay) * 100}%` }} />
                  </span>
                  <span className="w-10 shrink-0 text-right font-medium tnum">{d.count}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="時間帯 (日本時間)" description="色の薄い時間は業務時間外 (7 時前・20 時以降)" />
            <ul className="space-y-1">
              {r.byHour.map((n, h) => (
                <li key={h} className="flex items-center gap-2 text-xs">
                  <span className="w-12 shrink-0 text-ink-2 tnum">{h} 時</span>
                  <span className="relative h-3 flex-1 overflow-hidden rounded-full bg-subtle" aria-hidden>
                    <span className={`absolute inset-y-0 left-0 rounded-full ${h < 7 || h >= 20 ? "bg-warn" : "bg-accent"}`} style={{ width: `${(n / maxHour) * 100}%` }} />
                  </span>
                  <span className="w-10 shrink-0 text-right font-medium tnum">{n}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="最近の操作" description={`新しい順に ${r.recent.length} 件。すべての履歴は変更履歴の画面で見られます`} action={<Link href="/audit" className="text-xs font-medium text-accent hover:underline">変更履歴を開く</Link>} />
          </div>
          {r.recent.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="bg-subtle text-left text-xs text-ink-2">
                    <th className="px-5 py-2 font-medium">日時</th>
                    <th className="px-3 py-2 font-medium">人</th>
                    <th className="px-3 py-2 font-medium">操作</th>
                    <th className="px-5 py-2 font-medium">内容</th>
                  </tr>
                </thead>
                <tbody>
                  {r.recent.map((x, i) => (
                    <tr key={`${x.at}-${i}`} className="border-t border-line align-top">
                      <td className="px-5 py-1.5 text-xs whitespace-nowrap text-ink-2 tnum">{fmtDateTime(x.at)}</td>
                      <td className="px-3 py-1.5 text-xs whitespace-nowrap">{x.userName}</td>
                      <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                        <Badge tone={x.action === "delete" ? "warn" : x.action === "approve" ? "good" : x.action === "reject" ? "critical" : "neutral"} dot={false}>
                          {x.actionLabel}
                        </Badge>{" "}
                        <span className="text-ink-3">{x.entityLabel}</span>
                      </td>
                      <td className="px-5 py-1.5 text-xs">
                        {x.href ? (
                          <Link href={x.href} className="font-medium text-accent hover:underline">
                            {x.target}
                          </Link>
                        ) : (
                          <span className="font-medium text-ink">{x.target}</span>
                        )}
                        <div className="text-ink-2">{x.summary}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-5 pb-5 text-xs text-ink-3">この条件の操作はありません。</p>
          )}
        </Card>
      </div>
    );
  }

  /* ================================================================ */
  /* 追加・同期                                                         */
  /* ================================================================ */
  function renderIntake() {
    if (!mdb) {
      return <Note tone="warn">資料庫を開けません。ICHIJOYA_MATERIALS_DB_PATH の設定を確かめてください。</Note>;
    }
    const runs = recentRuns(mdb, 15);
    const RUN_LABEL: Record<string, string> = { scan: "クライアント資料の読み取り", promote: "社内資料をそろえる", upload: "資料の追加" };
    const runSummary = (s: Record<string, unknown>) =>
      Object.entries(s)
        .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
        .slice(0, 8)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join("・");
    return (
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          <Card>
            <CardHeader title="資料を追加する" icon={<Upload />} description="クライアントから新しく届いた資料を読み取り、資料庫に入れます。AI アシスタントがすぐに探せるようになります" />
            <form action={uploadMaterials} className="space-y-3">
              <input type="hidden" name="back" value="/registry?tab=intake" />
              <Field label="ファイル (複数可・合計 4 MB まで)" hint={`読み取れる形式: ${UPLOAD_EXTS.join("・")}。.xls・.doc は新しい形式 (.xlsx・.docx) で保存し直してください`} required>
                <input type="file" name="files" multiple required accept={UPLOAD_EXTS.map((e) => `.${e}`).join(",")} className="block w-full text-sm" />
              </Field>
              <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                <Field label="見られる人" hint="AI の回答にも同じ範囲で使います">
                  <Select name="visibility" defaultValue="hq">
                    {VIS_KEYS.map((v) => (
                      <option key={v} value={v}>
                        {KNOWLEDGE_VISIBILITY_LABEL[v]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="分類" hint="空欄なら名前と中身から推定します">
                  <Select name="category" defaultValue="">
                    <option value="">自動 (名前と中身から)</option>
                    {REGISTRY_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input type="checkbox" name="promote" value="1" className="mt-1" />
                <span>
                  社内資料にも登録する
                  <span className="block text-xs text-ink-3">マニュアル・ルール・議事録など、AI に最優先で使わせたい資料のとき。シート・節ごとに社内資料になります</span>
                </span>
              </label>
              <Field label="メモ (任意)">
                <Textarea name="note" rows={2} maxLength={300} placeholder="例: 2026 年 11 月に本部から届いた価格表" />
              </Field>
              <Button type="submit">
                <Upload />
                追加する
              </Button>
            </form>
          </Card>

          <Card padded={false}>
            <div className="px-5 pt-5">
              <CardHeader title="処理の記録" icon={<RefreshCw />} description="読み取り・社内資料の同期・資料の追加の履歴 (新しい順)" />
            </div>
            {runs.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead>
                    <tr className="bg-subtle text-left text-xs text-ink-2">
                      <th className="px-5 py-2 font-medium">日時</th>
                      <th className="px-3 py-2 font-medium">処理</th>
                      <th className="px-3 py-2 font-medium">実行</th>
                      <th className="px-5 py-2 font-medium">結果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className="border-t border-line align-top">
                        <td className="px-5 py-1.5 text-xs whitespace-nowrap text-ink-2 tnum">{fmtDateTime(r.at)}</td>
                        <td className="px-3 py-1.5 text-xs whitespace-nowrap">{RUN_LABEL[r.kind] ?? r.kind}</td>
                        <td className="px-3 py-1.5 text-xs whitespace-nowrap">{r.by === "script" ? "スクリプト" : (db.users.find((u) => u.id === r.by)?.name ?? r.by ?? "-")}</td>
                        <td className="px-5 py-1.5 text-[11px] break-all text-ink-2">{runSummary(r.summary)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-5 pb-5 text-xs text-ink-3">まだ記録がありません。</p>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="社内資料をそろえる" icon={<Brain />} description="資料庫で「社内資料に登録」の資料の節を、社内資料 (AI の回答の根拠) と同じ内容にそろえます。扱いを変えた資料の社内資料は消します" />
            <form action={syncAllMaterialKnowledge}>
              <input type="hidden" name="back" value="/registry?tab=intake" />
              <Button type="submit" variant="secondary">
                <RefreshCw />
                いますぐそろえる
              </Button>
            </form>
          </Card>
          <Note>
            クライアント資料は、サーバーのフォルダー source/ に分野ごと (01_社内ルール・マニュアル 〜 99_その他。決まりは source/README.md) に置いています。新しい資料は合う分野のフォルダーに置き、まとめて読むときはサーバーで次の順に実行します。
            <br />1. node scripts/registry/scan-materials.mjs (読み取り・分類。変わったファイルだけ)
            <br />2. node scripts/registry/sync-supabase.mjs --apply (Supabase に登録: source/ の全ファイル・全フォルダーと文書の中身。画像・動画・フォルダーは場所だけ)
            <br />3. node scripts/registry/promote-knowledge.mjs --apply (社内資料に登録)
            <br />
            個人の情報 (健康・ご家族・給与・就労証明など) のファイルは内容を取り込みません (15_人事・労務 の「個人の情報（取り込まない）」に置きます)。
          </Note>
        </div>
      </div>
    );
  }
}
