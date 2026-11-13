import { ShieldCheck } from "lucide-react";
import { PERMISSION_TABLE, type Cell } from "@/lib/auth/permission-table";
import { Badge, Card, CardHeader } from "@/components/ui";

const CELL_CLASS: Record<Cell, string> = {
  "○": "bg-good-soft text-good-ink",
  自店: "bg-info-soft text-info-ink",
  本人: "bg-accent-soft text-accent-ink",
  閲覧: "bg-neutral-soft text-ink-2",
  "−": "text-ink-3",
};
const CELL_TITLE: Record<Cell, string> = { "○": "全店舗", 自店: "所属店舗の情報のみ", 本人: "自分が登録・申請したもののみ", 閲覧: "見るだけ", "−": "できない" };

function C({ v }: { v: Cell }) {
  return <span title={CELL_TITLE[v]} className={`inline-block min-w-9 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold ${CELL_CLASS[v]}`}>{v}</span>;
}

/** ロールごとの権限 (閲覧・登録・編集と、店舗の範囲) の一覧 */
export function PermissionTableCard() {
  return (
    <Card padded={false}>
      <div className="px-5 pt-5">
        <CardHeader
          title="権限一覧 (ロール × 操作)"
          icon={<ShieldCheck />}
          description="○ = 全店舗 · 自店 = 所属店舗の情報のみ · 本人 = 自分が登録・申請したもののみ · 閲覧 = 見るだけ · − = できない。ロールと所属は上の一覧のユーザーごとに設定します"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs" data-testid="permission-table">
          <thead>
            <tr className="bg-subtle text-left text-ink-2">
              <th className="px-5 py-2 font-medium">区分</th>
              <th className="px-3 py-2 font-medium">操作</th>
              <th className="px-2 py-2 text-center font-medium">管理者</th>
              <th className="px-2 py-2 text-center font-medium">本部スタッフ</th>
              <th className="px-2 py-2 text-center font-medium">店長</th>
              <th className="px-2 py-2 text-center font-medium">店舗スタッフ</th>
            </tr>
          </thead>
          <tbody>
            {PERMISSION_TABLE.map((p, i) => (
              <tr key={i} className="border-t border-line align-top">
                <td className="px-5 py-1.5 whitespace-nowrap text-ink-2">{i === 0 || PERMISSION_TABLE[i - 1].group !== p.group ? p.group : ""}</td>
                <td className="px-3 py-1.5 text-ink">
                  {p.action}
                  {p.added && <Badge tone="accent" dot={false} className="ml-1.5 align-middle">追加</Badge>}
                </td>
                <td className="px-2 py-1.5 text-center"><C v={p.admin} /></td>
                <td className="px-2 py-1.5 text-center"><C v={p.hq} /></td>
                <td className="px-2 py-1.5 text-center"><C v={p.manager} /></td>
                <td className="px-2 py-1.5 text-center"><C v={p.staff} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
