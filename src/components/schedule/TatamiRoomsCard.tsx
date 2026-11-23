import type { ReactNode } from "react";
import type { TatamiRoom } from "@/lib/db/types";
import { Card, CardHeader } from "@/components/ui";
import { TatamiRoomsTable, pendingRoomCount } from "./TatamiRoomsTable";
import { TatamiRoomsEditor } from "./TatamiRoomsEditor";

/**
 * 受注・見積の画面の「畳の仕様 (部屋ごと)」(畳表・畳縁・畳床・寸法。畳製造予定に出る)。src/lib/tatami-spec.ts
 */
export function TatamiRoomsCard({
  rooms,
  sourceLabel,
  auto,
  action,
  editable,
  idPrefix,
  description,
  note,
}: {
  rooms: TatamiRoom[];
  sourceLabel: string;
  auto: TatamiRoom[];
  action: (formData: FormData) => void | Promise<void>;
  editable: boolean;
  idPrefix: string;
  description: string;
  note?: ReactNode;
}) {
  const pending = pendingRoomCount(rooms);
  return (
    <Card id="tatami-rooms">
      <CardHeader title="畳の仕様 (部屋ごと)" description={description} />
      {rooms.length ? (
        <>
          <TatamiRoomsTable rooms={rooms} />
          <p className="mt-1 text-[11px] text-ink-3">
            {sourceLabel}
            {pending > 0 && <span className="ml-2 font-semibold text-warn-ink">未確認のある部屋 {pending}</span>}
          </p>
        </>
      ) : (
        <p className="text-sm text-ink-3">畳の明細がありません。製造する畳があるときは「部屋を追加」で入れてください。</p>
      )}
      {note}
      {editable && (
        <details className="mt-3 rounded-lg border border-line" open={!rooms.length} data-testid="rooms-edit">
          <summary className="cursor-pointer px-3 py-1.5 text-sm font-medium text-accent-ink">仕様を入力・変更</summary>
          <div className="border-t border-line p-3">
            <TatamiRoomsEditor action={action} initial={rooms} auto={auto} idPrefix={idPrefix} />
          </div>
        </details>
      )}
    </Card>
  );
}
