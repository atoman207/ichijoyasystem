"use client";

import { useActionState, useState } from "react";
import clsx from "clsx";
import { ArrowRight, Building, CircleAlert, CircleCheck, Store, UserRound, Users } from "lucide-react";
import Link from "@/components/ui/Link";
import { signup, type SignupState } from "@/lib/actions/auth";
import type { Role, StoreId } from "@/lib/db/types";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";

const ROLE_ICON: Record<Role, React.ComponentType<{ className?: string }>> = {
  admin: UserRound,
  store_manager: Store,
  store_staff: Users,
  hq_staff: Building,
};

/** 承認する人 (申請したロールごと) */
const APPROVER: Record<Role, string> = {
  store_staff: "所属店舗の店長または管理者",
  store_manager: "管理者",
  hq_staff: "管理者",
  admin: "管理者",
};

const ROLE_ORDER: Role[] = ["store_staff", "store_manager", "hq_staff", "admin"];

export function SignupForm({ stores }: { stores: { id: StoreId; name: string; color: string }[] }) {
  const [state, formAction, pending] = useActionState<SignupState, FormData>(signup, {});
  const [role, setRole] = useState<Role>("store_staff");
  const storeRole = role === "store_staff" || role === "store_manager";
  const choices = storeRole ? stores.filter((s) => s.id !== "hq") : stores;
  const [storeId, setStoreId] = useState<StoreId>(stores.find((s) => s.id !== "hq")?.id ?? "koshi");
  const store = choices.some((s) => s.id === storeId) ? storeId : (storeRole ? choices[0]?.id : "hq") ?? storeId;

  if (state.done) {
    return (
      <div className="space-y-4 text-center">
        <CircleCheck className="mx-auto h-12 w-12 text-good" aria-hidden />
        <h3 className="text-lg font-semibold text-ink">申請を受け付けました</h3>
        <p className="text-sm leading-relaxed text-ink-2">
          {state.done.name} さん ({state.done.role} / {state.done.store}) の新規登録を申請しました。
          <br />
          承認されると、登録したログイン ID とパスワードでログインできます。
        </p>
        <Link href="/login" className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover">
          ログイン画面へ <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} encType="multipart/form-data" className="space-y-5">
      <div className="hidden" aria-hidden>
        <label>
          ウェブサイト <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <fieldset>
        <legend className="mb-2 text-xs font-semibold text-ink-2">希望する権限 (ロール)</legend>
        <input type="hidden" name="role" value={role} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ROLE_ORDER.map((r) => {
            const Icon = ROLE_ICON[r];
            const active = role === r;
            return (
              <button
                type="button"
                key={r}
                onClick={() => setRole(r)}
                aria-pressed={active}
                className={clsx(
                  "flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition",
                  active ? "border-accent bg-accent-soft shadow-[0_0_0_3px_rgba(74,90,232,0.12)]" : "border-line bg-panel hover:border-line-strong hover:bg-subtle",
                )}
              >
                <span className={clsx("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", active ? "bg-accent text-white" : "bg-subtle text-ink-3")}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className={clsx("block text-sm font-medium", active ? "text-accent-ink" : "text-ink")}>{ROLE_LABEL[r]}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-3">{ROLE_DESCRIPTION[r]}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-ink-3">承認する人: {APPROVER[role]}。承認するときにロール・所属が直されることがあります。</p>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-xs font-semibold text-ink-2">{storeRole ? "所属する店舗" : "所属"}</legend>
        <input type="hidden" name="storeId" value={store} />
        <div className="flex flex-wrap gap-2">
          {choices.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => setStoreId(s.id)}
              aria-pressed={store === s.id}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition",
                store === s.id ? "border-ink bg-ink text-white shadow-sm" : "border-line bg-panel text-ink-2 hover:border-line-strong hover:bg-subtle",
              )}
            >
              <span className="h-2 w-2 rounded-full ring-2 ring-white/70" style={{ background: s.color }} aria-hidden />
              {s.name}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 border-t border-line pt-5 sm:grid-cols-2">
        <label className="block">
          <span className="label">氏名 *</span>
          <input name="name" required maxLength={60} className="field" autoComplete="name" />
        </label>
        <label className="block">
          <span className="label">フリガナ</span>
          <input name="kana" maxLength={60} className="field" />
        </label>
        <label className="block sm:col-span-2">
          <span className="label">ログイン ID (メールアドレス推奨) *</span>
          <input name="email" required maxLength={120} className="field" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="例: yamada@example.jp" />
        </label>
        <label className="block">
          <span className="label">パスワード (8 文字以上) *</span>
          <input name="password" type="password" required minLength={8} className="field" autoComplete="new-password" />
        </label>
        <label className="block">
          <span className="label">パスワード (確認) *</span>
          <input name="confirm" type="password" required minLength={8} className="field" autoComplete="new-password" />
        </label>
        <label className="block sm:col-span-2">
          <span className="label">承認する人へのメモ (任意)</span>
          <textarea name="note" maxLength={400} rows={2} className="field" placeholder="例: 4 月入社の営業です。店長の〇〇さんに確認済み" />
        </label>
        <label className="block sm:col-span-2">
          <span className="label">顔写真 (任意)</span>
          <input
            name="avatar"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="field h-auto py-2"
          />
          <span className="mt-1 block text-[11px] text-ink-3">JPEG / PNG / WebP、512 KB まで。申請時に登録しておくと、承認後すぐに顔写真が表示されます。</span>
        </label>
      </div>

      {state.error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-critical/30 bg-critical-soft px-3 py-2.5 text-sm text-critical-ink">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {state.error}
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-sm font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_1px_2px_rgba(18,22,20,0.18)] transition hover:bg-accent-hover disabled:opacity-60"
      >
        {pending ? "送信中…" : `${ROLE_LABEL[role]} として新規登録を申請`}
        {!pending && <ArrowRight className="h-4 w-4" />}
      </button>
      <p className="text-center text-xs text-ink-3">
        アカウントをお持ちの方は <Link href="/login" className="font-medium text-accent hover:underline">ログイン</Link>
      </p>
    </form>
  );
}
