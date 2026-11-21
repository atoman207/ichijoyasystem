"use client";

/** 社内資料の一覧: 表示中の資料のチェックをまとめて付け外す (まとめて変更の対象を選ぶ) */
export function KnowledgeSelectAll({ formId }: { formId: string }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
      <input
        type="checkbox"
        className="h-4 w-4"
        onChange={(e) => {
          const form = document.getElementById(formId);
          form?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="ids"]').forEach((b) => {
            b.checked = e.currentTarget.checked;
          });
        }}
      />
      表示中の資料をすべて選ぶ
    </label>
  );
}
