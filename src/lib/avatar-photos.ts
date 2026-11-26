/**
 * 社員の顔写真の版 (お客様のご要望 2026-11-26「顔写真は非表示にできても、元の写真データは削除できない。後からいつでも表示に戻せる」)
 * ------------------------------------------------------------
 * - User.avatarPhotos = これまでに登録したすべての写真 (新しく登録した順に先頭へ)。User.avatarKey = 今の写真 (この中の 1 つ)
 * - 写真を変えても、前の写真は一覧に残る。写真のファイルは消さない (src/lib/actions/accounts.ts は removeObjects を呼ばない)
 * - 「表示しない」= User.avatarHidden = true。写真のファイルと記録はそのまま、画面には出さない (account-rules.ts の avatarUrl が undefined)。
 *   「表示する」で戻す。以前の写真は「この写真に戻す」で今の写真にする
 * - 写真の ID = ファイル名 (avatars/<社員 ID>/<時刻>.<拡張子> の <時刻>.<拡張子>)。確認用の URL は /api/avatars/<社員 ID>?photo=<ID> (本人と管理者だけ)
 * - この機能より前に登録した写真 (avatarPhotos がない) は、今の写真 1 枚の一覧として扱う
 *
 * import なし (サーバー・画面・テストで使う)。
 */

export interface AvatarPhoto {
  /** 保存先のファイル (src/lib/storage.ts のキー) */
  key: string;
  /** この写真を登録した日時 */
  at?: string;
  /** 登録した人 (社員 ID・system) */
  by?: string;
  /** どこから (例: 公開サイトのスタッフ紹介) */
  note?: string;
}

export interface AvatarOwner {
  id: string;
  avatarKey?: string;
  avatarUpdatedAt?: string;
  avatarHidden?: boolean;
  avatarPhotos?: AvatarPhoto[];
}

/** 写真の ID (ファイル名) */
export function avatarPhotoId(key: string): string {
  const i = key.lastIndexOf("/");
  return i < 0 ? key : key.slice(i + 1);
}

/** 写真の ID として正しい形か (URL の値の確かめ) */
export function validAvatarPhotoId(id: string): boolean {
  return /^[\w-]{1,80}\.(jpg|png|webp)$/.test(id);
}

/** 登録したすべての写真 (新しい順・同じファイルは 1 つ)。今の写真が一覧になければ先頭に足す (この機能より前の写真) */
export function avatarPhotosOf(u: AvatarOwner): AvatarPhoto[] {
  const out: AvatarPhoto[] = [];
  const seen = new Set<string>();
  const list = [...(u.avatarPhotos ?? [])];
  if (u.avatarKey && !list.some((p) => p?.key === u.avatarKey)) list.unshift({ key: u.avatarKey, ...(u.avatarUpdatedAt ? { at: u.avatarUpdatedAt } : {}) });
  for (const p of list) {
    if (!p?.key || seen.has(p.key)) continue;
    seen.add(p.key);
    out.push(p);
  }
  return out;
}

/** 以前の写真 (今の写真を除く) */
export function previousAvatarPhotos(u: AvatarOwner): AvatarPhoto[] {
  return avatarPhotosOf(u).filter((p) => p.key !== u.avatarKey);
}

/** 今の写真の情報 (登録した日時・人・どこから) */
export function currentAvatarPhoto(u: AvatarOwner): AvatarPhoto | undefined {
  return u.avatarKey ? avatarPhotosOf(u).find((p) => p.key === u.avatarKey) : undefined;
}

/** ID の写真 (今の写真か以前の写真)。なければ undefined */
export function findAvatarPhoto(u: AvatarOwner, id: string): AvatarPhoto | undefined {
  return avatarPhotosOf(u).find((p) => avatarPhotoId(p.key) === id);
}

/** 新しい写真を登録して今の写真にする (前の写真は一覧に残す)。表示しないにしていたら表示に戻す */
export function addAvatarPhoto(u: AvatarOwner, photo: AvatarPhoto & { at: string }): void {
  const list = avatarPhotosOf(u).filter((p) => p.key !== photo.key);
  u.avatarPhotos = [{ key: photo.key, at: photo.at, ...(photo.by ? { by: photo.by } : {}), ...(photo.note ? { note: photo.note } : {}) }, ...list];
  u.avatarKey = photo.key;
  u.avatarUpdatedAt = photo.at;
  u.avatarHidden = undefined;
}

/**
 * 以前の写真に戻す (一覧の順は変えない)。表示しないにしていたら表示に戻す。
 * avatarUpdatedAt = 戻した日時 (画面の URL が変わり、ブラウザーの控えの写真を使わない)
 */
export function restoreAvatarPhoto(u: AvatarOwner, key: string, at: string): boolean {
  const list = avatarPhotosOf(u);
  if (!list.some((p) => p.key === key)) return false;
  u.avatarPhotos = list;
  u.avatarKey = key;
  u.avatarUpdatedAt = at;
  u.avatarHidden = undefined;
  return true;
}

/** 表示する / 表示しない (写真はそのまま) */
export function setAvatarHidden(u: AvatarOwner, hidden: boolean): void {
  if (hidden) {
    // 一覧がない (この機能より前の写真) なら一覧に残してから隠す
    u.avatarPhotos = avatarPhotosOf(u);
    u.avatarHidden = true;
  } else u.avatarHidden = undefined;
}

/** 画面の確認用の URL (非表示の写真・以前の写真。本人と管理者だけが開ける) */
export function avatarPhotoUrl(userId: string, key: string): string {
  return `/api/avatars/${encodeURIComponent(userId)}?photo=${encodeURIComponent(avatarPhotoId(key))}`;
}

/** 画面 (AvatarUploader) に渡す写真 1 枚 */
export interface AvatarPhotoView {
  id: string;
  /** 確認用の URL (/api/avatars/<社員 ID>?photo=<ID>) */
  src: string;
  /** 登録した日時・人・どこから (画面の表示の文字) */
  label: string;
}

/** 今の写真と以前の写真の表示 (fmt = 日時の表示・nameOf = 社員の名前) */
export function avatarPhotoViews(u: AvatarOwner, fmt: (iso: string) => string, nameOf: (id: string) => string | undefined): { current?: AvatarPhotoView; previous: AvatarPhotoView[] } {
  const view = (p: AvatarPhoto): AvatarPhotoView => {
    const who = p.by ? (p.by === "system" ? "システム" : nameOf(p.by)) : undefined;
    const label = [p.at ? `${fmt(p.at)} 登録` : "", who ? `(${who})` : "", p.note ?? ""].filter(Boolean).join(" ");
    return { id: avatarPhotoId(p.key), src: avatarPhotoUrl(u.id, p.key), label: label || "以前の写真" };
  };
  const cur = currentAvatarPhoto(u);
  return { current: cur ? view(cur) : undefined, previous: previousAvatarPhotos(u).map(view) };
}
