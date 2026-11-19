import "server-only";
import type { Database, MapDocument, MapLocation, MapRefType, User } from "@/lib/db/types";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { putObject, removeObjects } from "@/lib/storage";
import { UserError } from "@/lib/attachments";
import { inspectPdf, MAP_PDF_MAX_BYTES } from "./pdf";
import { mapIndex, placeOf, touchMapIndex, type ResolvedPlace } from "./resolve";
import { docLabel, ensureLocation, linkDocument } from "./store";

/**
 * 住宅地図の PDF の登録 (画面からの登録・差し替えと一括取込で共通)
 * ------------------------------------------------------------
 * 1. PDF を確かめる (pdf.ts) → 2. 同じファイル (SHA-256) が登録済みなら、新しく保存せずにその PDF を結び付ける
 *    (共用してよい PDF のときだけ。共用しない PDF は断る) → 3. ファイルを保存してから台帳に入れる (失敗したらファイルを消す)
 * - 差し替え: 新しい PDF を古い PDF と同じ場所すべてに結び付け、古い PDF は「差し替え済み」として台帳と本体を残す
 * - 許諾の確認 (社内サーバーへの保存・社内の複数人での閲覧) がないものは登録しない
 */

export const DEFAULT_COPYRIGHT: Record<MapDocument["provider"], string> = {
  zenrin: "© ZENRIN CO., LTD.",
  other: "",
};

export interface DocMeta {
  provider: MapDocument["provider"];
  kind: MapDocument["kind"];
  title?: string;
  edition?: string;
  copyrightNotice?: string;
  licenseRef?: string;
  licenseNote?: string;
  shareable?: boolean;
  /** 利用者が許諾の確認にチェックした */
  licenseConfirmed: boolean;
}

export type DocTarget = { type: MapRefType; id: string } | { type: "location"; id: string };

export interface RegisterResult {
  status: "created" | "linked_existing" | "replaced";
  document: MapDocument;
  location: MapLocation;
  message: string;
}

export function validateMeta(meta: DocMeta): string | null {
  if (!meta.licenseConfirmed) return "住宅地図の利用許諾 (契約で社内サーバーへの保存と社内の複数人での閲覧が認められていること) を確認してから登録してください。";
  const copyright = (meta.copyrightNotice?.trim() || DEFAULT_COPYRIGHT[meta.provider]).trim();
  if (meta.provider === "zenrin" && !copyright) return "ゼンリンの地図には著作権表示 (例: © ZENRIN CO., LTD.) を入力してください。";
  return null;
}

/** 登録先の場所を決める (mutate の中で、その時点のデータから) */
function resolveTarget(db: Database, target: DocTarget): { place?: ResolvedPlace; location?: MapLocation } | null {
  if (target.type === "location") {
    const loc = db.mapLocations.find((l) => l.id === target.id && l.status === "active");
    return loc ? { location: loc } : null;
  }
  const place = placeOf(db, target.type, target.id);
  return place ? { place } : null;
}

function placeLabel(place: ResolvedPlace | undefined, loc: MapLocation): string {
  return place ? `${place.record.label} の${place.heading} (${loc.address})` : `場所 ${loc.address}`;
}

export async function registerMapDocument(opts: {
  user: User;
  target: DocTarget;
  file: { name: string; bytes: Buffer };
  meta: DocMeta;
  replaceId?: string;
  source: MapDocument["source"];
  sourceRef?: string;
  /** 監査ログの記録をまとめる (一括取込は 1 件ずつ書かない) */
  quietAudit?: boolean;
}): Promise<RegisterResult> {
  const { user, meta } = opts;
  const metaError = validateMeta(meta);
  if (metaError) throw new UserError(metaError);
  const fileName = opts.file.name.slice(0, 200) || "map.pdf";
  if (!/\.pdf$/i.test(fileName)) throw new UserError(`「${fileName}」は PDF ではありません (拡張子 .pdf のファイルだけを登録できます)。`);
  const check = await inspectPdf(opts.file.bytes, MAP_PDF_MAX_BYTES);
  if (!check.ok) throw new UserError(`「${fileName}」: ${check.error}`);

  const id = newId("mdoc");
  const key = `maps/${nowIso().slice(0, 7)}/${id}.pdf`;
  let stored = false;
  // 同じファイルが登録済みか (先に確かめて、保存しなくてよいときは保存しない。mutate の中でもう一度確かめる)
  const dupBefore = getDb().mapDocuments.find((d) => d.sha256 === check.sha256 && d.status === "active");
  if (!dupBefore) {
    await putObject(key, opts.file.bytes);
    stored = true;
  }
  try {
    return await mutate((db): RegisterResult => {
      const t = resolveTarget(db, opts.target);
      if (!t) throw new UserError("登録先の記録・場所が見つかりません (削除された可能性があります)。");
      const location = t.location ?? ensureLocation(db, user, t.place!).location;
      const where = placeLabel(t.place, location);
      const idx = mapIndex(db);
      const dup = db.mapDocuments.find((d) => d.sha256 === check.sha256 && d.status === "active");
      const now = nowIso();
      const audit = (summary: string, changes?: { field: string; before: unknown; after: unknown }[], entityId = location.id) =>
        !opts.quietAudit && addAudit(db, { userId: user.id, action: "create", entity: "map_location", entityId, entityLabel: location.address, summary, storeId: t.place?.record.storeId ?? location.storeId, changes });

      if (dup) {
        const linkedHere = (idx.locationsByDoc.get(dup.id) ?? []).includes(location.id);
        if (linkedHere) throw new UserError(`同じ PDF (「${docLabel(dup)}」) がこの場所に登録済みです。`);
        if (opts.replaceId) throw new UserError(`差し替えの PDF が、登録済みの「${docLabel(dup)}」と同じファイルです。`);
        if (!dup.shareable) throw new UserError(`同じ PDF (「${docLabel(dup)}」) が別の場所に「共用しない」で登録されています。契約上ほかの場所でも使ってよい地図なら、その PDF の設定で「複数の場所で共用」にしてから結び付けてください。`);
        linkDocument(db, user, dup.id, location.id);
        audit(`住宅地図「${docLabel(dup)}」を結び付け (同じ PDF が登録済みのため共用。${where})`, [{ field: "document", before: null, after: docLabel(dup) }]);
        return { status: "linked_existing", document: dup, location, message: `同じ PDF が別の場所に登録済みだったため、新しく保存せずにその PDF (「${docLabel(dup)}」) をこの場所にも結び付けました。` };
      }
      if (!stored) throw new UserError("同じ PDF の登録状況が変わりました。もう一度登録してください。");

      let replaced: MapDocument | undefined;
      if (opts.replaceId) {
        replaced = db.mapDocuments.find((d) => d.id === opts.replaceId);
        if (!replaced || replaced.status !== "active") throw new UserError("差し替える PDF が見つかりません (すでに差し替え・取り消しされています)。");
        if (!(idx.locationsByDoc.get(replaced.id) ?? []).includes(location.id)) throw new UserError("差し替える PDF はこの場所の地図ではありません。");
      }
      const doc: MapDocument = {
        id,
        kind: meta.kind,
        provider: meta.provider,
        title: (meta.title?.trim() || fileName.replace(/\.pdf$/i, "")).slice(0, 120),
        fileName,
        contentType: "application/pdf",
        size: check.size,
        sha256: check.sha256,
        pageCount: check.pages,
        storageKey: key,
        status: "active",
        replacesId: replaced?.id,
        source: opts.source,
        sourceRef: opts.sourceRef,
        edition: meta.edition?.trim().slice(0, 60) || undefined,
        copyrightNotice: (meta.copyrightNotice?.trim() || DEFAULT_COPYRIGHT[meta.provider]).slice(0, 200),
        licenseRef: meta.licenseRef?.trim().slice(0, 100) || undefined,
        licenseNote: meta.licenseNote?.trim().slice(0, 500) || undefined,
        licenseConfirmedBy: user.id,
        licenseConfirmedAt: now,
        shareable: meta.shareable || (replaced?.shareable ?? undefined) || undefined,
        storeId: t.place?.record.storeId ?? location.storeId,
        uploadedBy: user.id,
        uploadedAt: now,
        updatedAt: now,
      };
      db.mapDocuments.push(doc);
      touchMapIndex();
      if (replaced) {
        // 古い PDF が結び付いていた場所すべてに新しい PDF を結び付ける (ほかの記録からの参照も新しい版になる)
        const locs = idx.locationsByDoc.get(replaced.id) ?? [location.id];
        for (const l of locs) linkDocument(db, user, doc.id, l);
        replaced.status = "replaced";
        replaced.replacedById = doc.id;
        replaced.updatedAt = now;
        audit(`住宅地図を差し替え (「${docLabel(replaced)}」→「${docLabel(doc)}」${locs.length > 1 ? ` / この PDF を使う ${locs.length} か所すべて` : ""}。${where})`, [{ field: "document", before: docLabel(replaced), after: docLabel(doc) }]);
        return { status: "replaced", document: doc, location, message: `住宅地図を差し替えました${locs.length > 1 ? ` (この PDF を使っている ${locs.length} か所すべてに反映)` : ""}。前の版は履歴に残しています。` };
      }
      linkDocument(db, user, doc.id, location.id);
      audit(`住宅地図を登録 (「${docLabel(doc)}」${check.pages} ページ / ${where})`, [{ field: "document", before: null, after: docLabel(doc) }]);
      return { status: "created", document: doc, location, message: `住宅地図「${docLabel(doc)}」(${check.pages} ページ) を登録しました。` };
    });
  } catch (err) {
    if (stored) await removeObjects([key]).catch(() => undefined);
    throw err;
  }
}
