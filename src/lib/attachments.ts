import "server-only";
import type { Attachment, AttachmentParent, Database, StoreId, User } from "@/lib/db/types";
import { canAccessStore, canDeleteAttachment, canManageFinance, canViewExpense } from "@/lib/auth/permissions";
import { newId, nowIso } from "@/lib/db/store";
import { putObject, removeObjects } from "@/lib/storage";
import { fmtDateTime } from "@/lib/format";

/**
 * 添付ファイル (資料・写真)
 * ------------------------------------------------------------
 * - 登録先: 顧客・問い合わせ・見積・受注 (案件)・経費・仕入請求書、書類取込の元画像
 * - 閲覧・登録の権限は登録先の記録に従う (他店舗の店舗スタッフは表示できない。URL を直接開いた場合も同じ)
 * - 写真はブラウザで縮小してから送る (Vercel の 1 回の送信は 4.5 MB まで)。PDF などは 4 MB まで
 */

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_THUMB_BYTES = 512 * 1024;

const TYPES: Record<string, { type: string; photo: boolean }> = {
  jpg: { type: "image/jpeg", photo: true },
  jpeg: { type: "image/jpeg", photo: true },
  png: { type: "image/png", photo: true },
  webp: { type: "image/webp", photo: true },
  gif: { type: "image/gif", photo: true },
  // HEIC はブラウザによって表示できないため、ファイルとして扱う (iPhone は通常 JPEG に変換して送る)
  heic: { type: "image/heic", photo: false },
  heif: { type: "image/heif", photo: false },
  pdf: { type: "application/pdf", photo: false },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", photo: false },
  xls: { type: "application/vnd.ms-excel", photo: false },
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", photo: false },
  doc: { type: "application/msword", photo: false },
  pptx: { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", photo: false },
  ppt: { type: "application/vnd.ms-powerpoint", photo: false },
  csv: { type: "text/csv", photo: false },
  txt: { type: "text/plain", photo: false },
};

/** 受け付けるファイル (input の accept) */
export const ATTACHMENT_ACCEPT = "image/*," + Object.keys(TYPES).filter((e) => !TYPES[e].photo).map((e) => `.${e}`).join(",");

/** ファイル名と申告された種類から、保存できる種類かを判定する (拡張子を優先。スマートフォンは種類が空のことがある) */
export function detectType(fileName: string, given: string): { ext: string; contentType: string; photo: boolean } | null {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const byExt = TYPES[ext];
  if (byExt) return { ext, contentType: byExt.type, photo: byExt.photo };
  const byType = Object.entries(TYPES).find(([, v]) => v.type === given);
  return byType ? { ext: byType[0], contentType: byType[1].type, photo: byType[1].photo } : null;
}

export interface ParentInfo {
  type: AttachmentParent;
  id: string;
  storeId: StoreId;
  customerId?: string;
  /** 一覧・変更履歴に出す名前 (例: 受注 R-2026-0012) */
  label: string;
  href: string;
  /** 変更履歴の entity */
  entity: string;
}

export const PARENT_LABEL: Record<AttachmentParent, string> = {
  customer: "顧客",
  inquiry: "問い合わせ",
  quote: "見積",
  order: "受注・施工",
  expense: "経費",
  purchase: "仕入請求書",
  document: "取込書類",
};

export function resolveParent(db: Database, type: string, id: string): ParentInfo | null {
  switch (type) {
    case "customer": {
      const c = db.customers.find((x) => x.id === id);
      return c ? { type, id, storeId: c.storeId, customerId: c.id, label: `顧客 ${c.code} ${c.name}`, href: `/customers/${c.id}`, entity: "customer" } : null;
    }
    case "inquiry": {
      const x = db.inquiries.find((i) => i.id === id);
      return x ? { type, id, storeId: x.storeId, customerId: x.customerId, label: `問い合わせ ${x.number}`, href: `/inquiries/${x.id}`, entity: "inquiry" } : null;
    }
    case "quote": {
      const q = db.quotes.find((i) => i.id === id);
      return q ? { type, id, storeId: q.storeId, customerId: q.customerId, label: `見積 ${q.number}`, href: `/quotes/${q.id}`, entity: "quote" } : null;
    }
    case "order": {
      const o = db.orders.find((i) => i.id === id);
      return o ? { type, id, storeId: o.storeId, customerId: o.customerId, label: `受注 ${o.number}`, href: `/orders/${o.id}`, entity: "order" } : null;
    }
    case "expense": {
      const e = db.expenses.find((i) => i.id === id);
      return e ? { type, id, storeId: e.storeId, label: `経費 ${e.number}`, href: `/expenses/${e.id}`, entity: "expense" } : null;
    }
    case "purchase": {
      const p = db.purchases.find((i) => i.id === id);
      return p ? { type, id, storeId: p.storeId, label: `仕入請求書 ${p.number}`, href: `/purchases/${p.id}`, entity: "purchase" } : null;
    }
    case "document": {
      const d = db.documents.find((i) => i.id === id);
      return d ? { type, id, storeId: d.storeId, label: `取込書類 ${d.fileName}`, href: `/capture?doc=${d.id}`, entity: "document" } : null;
    }
    default:
      return null;
  }
}

/** 登録先を閲覧できるか (= その添付ファイルを表示できるか) */
export function canViewParent(user: User, db: Database, p: ParentInfo): boolean {
  if (p.type === "expense") {
    const e = db.expenses.find((x) => x.id === p.id);
    return Boolean(e && canViewExpense(user, e));
  }
  if (p.type === "purchase") return canManageFinance(user);
  return canAccessStore(user, p.storeId);
}

/** 登録先に添付ファイルを追加できるか (書類取込の元画像は取込のときだけ) */
export function canAddToParent(user: User, db: Database, p: ParentInfo): boolean {
  if (p.type === "document") return false;
  return canViewParent(user, db, p);
}

/** 添付ファイルを表示できるか。登録先が消えている場合は店舗で判定する */
export function canViewAttachment(user: User, db: Database, a: Attachment): boolean {
  const p = resolveParent(db, a.parentType, a.parentId);
  return p ? canViewParent(user, db, p) : canAccessStore(user, a.storeId);
}

export function attachmentsOf(db: Database, type: AttachmentParent, id: string): Attachment[] {
  return db.attachments.filter((a) => a.parentType === type && a.parentId === id).sort((a, b) => (b.takenAt ?? b.uploadedAt).localeCompare(a.takenAt ?? a.uploadedAt));
}

/** 画面に渡す形 (クライアントコンポーネント用) */
export interface AttachmentView {
  id: string;
  kind: "photo" | "file";
  fileName: string;
  contentType: string;
  size: number;
  caption?: string;
  /** 撮影日時・登録日時 (日本時間の表示用) */
  takenLabel?: string;
  uploadedLabel: string;
  uploaderName: string;
  parentLabel: string;
  parentHref: string;
  canDelete: boolean;
}

export function toView(db: Database, user: User, a: Attachment): AttachmentView {
  const p = resolveParent(db, a.parentType, a.parentId);
  return {
    id: a.id,
    kind: a.kind,
    fileName: a.fileName,
    contentType: a.contentType,
    size: a.size,
    caption: a.caption,
    takenLabel: a.takenAt ? fmtDateTime(a.takenAt) : undefined,
    uploadedLabel: fmtDateTime(a.uploadedAt),
    uploaderName: db.users.find((u) => u.id === a.uploadedBy)?.name ?? "-",
    parentLabel: p?.label ?? PARENT_LABEL[a.parentType],
    parentHref: p?.href ?? "#",
    // 店舗は登録先の現在の店舗で判定する (問い合わせ・案件を他店舗へ回した場合も正しく判定するため)
    canDelete: canDeleteAttachment(user, { uploadedBy: a.uploadedBy, storeId: p?.storeId ?? a.storeId }),
  };
}

export interface IncomingFile {
  name: string;
  type: string;
  bytes: Buffer;
}

/**
 * ファイルをストレージに保存し、台帳に入れる行を返す (台帳への追加は呼び出し側の mutate で行う)。
 * 台帳の保存に失敗したときは discardStored() でファイルを消す
 */
export async function storeFile(opts: {
  user: User;
  parent: ParentInfo;
  file: IncomingFile;
  thumb?: IncomingFile;
  width?: number;
  height?: number;
  takenAt?: string;
  caption?: string;
}): Promise<Attachment> {
  const { parent, file } = opts;
  const t = detectType(file.name, file.type);
  if (!t) throw new UserError(`「${file.name}」は登録できない種類のファイルです (写真・PDF・Excel・Word・PowerPoint・CSV・テキスト)。`);
  if (file.bytes.length === 0) throw new UserError(`「${file.name}」が空のファイルです。`);
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) throw new UserError(`「${file.name}」は ${(file.bytes.length / 1048576).toFixed(1)} MB です。1 ファイル 4 MB までにしてください (写真は自動で縮小されます)。`);
  const id = newId("att");
  const month = nowIso().slice(0, 7);
  const key = `${parent.type}/${month}/${id}.${t.ext}`;
  const useThumb = t.photo && opts.thumb && opts.thumb.bytes.length > 0 && opts.thumb.bytes.length <= MAX_THUMB_BYTES;
  const thumbKey = useThumb ? `${parent.type}/${month}/${id}_thumb.jpg` : undefined;
  await putObject(key, file.bytes, t.contentType);
  if (thumbKey) {
    try {
      await putObject(thumbKey, opts.thumb!.bytes, "image/jpeg");
    } catch (err) {
      await removeObjects([key]).catch(() => undefined);
      throw err;
    }
  }
  const takenAt = opts.takenAt && !Number.isNaN(Date.parse(opts.takenAt)) ? new Date(opts.takenAt).toISOString() : undefined;
  return {
    id,
    parentType: parent.type,
    parentId: parent.id,
    customerId: parent.customerId,
    storeId: parent.storeId,
    kind: t.photo ? "photo" : "file",
    fileName: file.name.slice(0, 200),
    contentType: t.contentType,
    size: file.bytes.length,
    storageKey: key,
    thumbKey,
    width: opts.width && opts.width > 0 ? Math.round(opts.width) : undefined,
    height: opts.height && opts.height > 0 ? Math.round(opts.height) : undefined,
    caption: opts.caption?.trim().slice(0, 200) || undefined,
    takenAt,
    uploadedBy: opts.user.id,
    uploadedAt: nowIso(),
  };
}

export async function discardStored(a: Pick<Attachment, "storageKey" | "thumbKey">): Promise<void> {
  await removeObjects([a.storageKey, a.thumbKey ?? ""]).catch((err) => console.warn("[attachments] cleanup failed:", (err as Error).message));
}

/** 書類取込の元画像を、登録した見積・経費・仕入請求書の添付に付け替える (mutate の中で呼ぶ) */
export function relinkDocumentAttachments(db: Database, documentId: string, to: { type: AttachmentParent; id: string; customerId?: string; storeId: StoreId }) {
  for (const a of db.attachments) {
    if (a.parentType === "document" && a.parentId === documentId) {
      a.parentType = to.type;
      a.parentId = to.id;
      a.customerId = to.customerId ?? a.customerId;
      a.storeId = to.storeId;
    }
  }
}

/** 利用者に見せるエラー (それ以外のエラーは「保存に失敗しました」として扱う) */
export class UserError extends Error {}
