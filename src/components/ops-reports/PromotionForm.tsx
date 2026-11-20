import type { Promotion, Store } from "@/lib/db/types";
import { MEDIA, MEDIA_KEYS } from "@/lib/media";
import { PROMOTION_KIND, PROMOTION_KINDS, PROMOTION_STATUS } from "@/lib/ops-reports/promo-analysis";
import { areasText } from "@/lib/ops-reports/promo-input";
import { Button, Field, FormActions, Input, LinkButton, Select, Textarea } from "@/components/ui";

/** 販促の記録の登録・変更のフォーム (チラシ・イベント・点検の DM・テレアポ) */
export function PromotionForm({ action, promotion, stores, storeLocked, defaultStore, cancelHref, submitLabel, disabled }: { action: (fd: FormData) => Promise<void>; promotion?: Promotion; stores: Store[]; storeLocked: boolean; defaultStore: string; cancelHref: string; submitLabel: string; disabled?: boolean }) {
  const p = promotion;
  return (
    <form action={action} className="space-y-5">
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @3xl:grid-cols-3">
        <Field label="種類" required>
          <Select name="kind" defaultValue={p?.kind ?? "flyer"}>
            {PROMOTION_KINDS.map((k) => <option key={k} value={k}>{PROMOTION_KIND[k].label}</option>)}
          </Select>
        </Field>
        <Field label="名前" required className="@3xl:col-span-2">
          <Input name="title" required defaultValue={p?.title} placeholder="例: 2026年4月 合志店 新聞折込チラシ / 春の畳フェア / 点検のご案内 DM" />
        </Field>
        <Field label="店舗" hint={storeLocked ? "店長は自店舗の販促だけを登録できます" : "全社の販促は「本社」"}>
          <Select name="storeId" defaultValue={p?.storeId ?? defaultStore} disabled={storeLocked}>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="状態" hint="年間のチラシ計画は「計画」で登録し、配布したら「実施済み」にします">
          <Select name="status" defaultValue={p?.status ?? "done"}>
            {(Object.keys(PROMOTION_STATUS) as (keyof typeof PROMOTION_STATUS)[]).map((k) => <option key={k} value={k}>{PROMOTION_STATUS[k].label}</option>)}
          </Select>
        </Field>
        <Field label="媒体 (この販促から来た問い合わせの媒体)" hint="空なら種類から決めます (チラシ → チラシ、点検の DM → DM・点検のご案内)">
          <Select name="media" defaultValue={p?.media ?? ""}>
            <option value="">種類から決める</option>
            {MEDIA_KEYS.filter((k) => k !== "unknown").map((k) => <option key={k} value={k}>{MEDIA[k].label}</option>)}
          </Select>
        </Field>
        <Field label="配布日・開始日" required hint="配布月はこの日の月で数えます">
          <Input type="date" name="startDate" required defaultValue={p?.startDate} />
        </Field>
        <Field label="終了日" hint="イベントの最終日・ポスティングの終了日 (任意)">
          <Input type="date" name="endDate" defaultValue={p?.endDate} />
        </Field>
        <Field label="費用 (円・任意)">
          <Input name="cost" inputMode="numeric" defaultValue={p?.cost ?? ""} placeholder="例: 120000" />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <Field label="地域と部数 (1 行に 1 地域)" className="@3xl:col-span-2" hint="「合志市須屋 3000」のように町名と部数を書きます。地域を書くと部数は合計になり、分析で地域ごとの部数あたりの問い合わせを出します">
          <Textarea name="areas" rows={6} defaultValue={p ? areasText(p.areas) : ""} placeholder={"合志市須屋 3000\n合志市幾久富 2500\n菊陽町光の森 4000"} />
        </Field>
        <div className="space-y-4">
          <Field label="部数・件数 (地域を書かないとき)" hint="チラシは部数、DM は送付数、テレアポは架電数、イベントは来場者数 (わかれば)">
            <Input name="copies" inputMode="numeric" defaultValue={p && !p.areas.length ? p.copies : ""} placeholder="例: 15000" />
          </Field>
          <Field label="配布業者・依頼先・会場 (任意)">
            <Input name="vendor" defaultValue={p?.vendor} placeholder="例: 熊日折込 / ○○ホール" />
          </Field>
        </div>
      </div>
      <Field label="メモ">
        <Textarea name="note" defaultValue={p?.note} placeholder="内容・狙い・反省点など" />
      </Field>
      <FormActions>
        <LinkButton href={cancelHref} variant="secondary">キャンセル</LinkButton>
        <Button type="submit" disabled={disabled}>{submitLabel}</Button>
      </FormActions>
    </form>
  );
}
