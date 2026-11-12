import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { Camera, ExternalLink, FileSpreadsheet, FileText, FolderOpen, Image as ImageIcon, Video } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canViewSourceFiles, scopeByStore } from "@/lib/auth/permissions";
import type { SourceFile } from "@/lib/db/types";
import { fmtDate } from "@/lib/format";
import { Badge, Card, CardHeader, EmptyState, Flash, Input, LinkTabs, PageHeader, Pager, Select, StoreTag, Table, Td, Th, Tr, paginate } from "@/components/ui";

export const metadata: Metadata = { title: "資料・写真" };

type SP = Record<string, string | undefined>;

const KIND_LABEL: Record<SourceFile["kind"], string> = {
  spreadsheet: "表計算",
  document: "文書",
  pdf: "PDF",
  image: "画像",
  media: "動画・音声",
  other: "その他",
};
const KIND_ICON = { spreadsheet: FileSpreadsheet, document: FileText, pdf: FileText, image: ImageIcon, media: Video, other: FolderOpen } as const;

function size(bytes?: number): string {
  if (!bytes) return "-";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default async function MaterialsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const filesAllowed = canViewSourceFiles(user);
  const tab = sp.tab === "files" && filesAllowed ? "files" : sp.tab === "summary" && filesAllowed ? "summary" : "photos";
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const customerMap = new Map(db.customers.map((c) => [c.id, c]));
  // 写真台帳はお客様の情報を含むため、店舗ロールは自店舗分のみ
  const albums = scopeByStore(user, db.photoAlbums);

  const tabs = [
    { href: "/materials", label: "現場写真台帳", count: albums.length },
    ...(filesAllowed
      ? [
          { href: "/materials?tab=files", label: "資料台帳", count: db.sourceFiles.length },
          { href: "/materials?tab=summary", label: "取込状況" },
        ]
      : []),
  ];
  const current = tab === "photos" ? "/materials" : `/materials?tab=${tab}`;

  // 資料台帳
  const folders = [...new Map(db.sourceFiles.map((f) => [f.folder, f.folderName])).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let files = db.sourceFiles;
  if (sp.folder) files = files.filter((f) => f.folder === sp.folder);
  if (sp.kind) files = files.filter((f) => f.kind === sp.kind);
  if (sp.imported === "1") files = files.filter((f) => f.importedTo);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) files = files.filter((f) => `${f.path} ${f.importedTo ?? ""}`.toLowerCase().includes(q));
  const paged = paginate(files, sp.page, 100);

  // 取込状況
  const summary = folders.map(([folder, name]) => {
    const list = db.sourceFiles.filter((f) => f.folder === folder);
    const imported = list.filter((f) => f.importedTo);
    const targets = [...new Set(imported.map((f) => f.importedTo!))];
    return { folder, name, files: list.length, bytes: list.reduce((a, f) => a + (f.bytes ?? 0), 0), imported: imported.length, failed: list.filter((f) => f.status !== "downloaded").length, targets };
  });

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="資料・写真"
        icon={<FolderOpen />}
        description="Google ドライブで共有されている業務資料と現場写真の台帳です。画像・資料の本体はドライブに置いたまま、どのデータに取り込んだかを記録しています"
      />
      <LinkTabs items={tabs} current={current} />

      {tab === "photos" &&
        (albums.length === 0 ? (
          <EmptyState title="写真台帳はまだありません" icon={<Camera />} />
        ) : (
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {[...albums]
              .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
              .map((a) => {
                const c = a.customerId ? customerMap.get(a.customerId) : undefined;
                return (
                  <Card key={a.id}>
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink" aria-hidden>
                        <Camera className="h-5 w-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-ink">{a.customerName ? `${a.customerName}` : a.title}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
                          <span className="tnum">{a.date ? fmtDate(a.date) : "日付不明"}</span>
                          {a.area && <span>{a.area}</span>}
                          <StoreTag store={storeMap.get(a.storeId)} short />
                        </div>
                      </div>
                      <Badge tone="accent" dot={false}>
                        {a.photoCount} 枚
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                      {c && canAccessStore(user, c.storeId) ? (
                        <Link href={`/customers/${c.id}`} className="font-medium text-accent hover:underline">
                          顧客 {c.code} {c.name}
                        </Link>
                      ) : c ? (
                        <span className="text-ink-3">顧客 {c.code}</span>
                      ) : (
                        <span className="text-ink-3">顧客台帳との対応なし</span>
                      )}
                      {a.driveUrl && (
                        <a href={a.driveUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 font-medium text-accent hover:underline">
                          Google ドライブで開く
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        </a>
                      )}
                    </div>
                    <p className="mt-2 truncate text-[11px] text-ink-3">{a.sampleFiles.join(" · ")}</p>
                  </Card>
                );
              })}
          </div>
        ))}

      {tab === "files" && (
        <>
          <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="files" />
            <Select name="folder" defaultValue={sp.folder ?? ""} aria-label="フォルダ" className="w-auto">
              <option value="">すべてのフォルダ</option>
              {folders.map(([f, n]) => (
                <option key={f} value={f}>
                  {f.slice(0, 2)} {n}
                </option>
              ))}
            </Select>
            <Select name="kind" defaultValue={sp.kind ?? ""} aria-label="種類" className="w-auto">
              <option value="">すべての種類</option>
              {(Object.keys(KIND_LABEL) as SourceFile["kind"][]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
            <label className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-sm text-ink-2">
              <input type="checkbox" name="imported" value="1" defaultChecked={sp.imported === "1"} />
              取込済みのみ
            </label>
            <div className="w-full @xl:w-72">
              <Input name="q" defaultValue={sp.q} placeholder="ファイル名・フォルダで検索" />
            </div>
            <button type="submit" className="inline-flex h-10 items-center rounded-lg border border-line bg-panel px-4 text-sm font-medium text-ink hover:bg-subtle">
              表示
            </button>
          </form>
          <Table minWidth="min-w-[860px]">
            <thead>
              <tr>
                <Th>ファイル</Th>
                <Th>種類</Th>
                <Th align="right">サイズ</Th>
                <Th>更新日</Th>
                <Th>システムへの取込</Th>
                <Th align="right">元ファイル</Th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((f) => {
                const Icon = KIND_ICON[f.kind];
                return (
                  <Tr key={f.id}>
                    <Td>
                      <div className="flex min-w-0 items-start gap-2">
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink">{f.name}</div>
                          <div className="truncate text-[11px] text-ink-3">
                            {f.folderName} / {f.path}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td className="text-xs">{KIND_LABEL[f.kind]}</Td>
                    <Td align="right" className="text-xs tnum">
                      {size(f.bytes)}
                    </Td>
                    <Td className="text-xs tnum">{f.modifiedOn ? fmtDate(f.modifiedOn) : "-"}</Td>
                    <Td className="text-xs">{f.importedTo ? <Badge tone="good">{f.importedTo}</Badge> : f.status !== "downloaded" ? <Badge tone="warn">取得できず</Badge> : <span className="text-ink-3">台帳に記録のみ</span>}</Td>
                    <Td align="right" className="text-xs">
                      {f.driveUrl ? (
                        <a href={f.driveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                          ドライブ
                          <ExternalLink className="h-3 w-3" aria-hidden />
                        </a>
                      ) : (
                        "-"
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
          <Pager paged={paged} path="/materials" sp={sp} />
        </>
      )}

      {tab === "summary" && (
        <div className="grid grid-cols-1 gap-4">
          <Card>
            <CardHeader title="フォルダごとの取込状況" description="共有された 9 フォルダのファイル数と、システムのどのデータに取り込んだか" />
            <Table className="rounded-none border-0 shadow-none" minWidth="min-w-[760px]">
              <thead>
                <tr>
                  <Th>フォルダ</Th>
                  <Th align="right">ファイル</Th>
                  <Th align="right">容量</Th>
                  <Th align="right">取込</Th>
                  <Th>取込先</Th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => (
                  <Tr key={s.folder}>
                    <Td>
                      <Link href={`/materials?tab=files&folder=${encodeURIComponent(s.folder)}`} className="font-medium text-accent hover:underline">
                        {s.folder.slice(0, 2)} {s.name}
                      </Link>
                      {s.failed > 0 && <div className="text-[11px] text-warn-ink">取得できなかったファイル {s.failed} 件</div>}
                    </Td>
                    <Td align="right" className="tnum">
                      {s.files.toLocaleString("ja-JP")}
                    </Td>
                    <Td align="right" className="tnum">
                      {size(s.bytes)}
                    </Td>
                    <Td align="right" className="tnum">
                      {s.imported.toLocaleString("ja-JP")}
                    </Td>
                    <Td className="text-xs">{s.targets.length ? s.targets.join(" / ") : <span className="text-ink-3">台帳に記録のみ (画像・資料はドライブで閲覧)</span>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card>
            <CardHeader title="取り込んだデータ" />
            <dl className="grid grid-cols-2 gap-3 text-sm @2xl:grid-cols-4">
              {[
                ["社員", db.users.length],
                ["顧客", db.customers.length],
                ["受注 (売上台帳)", db.orders.length],
                ["問い合わせ (TEL待ち等)", db.inquiries.length],
                ["予定 (予定表)", db.schedule.length],
                ["お客様アンケート", db.surveys.length],
                ["休業日", db.holidays.length],
                ["現場写真台帳", db.photoAlbums.length],
              ].map(([k, v]) => (
                <div key={String(k)} className="rounded-xl bg-subtle/60 px-3 py-2">
                  <dt className="text-xs text-ink-3">{k}</dt>
                  <dd className="mt-0.5 text-lg font-semibold text-ink tnum">{Number(v).toLocaleString("ja-JP")}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      )}
    </div>
  );
}
