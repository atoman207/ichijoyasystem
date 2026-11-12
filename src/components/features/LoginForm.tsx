"use client";

import { useActionState, useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowRight, Building, CircleAlert, Store, UserRound, Users } from "lucide-react";
import { login, type LoginState } from "@/lib/actions/auth";
import type { Role, StoreId } from "@/lib/db/types";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";

export interface LoginAccount {
  id: string;
  name: string;
  email: string;
  password: string;
  role: Role;
  storeId: StoreId;
  title: string;
}

export interface LoginStore {
  id: StoreId;
  name: string;
  color: string;
}

const ROLE_ICON: Record<Role, React.ComponentType<{ className?: string }>> = {
  admin: UserRound,
  store_manager: Store,
  store_staff: Users,
  hq_staff: Building,
};

export function LoginForm({ accounts, stores, next }: { accounts: LoginAccount[]; stores: LoginStore[]; next?: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});
  const [role, setRole] = useState<Role>("admin");
  const [storeId, setStoreId] = useState<StoreId>("koshi");
  const [staffIndex, setStaffIndex] = useState(0);

  const candidates = useMemo(() => {
    if (role === "store_manager" || role === "store_staff") {
      return accounts.filter((a) => a.role === role && a.storeId === storeId);
    }
    return accounts.filter((a) => a.role === role);
  }, [accounts, role, storeId]);
  const selected = candidates[Math.min(staffIndex, candidates.length - 1)] ?? accounts[0];
  const [email, setEmail] = useState(selected.email);
  const [password, setPassword] = useState(selected.password);

  function applyAccount(a: LoginAccount) {
    setEmail(a.email);
    setPassword(a.password);
  }
  function chooseRole(r: Role) {
    setRole(r);
    setStaffIndex(0);
    const list = r === "store_manager" || r === "store_staff" ? accounts.filter((a) => a.role === r && a.storeId === storeId) : accounts.filter((a) => a.role === r);
    if (list[0]) applyAccount(list[0]);
  }
  function chooseStore(s: StoreId) {
    setStoreId(s);
    setStaffIndex(0);
    const list = accounts.filter((a) => a.role === role && a.storeId === s);
    if (list[0]) applyAccount(list[0]);
  }
  function chooseStaff(i: number) {
    setStaffIndex(i);
    if (candidates[i]) applyAccount(candidates[i]);
  }

  const storeStores = stores.filter((s) => s.id !== "hq");
  const stepLabel = "flex items-center gap-2 text-xs font-semibold text-ink-2";
  const stepNo = "flex h-5 w-5 items-center justify-center rounded-full bg-ink text-[10px] font-semibold text-white";

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="next" value={next ?? "/"} />
      <div>
        <div className={clsx(stepLabel, "mb-2")}>
          <span className={stepNo}>1</span> ロールを選択
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => {
            const Icon = ROLE_ICON[r];
            const active = role === r;
            return (
              <button
                type="button"
                key={r}
                onClick={() => chooseRole(r)}
                className={clsx(
                  "flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition",
                  active ? "border-accent bg-accent-soft shadow-[0_0_0_3px_rgba(31,122,77,0.12)]" : "border-line bg-panel hover:border-line-strong hover:bg-subtle",
                )}
                aria-pressed={active}
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
      </div>

      {(role === "store_manager" || role === "store_staff") && (
        <div>
          <div className={clsx(stepLabel, "mb-2")}>
            <span className={stepNo}>2</span> 店舗を選択
          </div>
          <div className="flex flex-wrap gap-2">
            {storeStores.map((s) => {
              const active = storeId === s.id;
              return (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => chooseStore(s.id)}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition",
                    active ? "border-ink bg-ink text-white shadow-sm" : "border-line bg-panel text-ink-2 hover:border-line-strong hover:bg-subtle",
                  )}
                  aria-pressed={active}
                >
                  <span className="h-2 w-2 rounded-full ring-2 ring-white/70" style={{ background: s.color }} aria-hidden />
                  {s.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {candidates.length > 1 && (
        <div>
          <div className={clsx(stepLabel, "mb-2")}>
            <span className={stepNo}>{role === "store_manager" || role === "store_staff" ? 3 : 2}</span> 担当者
          </div>
          <div className="flex flex-wrap gap-2">
            {candidates.map((a, i) => {
              const active = selected.id === a.id;
              return (
                <button
                  type="button"
                  key={a.id}
                  onClick={() => chooseStaff(i)}
                  className={clsx(
                    "rounded-xl border px-3 py-1.5 text-left text-sm transition",
                    active ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-panel text-ink-2 hover:border-line-strong hover:bg-subtle",
                  )}
                  aria-pressed={active}
                >
                  <span className="block font-medium">{a.name}</span>
                  <span className="block text-[11px] text-ink-3">{a.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-3 border-t border-line pt-5 sm:grid-cols-2">
        <label className="block">
          <span className="label">メールアドレス</span>
          <input name="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="field" autoComplete="username" />
        </label>
        <label className="block">
          <span className="label">パスワード</span>
          <input name="password" type="text" required value={password} onChange={(e) => setPassword(e.target.value)} className="field font-mono" autoComplete="current-password" />
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
        {pending ? "ログイン中…" : `${selected.name} (${ROLE_LABEL[selected.role]}) としてログイン`}
        {!pending && <ArrowRight className="h-4 w-4" />}
      </button>
    </form>
  );
}

/** 本番データ用のログインフォーム (ログイン ID とパスワードを入力する) */
export function PlainLoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={next ?? "/"} />
      <label className="block">
        <span className="label">ログイン ID</span>
        <input name="email" type="text" required autoComplete="username" autoCapitalize="none" spellCheck={false} className="field" placeholder="例: yamada" />
      </label>
      <label className="block">
        <span className="label">パスワード</span>
        <input name="password" type="password" required autoComplete="current-password" className="field" />
      </label>
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
        {pending ? "ログイン中…" : "ログイン"}
        {!pending && <ArrowRight className="h-4 w-4" />}
      </button>
    </form>
  );
}
