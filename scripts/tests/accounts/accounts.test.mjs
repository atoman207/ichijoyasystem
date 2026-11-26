/**
 * アカウントの規則のテスト (お客様のご要望 2026-11-26)
 *   node scripts/tests/accounts/accounts.test.mjs   (npm run test:accounts)
 * - 新規登録の申請の承認・却下は管理者だけ (canApproveSignup)
 * - 管理者はロール・所属・役職を変えられる (canChangeUserRole。テスト期間中のアカウントの変更の停止の対象外)
 * - 店長・店舗スタッフは本部に所属させない (roleStoreProblem)
 * - 権限一覧 (permission-table.ts) の行が同じ内容
 * - 顔写真は削除しない (2026-11-26): 表示しない / 表示する・前の写真を残す・以前の写真に戻す (avatar-photos.ts)・avatarUrl・本人と管理者だけ
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
const photos = await jiti.import(path.join(root, "src/lib/avatar-photos.ts"));
const carry = await jiti.import(path.join(root, "src/lib/carryover.ts"));

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

// 6. 顔写真は削除しない (お客様のご要望 2026-11-26「非表示にできても元の写真データは削除できない。後からいつでも表示に戻せる」)
{
  const a = { id: "u_a", avatarKey: "avatars/u_a/100.jpg", avatarUpdatedAt: "2026-11-18T02:20:34.148Z" }; // この機能より前の写真 (一覧なし)
  ok(photos.avatarPhotosOf(a).length === 1 && photos.avatarPhotosOf(a)[0].key === a.avatarKey, "一覧のない写真は今の写真 1 枚として扱う");
  ok(rules.avatarUrl(a)?.startsWith("/api/avatars/u_a?v="), "表示している写真の URL");
  photos.setAvatarHidden(a, true);
  ok(a.avatarHidden === true && a.avatarKey === "avatars/u_a/100.jpg", "表示しない: 写真 (avatarKey) は残る");
  ok(rules.avatarUrl(a) === undefined, "表示しない: 画面の URL は出さない (名前の 1 文字の丸)");
  ok(a.avatarPhotos?.length === 1, "表示しない: 前からの写真も一覧に残す");
  photos.setAvatarHidden(a, false);
  ok(a.avatarHidden === undefined && rules.avatarUrl(a) !== undefined, "表示する: 同じ写真に戻る");

  photos.addAvatarPhoto(a, { key: "avatars/u_a/200.jpg", at: "2026-11-26T08:00:00.000Z", by: "system", note: "公開サイトのスタッフ紹介" });
  ok(a.avatarKey === "avatars/u_a/200.jpg" && a.avatarUpdatedAt === "2026-11-26T08:00:00.000Z", "新しい写真が今の写真");
  ok(a.avatarPhotos.map((p) => p.key).join(",") === "avatars/u_a/200.jpg,avatars/u_a/100.jpg", "前の写真は一覧に残る (新しい順)");
  ok(photos.previousAvatarPhotos(a).map((p) => p.key).join(",") === "avatars/u_a/100.jpg", "以前の写真 = 今の写真を除く");
  ok(photos.currentAvatarPhoto(a)?.note === "公開サイトのスタッフ紹介", "今の写真のどこから");

  photos.setAvatarHidden(a, true);
  photos.addAvatarPhoto(a, { key: "avatars/u_a/300.jpg", at: "2026-11-26T09:00:00.000Z", by: "u_a" });
  ok(a.avatarHidden === undefined, "表示しないの間に新しい写真を登録すると表示に戻る");
  ok(a.avatarPhotos.length === 3, "写真は 3 枚とも残る");

  ok(photos.findAvatarPhoto(a, "100.jpg")?.key === "avatars/u_a/100.jpg", "写真の ID (ファイル名) で探せる");
  ok(photos.findAvatarPhoto(a, "999.jpg") === undefined, "ない写真は見つからない");
  ok(photos.restoreAvatarPhoto(a, "avatars/u_a/100.jpg", "2026-11-26T10:00:00.000Z") === true && a.avatarKey === "avatars/u_a/100.jpg", "以前の写真に戻す");
  ok(a.avatarUpdatedAt === "2026-11-26T10:00:00.000Z", "戻すと URL (?v=) が変わる");
  ok(a.avatarPhotos.length === 3 && a.avatarPhotos[0].key === "avatars/u_a/300.jpg", "戻しても一覧の順と写真はそのまま");
  ok(photos.restoreAvatarPhoto(a, "avatars/u_b/1.jpg", "2026-11-26T10:00:00.000Z") === false && a.avatarKey === "avatars/u_a/100.jpg", "ほかの社員の写真には戻せない");
  photos.addAvatarPhoto(a, { key: "avatars/u_a/100.jpg", at: "2026-11-26T11:00:00.000Z" });
  ok(a.avatarPhotos.length === 3 && a.avatarPhotos[0].key === "avatars/u_a/100.jpg", "同じファイルを登録し直しても二重にしない");

  ok(photos.validAvatarPhotoId("1794968434148.jpg") && !photos.validAvatarPhotoId("../x.jpg") && !photos.validAvatarPhotoId("a/b.jpg") && !photos.validAvatarPhotoId("x.svg"), "写真の ID の形 (パスを含まない)");
  ok(photos.avatarPhotoUrl("u_a", "avatars/u_a/100.jpg") === "/api/avatars/u_a?photo=100.jpg", "確認用の URL");
  const v = photos.avatarPhotoViews(a, (iso) => iso.slice(0, 10), (id) => (id === "u_a" ? "本人" : undefined));
  ok(v.current?.id === "100.jpg" && v.previous.length === 2 && v.previous[0].label.includes("本人"), "画面の今の写真・以前の写真");
  const sys = photos.avatarPhotoViews({ id: "u_a", avatarKey: "avatars/u_a/200.jpg", avatarPhotos: [{ key: "avatars/u_a/200.jpg", at: "2026-11-26T08:00:00.000Z", by: "system", note: "公開サイトのスタッフ紹介" }] }, (iso) => iso.slice(0, 10), () => undefined);
  ok(sys.current?.label === "2026-11-26 登録 (システム) 公開サイトのスタッフ紹介", "どこから・システムの登録の表示");
  ok(photos.avatarPhotoViews({ id: "u_x" }, String, () => undefined).current === undefined, "写真のない社員");

  // 本人と管理者だけ
  ok(perm.canManageUserAvatar(staff, staff) === true, "本人は自分の顔写真を変えられる");
  ok(perm.canManageUserAvatar(admin, staff) === true, "管理者はほかの社員の顔写真を変えられる");
  for (const x of [manager, hq]) ok(perm.canManageUserAvatar(x, staff) === false, `${x.role} はほかの社員の顔写真を変えられない`);
  const avRow = rows.find((r) => r.action.startsWith("ほかの社員の顔写真"));
  ok(avRow && avRow.admin === "○" && avRow.hq === "−" && avRow.manager === "−" && avRow.staff === "−", "権限一覧: ほかの社員の顔写真は管理者");
  // 試験期間の引き継ぎに入る
  ok(carry.USER_FIELDS.includes("avatarHidden") && carry.USER_FIELDS.includes("avatarPhotos"), "引き継ぐ社員の項目に表示しない・写真の一覧");
}

console.log(`\n${pass} OK${fails.length ? ` / ${fails.length} NG` : ""}`);
if (fails.length) process.exit(1);
