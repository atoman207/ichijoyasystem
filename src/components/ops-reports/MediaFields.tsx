import type { MediaKey, Promotion, StoreId } from "@/lib/db/types";
import { MEDIA, MEDIA_KEYS, MEDIA_SOURCE_LABEL, mediaLabel, type MediaSource } from "@/lib/media";
import { Select } from "@/components/ui";

/** 媒体 (当社を知ったきっかけ) の選択。required なら「選んでください」を選んだままでは送れない */
export function MediaSelect({ name, defaultValue, required, className }: { name: string; defaultValue?: MediaKey | ""; required?: boolean; className?: string }) {
  return (
    <Select name={name} defaultValue={defaultValue ?? ""} required={required} className={className}>
      <option value="">選んでください</option>
      {MEDIA_KEYS.map((k) => (
        <option key={k} value={k} title={MEDIA[k].hint}>
          {MEDIA[k].label}
        </option>
      ))}
    </Select>
  );
}

export interface PromotionOption {
  id: string;
  label: string;
}

/** きっかけの販促の選択肢 (中止を除く。直近 13 か月と今後のもの、新しい順) */
export function promotionOptions(promotions: Promotion[], canSee: (storeId: StoreId) => boolean, keepId?: string): PromotionOption[] {
  const since = new Date();
  since.setMonth(since.getMonth() - 13);
  const sinceKey = since.toISOString().slice(0, 10);
  return promotions
    .filter((p) => p.id === keepId || (p.status !== "cancelled" && canSee(p.storeId) && (p.endDate ?? p.startDate) >= sinceKey))
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .map((p) => ({ id: p.id, label: `${p.startDate.replaceAll("-", "/")} ${p.title} (${p.number})` }));
}

export function PromotionSelect({ name, options, defaultValue }: { name: string; options: PromotionOption[]; defaultValue?: string }) {
  return (
    <Select name={name} defaultValue={defaultValue ?? ""}>
      <option value="">(なし)</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

/** 媒体の表示 (推定は点線の枠と出どころのツールチップ) */
export function MediaTag({ media, source, raw }: { media: MediaKey | null; source: MediaSource; raw?: string }) {
  const estimated = source !== "input" && source !== "none";
  const title = estimated ? `${MEDIA_SOURCE_LABEL[source]}${raw ? ` (元の値: ${raw})` : ""}` : source === "none" ? "媒体の入力がなく、過去の記録からも読み替えられません" : "問い合わせに入力した媒体";
  return (
    <span
      title={title}
      className={
        media
          ? estimated
            ? "inline-flex items-center rounded-md border border-dashed border-line bg-panel px-1.5 py-0.5 text-[11px] whitespace-nowrap text-ink-2"
            : "inline-flex items-center rounded-md border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[11px] whitespace-nowrap text-accent-ink"
          : "inline-flex items-center rounded-md border border-warn/40 bg-warn-soft px-1.5 py-0.5 text-[11px] whitespace-nowrap text-warn-ink"
      }
    >
      {mediaLabel(media)}
      {estimated && <span className="ml-1 text-[10px] text-ink-3">推定</span>}
    </span>
  );
}
