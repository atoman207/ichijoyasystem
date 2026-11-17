import { requireUser } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/constants";
import { GUIDES } from "@/lib/help-guides";
import Link from "@/components/ui/Link";
import { Card, CardHeader, Note, PageHeader } from "@/components/ui";

/**
 * 使い方 (操作説明)。ロールごとの主な操作を、画面の名前とボタンの名前で示す。
 * 自分のロールの説明を先頭に表示する
 */

export default async function HelpPage() {
  const user = await requireUser();
  const mine = GUIDES.filter((g) => g.roles.includes(user.role));
  const others = GUIDES.filter((g) => !g.roles.includes(user.role));
  return (
    <div>
      <PageHeader title="使い方" description={`あなたのロール: ${ROLE_LABEL[user.role]}。画面の名前とボタンの名前で、主な操作の流れを説明しています。`} />
      <Note>リンクを押すと、その画面が開きます。操作に迷ったら、店長または管理者に相談してください。</Note>
      <nav className="mt-4 mb-4 flex flex-wrap gap-2 text-xs">
        {mine.map((g) => (
          <a key={g.id} href={`#${g.id}`} className="rounded-full border border-line px-3 py-1 text-ink-2 hover:bg-subtle">{g.title}</a>
        ))}
      </nav>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        {mine.map((g) => (
          <Card key={g.id}>
            <div id={g.id} className="scroll-mt-20" />
            <CardHeader title={g.title} />
            <dl className="space-y-2.5">
              {g.steps.map(([title, body, href]) => (
                <div key={title}>
                  <dt className="text-sm font-medium text-ink">{href ? <Link href={href} className="text-accent hover:underline">{title}</Link> : title}</dt>
                  <dd className="text-xs leading-relaxed text-ink-2">{body}</dd>
                </div>
              ))}
            </dl>
          </Card>
        ))}
      </div>
      {others.length > 0 && <p className="mt-4 text-xs text-ink-3">ほかのロールの操作 ({others.map((g) => g.title).join("・")}) は、その権限のある社員が行います。</p>}
    </div>
  );
}
