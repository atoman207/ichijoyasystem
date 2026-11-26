/**
 * アカウントの規則のテスト (お客様のご要望 2026-11-26)
 *   node scripts/tests/accounts/accounts.test.mjs   (npm run test:accounts)
 * - 新規登録の申請の承認・却下は管理者だけ (canApproveSignup)
 * - 管理者はロール・所属・役職を変えられる (canChangeUserRole。テスト期間中のアカウントの変更の停止の対象外)
 * - 店長・店舗スタッフは本部に所属させない (roleStoreProblem)
 * - 権限一覧 (permission-table.ts) の行が同じ内容
 * 画面の流れ (申請 → ログインできない → 管理者が承認 → ログイン) は試しのサーバーで確かめる
 */
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src") }, interopDefault: true });
const perm = await jiti.import(path.join(root, "src/lib/auth/permissions.ts"));
const table = await jiti.import(path.join(root, "src/lib/auth/permission-table.ts"));
const rules = await jiti.import(path.join(root, "src/lib/account-rules.ts"));

let pass = 0;
const fails = [];
const ok = (c, m) => (c ? pass++ : (fails.push(m), console.log("  ✗", m)));

const u = (role, storeId = "chuo", id = `u_${role}`) => ({ id, name: role, email: `${role}@example.test`, role, storeId, title: "", active: true });
const admin = u("admin", "hq");
const manager = u("store_manager", "chuo");
const hq = u("hq_staff", "hq");
const staff = u("store_staff", "chuo");

// 1. 新規登録の申請の承認は管理者だけ
ok(perm.canApproveSignup(admin) === true, "管理者は新規登録の申請を承認できる");
ok(perm.canApproveSignup(manager) === false, "店長は (自店舗の店舗スタッフの申請でも) 承認できない");
ok(perm.canApproveSignup(hq) === false, "本部スタッフは承認できない");
ok(perm.canApproveSignup(staff) === false, "店舗スタッフは承認できない");

// 2. ロール・所属の変更は管理者
ok(perm.canChangeUserRole(admin) === true, "管理者はロールを変えられる");
for (const x of [manager, hq, staff]) ok(perm.canChangeUserRole(x) === false, `${x.role} はロールを変えられない`);
ok([...perm.assignableRoles(admin)].sort().join(",") === "admin,hq_staff,store_manager,store_staff", "管理者は 4 つのロール (管理者・店長・店舗スタッフ・本部スタッフ) を付けられる");
ok(perm.assignableRoles(manager).join(",") === "store_staff", "店長が付けられるのは店舗スタッフだけ");
ok(perm.canManageUser(admin, staff) && perm.canManageUser(admin, manager) && perm.canManageUser(admin, hq), "管理者はすべての社員を管理できる");

// 3. 店舗のロールは本部に所属させない
const stores = { hq: { id: "hq", kind: "hq" }, chuo: { id: "chuo", kind: "store" }, extra: { id: "extra", kind: "hq" } };
ok(perm.roleStoreProblem("store_manager", stores.hq) !== undefined, "店長を本部の所属にはできない");
ok(perm.roleStoreProblem("store_staff", stores.hq) !== undefined, "店舗スタッフを本部の所属にはできない");
ok(perm.roleStoreProblem("store_staff", stores.extra) !== undefined, "本部の種類の店舗 (kind = hq) も店舗のロールは不可");
ok(perm.roleStoreProblem("store_manager", stores.chuo) === undefined, "店長は店舗の所属にできる");
ok(perm.roleStoreProblem("hq_staff", stores.hq) === undefined && perm.roleStoreProblem("admin", stores.hq) === undefined, "本部スタッフ・管理者は本部の所属にできる");
ok(perm.roleStoreProblem("admin", stores.chuo) === undefined, "管理者は店舗の所属にもできる (社長が店長を兼ねる)");
ok(perm.roleStoreProblem("store_staff", undefined) !== undefined, "所属がない店舗のロールは不可");

// 4. テスト期間中の停止は既定でオン (ロールの変更は管理者だけ停止の対象外)
const saved = process.env.ACCOUNT_EDIT_LOCK;
delete process.env.ACCOUNT_EDIT_LOCK;
ok(rules.accountEditLocked() === true, "既定でアカウントの変更を停止");
process.env.ACCOUNT_EDIT_LOCK = "off";
ok(rules.accountEditLocked() === false, "ACCOUNT_EDIT_LOCK=off で解除");
if (saved === undefined) delete process.env.ACCOUNT_EDIT_LOCK;
else process.env.ACCOUNT_EDIT_LOCK = saved;

// 5. 権限一覧の行
const rows = table.PERMISSION_TABLE;
const signupRow = rows.find((r) => r.action.startsWith("新規登録の申請の承認"));
ok(signupRow && signupRow.admin === "○" && signupRow.manager === "−" && signupRow.hq === "−" && signupRow.staff === "−", "権限一覧: 新規登録の申請の承認は管理者だけ");
const roleRow = rows.find((r) => r.action.startsWith("ロール・所属・役職の変更"));
ok(roleRow && roleRow.admin === "○" && roleRow.manager === "−", "権限一覧: ロール・所属・役職の変更は管理者");
ok(!rows.some((r) => /新規登録の申請の承認 \(店長/.test(r.action)), "権限一覧に「店長も承認」の古い文がない");

console.log(`\n${pass} OK${fails.length ? ` / ${fails.length} NG` : ""}`);
if (fails.length) process.exit(1);
