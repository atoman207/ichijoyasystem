import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { BookOpen, Database, ExternalLink, FileText, Settings2, ShieldAlert, Trash2 } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageRegistry, canViewKnowledge, canViewRegistry, knowledgeVisibilities } from "@/lib/auth/permissions";
import { KNOWLEDGE_VISIBILITY_LABEL } from "@/lib/knowledge";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { ACTION_LABEL, REGISTRY_CATEGORIES } from "@/lib/registry/classify";
import { effAction, effCategory, effVisibility, getChunks, getDoc, openMaterials } from "@/lib/registry/materials-db";
import { materialIdOf } from "@/lib/registry/promote";
import { deleteMaterial, updateMaterial } from "@/lib/actions/registry";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Note, PageHeader, Select, Textarea } from "@/components/ui";
import { ACTION_KEYS, ACTION_TONE, STATUS_LABEL, VIS_KEYS, fmtBytes, num } from "../../shared";

export const metadata: Metadata = { title: "資料 (データ台帳)" };

const MAX_CHUNKS = 40;

export default async function MaterialPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id: rawId } = await params;
  const sp = await searchParams;
  const id = decodeURIComponent(rawId);
  const user = await requireUser();
  const back = { href: "/registry?tab=materials", label: "データ台帳" };
  if (!canViewRegistry(user)) {
    return (
      <div>
        <PageHeader title="資料" back={back} icon={<Database />} />
        <Note>データ台帳は本部スタッフ・管理者が見られます。</Note>
      </div>
    );
  }
  const mdb = openMaterials();
  const doc = mdb ? getDoc(mdb, id) : undefined;
  if (!mdb || !doc) {
    return (
      <div>
        <PageHeader title="資料が見つかりません" back={back} icon={<Database />} />
        <Note tone="warn">{mdb ? "この資料は資料庫にありません (読み取りでなくなった・消された可能性があります)。" : "資料庫を開けません。"}</Note>
      </div>
    );
  }
  const db = getDb();
  const manage = canManageRegistry(user);
  const vis = knowledgeVisibilities(user);
  const chunks = getChunks(mdb, id);
  const act = effAction(doc);
  const docVis = effVisibility(doc);
  const sourceFile = db.sourceFiles.find((f) => f.id === id);
  const knowledge = db.knowledge.filter((k) => materialIdOf(k) === id);
  const visibleKnowledge = knowledge.filter((k) => canViewKnowledge(user, k));
  const duplicateOf = doc.duplicateOf ? getDoc(mdb, doc.duplicateOf) : undefined;
  const store = doc.storeId ? db.stores.find((s) => s.id === doc.storeId) : undefined;
  const overBy = doc.override?.by ? (db.users.find((u) => u.id === doc.override!.by)?.name ?? doc.override.by) : undefined;
  const selfHref = `/registry/materials/${encodeURIComponent(id)}`;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={doc.name}
        back={back}
        icon={<FileText />}
        badge={
          <span className="flex flex-wrap gap-1.5">
            <Badge tone={ACTION_TONE[act]}>{ACTION_LABEL[act]}</Badge>
            <Badge tone={STATUS_LABEL[doc.status].tone} dot={false}>
              {STATUS_LABEL[doc.status].label}
            </Badge>
          </span>
        }
        description={`${doc.folderLabel || doc.folder} / ${doc.path}`}
      />

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="min-w-0 space-y-4 @4xl:col-span-2">
          <Card>
            <CardHeader title="資料の情報" icon={<Database />} />
            <Dl
              columns={3}
              items={[
                ["扱い", ACTION_LABEL[act]],
                ["分類", effCategory(doc)],
                ["見られる人", KNOWLEDGE_VISIBILITY_LABEL[docVis]],
                ["状態", STATUS_LABEL[doc.status].label],
                ["文字数", doc.chars ? num(doc.chars) : "-"],
                ["節 (検索の単位)", chunks.length ? num(chunks.length) : "-"],
                ["種類", `${doc.kind}${doc.ext ? ` (.${doc.ext})` : ""}`],
                ["大きさ", fmtBytes(doc.bytes)],
                ["更新日", doc.mtime ? fmtDate(doc.mtime) : "-"],
                ["店舗", store?.name ?? "-"],
                ["資料の日付", doc.recordDate ? fmtDate(doc.recordDate) : "-"],
                ["読み取り", doc.scannedAt ? fmtDateTime(doc.scannedAt) : "-"],
                ["取り込み先 (システムのデータ)", doc.importedTo ?? "-"],
                ["元", doc.origin === "upload" ? "画面から追加した資料" : "クライアント資料"],
                [
                  "元のファイル",
                  doc.driveUrl ? (
                    <a href={doc.driveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                      Google ドライブで開く <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </a>
                  ) : doc.origin === "upload" && doc.storageKey ? (
                    "サーバーに保存済み"
                  ) : (
                    "-"
                  ),
                ],
              ]}
            />
            {duplicateOf && (
              <p className="mt-3 text-xs text-ink-2">
                同じ内容のファイルがあるため、中身は{" "}
                <Link href={`/registry/materials/${encodeURIComponent(duplicateOf.id)}`} className="text-accent hover:underline">
                  {duplicateOf.folderLabel || duplicateOf.folder} / {duplicateOf.path}
                </Link>{" "}
                に保存しています。
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="この扱いになった理由" icon={<ShieldAlert />} />
            <ul className="space-y-1.5 text-sm text-ink">
              <li>{doc.note ?? "-"}</li>
              <li className="text-xs text-ink-3">規則: {doc.ruleId ?? "-"}</li>
              {doc.pii?.reason && (
                <li>
                  <Badge tone="warn">個人情報らしいもの</Badge> <span className="text-xs text-ink-2">{doc.pii.reason} のため、その節の見られる人を上げました</span>
                </li>
              )}
              {doc.pii && !doc.pii.reason && (
                <li className="text-xs text-ink-3">
                  電話番号 {doc.pii.phones}・メール {doc.pii.emails}・郵便番号 {doc.pii.postal} 件 (見られる人は上げていません)
                </li>
              )}
              {doc.error && <li className="text-xs text-critical-ink">読み取りの誤り: {doc.error}</li>}
              {doc.override && (
                <li className="text-xs text-ink-2">
                  人が扱いを変えています{overBy ? ` (${overBy}${doc.override.at ? `・${fmtDateTime(doc.override.at)}` : ""})` : ""}
                  {doc.override.note ? `: ${doc.override.note}` : ""}
                </li>
              )}
            </ul>
            {doc.sheetNames.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-1.5 text-xs font-semibold text-ink-2">シート・節 ({doc.sheetNames.length})</h3>
                <div className="flex flex-wrap gap-1.5">
                  {doc.sheetNames.slice(0, 200).map((s, i) => (
                    <Badge key={`${s.name}-${i}`} tone={s.kept ? "accent" : "neutral"} dot={false}>
                      {s.name}
                      {s.rows !== undefined ? ` (${s.rows} 行)` : ""}
                      {s.kept ? "" : " ・取り込まない"}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title={`中身 (節 ${chunks.length})`} icon={<FileText />} description={chunks.length > MAX_CHUNKS ? `最初の ${MAX_CHUNKS} 節を表示しています` : "AI アシスタントが検索・引用する単位です"} />
            {chunks.length === 0 ? (
              <p className="text-xs text-ink-3">{act === "exclude" ? "取り込まない資料のため、中身は保存していません。" : doc.status === "empty" ? "文字のない資料 (写真・画像の PDF など) です。" : "中身はありません。"}</p>
            ) : (
              <div className="space-y-2">
                {chunks.slice(0, MAX_CHUNKS).map((c) => {
                  const cv = doc.override?.visibility ?? c.visibility;
                  const allowed = vis.includes(cv);
                  return (
                    <details key={c.id} className="rounded-xl border border-line/70 bg-subtle/50 p-3">
                      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium text-ink">
                          {c.section || "(本文)"}
                          {c.parts > 1 ? ` (${c.part}/${c.parts})` : ""}
                        </span>
                        <Badge tone="neutral" dot={false}>
                          {KNOWLEDGE_VISIBILITY_LABEL[cv]}
                        </Badge>
                        {c.knowledge && act === "knowledge" && (
                          <Badge tone="accent" dot={false}>
                            社内資料
                          </Badge>
                        )}
                        {c.recordDate && <span className="text-[11px] text-ink-3">{fmtDate(c.recordDate)}</span>}
                        <span className="ml-auto text-[11px] text-ink-3 tnum">{num(c.body.length)} 文字</span>
                      </summary>
                      {allowed ? (
                        <pre className="mt-2 max-h-[480px] overflow-auto text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-2">{c.body}</pre>
                      ) : (
                        <p className="mt-2 text-xs text-ink-3">この節は {KNOWLEDGE_VISIBILITY_LABEL[cv]} だけが見られます。</p>
                      )}
                    </details>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title={`社内資料 (${knowledge.length})`} icon={<BookOpen />} description="この資料から登録した社内資料。AI アシスタントが最優先で使います" />
            {visibleKnowledge.length ? (
              <ul className="space-y-1.5 text-sm">
                {visibleKnowledge.slice(0, 60).map((k) => (
                  <li key={k.id} className="min-w-0">
                    <Link href={`/knowledge/${k.id}`} className="block truncate text-accent hover:underline">
                      {k.title}
                    </Link>
                    <span className="text-[11px] text-ink-3">
                      {KNOWLEDGE_VISIBILITY_LABEL[k.visibility ?? "all"]}
                      {k.active ? "" : "・AI に使わない"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-3">{knowledge.length ? "見られる範囲の社内資料はありません。" : "社内資料には登録していません。"}</p>
            )}
          </Card>

          {sourceFile && (
            <Card>
              <CardHeader title="資料台帳 (移行時の記録)" icon={<Database />} />
              <Dl
                columns={1}
                items={[
                  ["フォルダ", sourceFile.folderName],
                  ["状態", sourceFile.status],
                  ["取込先", sourceFile.importedTo ?? "-"],
                ]}
              />
              <Link href="/materials?tab=files" className="mt-2 inline-block text-xs font-medium text-accent hover:underline">
                資料・写真の資料台帳を開く
              </Link>
            </Card>
          )}

          {manage && (
            <Card>
              <CardHeader title="扱いを変える" icon={<Settings2 />} description="空欄にすると自動の判定に戻ります。社内資料もこの扱いに合わせて追加・更新・削除します" />
              <form action={updateMaterial} className="space-y-3">
                <input type="hidden" name="id" value={doc.id} />
                <input type="hidden" name="back" value={selfHref} />
                <Field label="扱い" hint={`自動の判定: ${ACTION_LABEL[doc.action]}`}>
                  <Select name="action" defaultValue={doc.override?.action ?? ""}>
                    <option value="">自動の判定に戻す</option>
                    {ACTION_KEYS.map((a) => (
                      <option key={a} value={a}>
                        {ACTION_LABEL[a]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="見られる人" hint={`自動の判定: ${KNOWLEDGE_VISIBILITY_LABEL[doc.visibility]} (節ごとに上げたものはそのまま)`}>
                  <Select name="visibility" defaultValue={doc.override?.visibility ?? ""}>
                    <option value="">自動の判定に戻す</option>
                    {VIS_KEYS.map((v) => (
                      <option key={v} value={v}>
                        {KNOWLEDGE_VISIBILITY_LABEL[v]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="分類" hint={`自動の判定: ${doc.category}`}>
                  <Select name="category" defaultValue={doc.override?.category ?? ""}>
                    <option value="">自動の判定に戻す</option>
                    {REGISTRY_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="メモ">
                  <Textarea name="note" rows={2} maxLength={500} defaultValue={doc.override?.note ?? ""} placeholder="扱いを変えた理由など" />
                </Field>
                <Button type="submit">保存する</Button>
              </form>
              <p className="mt-3 text-[11px] leading-relaxed text-ink-3">「見られる人」を選ぶと、この資料のすべての節がその範囲になります (個人情報で上げた節も含む)。取り込まないにすると中身を資料庫から消します。</p>
            </Card>
          )}

          {manage && doc.origin === "upload" && (
            <Card>
              <CardHeader title="資料を消す" icon={<Trash2 />} description="画面から追加した資料だけ消せます。この資料から登録した社内資料も消えます" />
              <form action={deleteMaterial}>
                <input type="hidden" name="id" value={doc.id} />
                <Button type="submit" variant="danger">
                  <Trash2 />
                  消す
                </Button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
