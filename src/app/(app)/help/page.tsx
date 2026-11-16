import { requireUser } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/constants";
import type { Role } from "@/lib/db/types";
import Link from "@/components/ui/Link";
import { Card, CardHeader, Note, PageHeader } from "@/components/ui";

/**
 * 使い方 (操作説明)。ロールごとの主な操作を、画面の名前とボタンの名前で示す。
 * 自分のロールの説明を先頭に表示する
 */

type Step = [string, string, string?];
interface Guide {
  id: string;
  title: string;
  roles: Role[];
  steps: Step[];
}

const ALL: Role[] = ["admin", "hq_staff", "store_manager", "store_staff"];

const GUIDES: Guide[] = [
  {
    id: "basic",
    title: "はじめに (全員)",
    roles: ALL,
    steps: [
      ["ログイン", "ログイン ID とパスワードを入力します。10 回続けて間違えると一時的にログインできなくなります。"],
      ["パスワードの変更", "右上の名前 → プロフィール →「パスワードを変更する」。最初のログインで必ず変更してください。", "/profile"],
      ["お知らせ", "右上のベルに、承認待ち・メンション・業務依頼・期日超過の請求などが表示されます。"],
      ["新規登録", "右上の「新規」から、問い合わせ・顧客・見積・予定・経費・業務依頼などをすぐに登録できます。"],
      ["スマートフォン", "同じ URL をスマートフォンのブラウザで開いて使えます。書類取込は、その場で撮影して送れます。"],
    ],
  },
  {
    id: "sales",
    title: "問い合わせから入金まで (店舗スタッフ・店長)",
    roles: ALL,
    steps: [
      ["1. 問い合わせ", "電話・来店などは「問い合わせ登録」で記録します。AI 電話受付・AI 相談・LINE・Web フォームからの受付は自動で登録されます。", "/inquiries"],
      ["2. 顧客", "問い合わせの画面で「顧客として登録する」。既存のお客様の候補が出たら「この顧客に紐づける」。", "/customers"],
      ["3. 見積", "「見積を作成」→ 明細を入力 →「承認を申請する」(金額によって店長・管理者の承認)。紙の手書き見積は「書類取込」から作れます。", "/quotes"],
      ["4. 受注", "見積の画面で「受注登録 (契約承認を申請)」。承認されると受注になります。", "/orders"],
      ["5. 予定", "受注の画面で引取・施工・納品の予定を担当者つきで登録すると、予定表に表示されます。重複は赤く表示されます。", "/schedule"],
      ["6. 施工完了", "受注の画面で「施工完了を登録」。売上はこの日付で計上されます。"],
      ["7. 請求・入金", "受注の画面で「請求書を発行」→ 請求の画面で PDF を確認して送付 → 入金があったら「入金を登録する」。", "/invoices"],
      ["案件の進み具合", "問い合わせから入金までの状況は「案件の進捗」で一覧できます。", "/cases"],
    ],
  },
  {
    id: "field",
    title: "現場・日々の業務 (全員)",
    roles: ALL,
    steps: [
      ["書類取込", "手書き見積・レシート・請求書・アンケートはがきなどを撮影 →「アップロードして読み取る」→ 読取結果を確認・修正して登録します。", "/capture"],
      ["経費", "レシートを取り込むか「経費を登録」。勘定科目の候補が出ます。「承認を申請」で店長・管理者が承認し、精算されます。", "/expenses"],
      ["連絡履歴", "お客様・協力業者との電話・メール・LINE・来店のやりとりを「連絡履歴」に記録し、案件にひも付けます。", "/contacts"],
      ["業務依頼", "「業務を依頼」で担当者と期限を指定 → 依頼された人は「依頼を確認しました (対応します)」→ 対応したら「報告する」→ 依頼した人が「報告を確認して完了にする」で完了です。", "/messages"],
      ["引き継ぎ", "問い合わせの画面の「担当者への引き継ぎ」で、ほかの社員に対応を引き継げます (相手に業務依頼が届きます)。"],
      ["AI アシスタント", "「田中様の履歴」「O-2026-0012 の状況」「支払方法は？」のように質問します。「文書の作成」タブでお客様向けの文面や日報の下書きを作れます。", "/ai"],
      ["要約", "見積・受注・経費・顧客・問い合わせの画面の「AI で要約」で、要点をまとめて表示します。"],
    ],
  },
  {
    id: "manager",
    title: "承認・管理 (店長・本部・管理者)",
    roles: ["admin", "hq_staff", "store_manager"],
    steps: [
      ["承認", "「承認」画面で内容を確認し「承認する」「差し戻す」(修正して再申請)「却下する」(取りやめ) を選びます。差戻し・却下は理由が必要です。", "/approvals"],
      ["経営ダッシュボード", "期間・店舗・担当者を選んで、売上・受注・施工・請求・入金・経費・仕入を確認します。各表は CSV で書き出せます (店長は自店舗のみ)。", "/reports"],
      ["社内資料", "AI が回答に使う資料 (価格の目安・手順・社内ルール・よくある質問) を登録します。", "/knowledge"],
      ["KPI", "アンケート・クレーム・口コミ・インセンティブを確認します。", "/kpi"],
      ["変更履歴", "誰がいつ何を変更・承認したかを、変更前と変更後の値つきで確認できます。", "/audit"],
    ],
  },
  {
    id: "office",
    title: "経理・本部の業務 (本部スタッフ・管理者)",
    roles: ["admin", "hq_staff"],
    steps: [
      ["入出金の予定", "未入金と支払待ちを一覧で確認します。", "/finance"],
      ["仕入・買掛", "仕入先の請求書を登録 →「支払依頼」→ 管理者の承認 → 支払完了を登録します。", "/purchases"],
      ["現金出納帳", "店舗ごとの現金の入出金を記録・集計します。現金の入金・経費の精算は自動で記帳されます。", "/cashbook"],
      ["会計データ", "仕訳と明細を CSV (汎用・弥生会計の形式) で出力します。", "/accounting"],
      ["データ入出力", "顧客・問い合わせの CSV・Google スプレッドシートの取込と、CSV の書き出しを行います。", "/data"],
      ["スプレッドシートの社内資料", "社内資料の画面で Google スプレッドシートを登録すると、毎時自動で同期されます (「今すぐ同期」もできます)。", "/knowledge"],
    ],
  },
  {
    id: "admin",
    title: "システムの管理 (管理者)",
    roles: ["admin"],
    steps: [
      ["社員の登録", "設定 → ユーザーと権限 で社員を追加し、初期パスワードを伝えます。退職者は無効にします (記録は残ります)。", "/settings?tab=users"],
      ["承認ルール", "設定 → 承認ルール・業務フロー で、管理者の承認が必要な金額などを変更します。", "/settings?tab=rules"],
      ["外部連携・AI", "設定 → 外部連携・AI で、AI の接続確認、メール・LINE・Chatwork のテスト送信、AI 受付の引き継ぎ先の設定を行います。", "/settings?tab=integrations"],
      ["本番運用の準備", "設定 → 本番運用の準備 で、データベース・セキュリティ・バックアップ・移行データの状態を確認します。", "/settings?tab=golive"],
      ["バックアップ・更新", "バックアップは毎日 3:30 に自動で行われます。システムの更新・復元の手順は、開発担当がまとめた運用手順 (deploy/README.md) に従います。"],
    ],
  },
  {
    id: "faq",
    title: "困ったとき",
    roles: ALL,
    steps: [
      ["ログインできない", "管理者に連絡してパスワードを再設定してもらってください (設定 → ユーザーと権限 → 社員の画面 →「再設定する」)。"],
      ["画面が古い・表示がおかしい", "ブラウザで再読み込み (スマートフォンは下に引っ張る) してください。"],
      ["AI の回答が違う", "AI は登録された資料とデータで答えます。社内資料を最新にするか、元の画面で確認してください。AI はデータを変更しません。"],
      ["写真がうまく読み取れない", "明るい場所で、書類全体が入るように撮り直すか、読取結果を手で修正して登録してください。"],
      ["間違えて登録した", "多くの記録は各画面から修正できます。修正の内容は変更履歴に残ります。削除できない記録は店長・管理者に相談してください。"],
    ],
  },
];

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
