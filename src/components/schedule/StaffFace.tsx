import { Avatar } from "@/components/ui";

/**
 * 予定の担当者 1 人の顔写真 (お客様のご要望 2026-11-26: 予定表では略称の文字ではなく顔写真)。
 * 顔写真のない社員は名前の 1 文字の丸 (ui の Avatar)。外側の細い輪 = その人の店舗の色 (ほかの店舗の応援が分かる)。
 * 予定表のチップ (CalendarViews の StaffMarks) と予定の小さな画面の担当者 (EventQuick) で共通。フックを使わないのでサーバーでも画面でも使える
 */
export function StaffFace({ name, id, src, color, size = 18 }: { name: string; id: string; src?: string; color?: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 rounded-full bg-panel" style={{ boxShadow: `0 0 0 1.5px ${color ?? "#94a3b8"}` }} title={name} data-testid="staff-face">
      <Avatar name={name} id={id} size={size} src={src} />
    </span>
  );
}
