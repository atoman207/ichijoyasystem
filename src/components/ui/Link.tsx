import NextLink from "next/link";
import type { ComponentProps } from "react";

/**
 * アプリ内のリンク。先読み (prefetch) は既定でしない
 * - 画面はすべてログイン必須の動的表示のため、先読みしても表示は速くならず、
 *   一覧の各行や予定表の各予定など、リンクの数だけサーバーの処理が走る (予定表では 1 回の表示で 90 件以上)
 * - 先読みが必要な箇所では prefetch を明示する
 */
export default function Link({ prefetch = false, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={prefetch} {...props} />;
}
