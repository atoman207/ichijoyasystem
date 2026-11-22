import type { ReactNode } from "react";
import { Eye, Lock } from "lucide-react";

/**
 * ほかの店舗の進行中の案件を「閲覧のみ」で表示する・完了した案件の変更の欄を止める (src/lib/case-access.ts)。
 * 中の入力欄・ボタンをまとめて使えなくする (fieldset の disabled)。送信してもサーバーの操作が断る
 */
export function ReadOnlyArea({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  if (!readOnly) return <>{children}</>;
  return (
    <fieldset disabled className="m-0 min-w-0 border-0 p-0" aria-label="閲覧のみ">
      {children}
    </fieldset>
  );
}

/** ほかの店舗の進行中の案件を見ているときの案内 */
export function CaseViewBanner({ storeName, what = "案件" }: { storeName: string; what?: string }) {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-accent/30 bg-accent-soft/50 px-3 py-2 text-xs leading-relaxed text-ink-2" role="note">
      <Eye className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
      <span>
        {storeName}の進行中の{what}です (問い合わせから入金完了までは、全社員がほかの店舗の案件も見られます)。<b>閲覧のみ</b>で、登録・変更は{storeName}の担当者が行います。入金が完了すると、ほかの店舗からは見られなくなります。
      </span>
    </div>
  );
}

/** 入金完了・全処理完了で内容を変えられない案件の案内 */
export function CompletedLockBanner({ reason, admin }: { reason: string; admin?: boolean }) {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-line bg-subtle px-3 py-2 text-xs leading-relaxed text-ink-2" role="note">
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
      <span>
        {admin
          ? `${reason}です。管理者のため変更できますが、変更は変更履歴に残ります。`
          : `${reason}のため、案件情報・契約内容・現場の情報・状態・見積は変更できません (変更が必要なときは管理者に依頼してください)。進捗・やりとりの記録・写真の追加はできます。`}
      </span>
    </div>
  );
}
