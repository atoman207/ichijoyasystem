import type { Database } from "@/lib/db/types";
import { updateKpiSettings } from "@/lib/actions/kpi";
import { formatTiers, kpiSettings } from "@/lib/kpi-settings";
import { Button, Card, CardHeader, Field, Input, Select } from "@/components/ui";
import { compareStoreIds } from "@/lib/store-order";

/** 設定 → KPI・インセンティブ (既定値は「お客様アンケート集計表」KPI シートの評価方法) */
export function KpiSettingsCard({ db, admin }: { db: Database; admin: boolean }) {
  const s = kpiSettings(db);
  const i = s.incentive;
  const users = db.users.filter((u) => u.active).sort((a, b) => compareStoreIds(a.storeId, b.storeId) || a.kana.localeCompare(b.kana, "ja"));
  const short = (id: string) => db.stores.find((x) => x.id === id)?.shortName ?? "";
  const chip = "inline-flex cursor-pointer items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:text-accent-ink";
  const tier = (name: string, label: string, value: string, hint: string) => (
    <Field label={label} hint={hint}>
      <Input name={name} defaultValue={value} disabled={!admin} className="font-mono text-xs" />
    </Field>
  );
  return (
    <Card>
      <CardHeader title="KPI・インセンティブのルール" description="既定値は「お客様アンケート集計表」の KPI シート (2025・2026 年度の評価方法) と同じです。変更は管理者のみ" />
      <form action={updateKpiSettings} className="space-y-5">
        <fieldset disabled={!admin} className="space-y-5">
          <div>
            <div className="label">事務担当 (① 電話対応・事務のクレーム率の支給対象)</div>
            <div className="flex flex-wrap gap-1.5">{users.map((u) => <label key={u.id} className={chip}><input type="checkbox" name="clerkUserIds" value={u.id} defaultChecked={s.clerkUserIds.includes(u.id)} className="sr-only" />{u.name} ({short(u.storeId)})</label>)}</div>
          </div>
          <div>
            <div className="label">集計・順位・支給から外す社員 (経営者の家族など。記録は残ります)</div>
            <div className="flex flex-wrap gap-1.5">{users.map((u) => <label key={u.id} className={chip}><input type="checkbox" name="excludedUserIds" value={u.id} defaultChecked={s.excludedUserIds.includes(u.id)} className="sr-only" />{u.name} ({short(u.storeId)})</label>)}</div>
          </div>
          <div>
            <div className="label">はがき登録時の事務担当の初期値 (店舗ごと)</div>
            <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @3xl:grid-cols-3">
              {db.stores.map((st) => (
                <Field key={st.id} label={st.name}>
                  <Select name={`clerk_${st.id}`} defaultValue={s.clerkByStore[st.id] ?? ""}>
                    <option value="">(なし)</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4 @5xl:grid-cols-7">
            <Field label="手直し (点)"><Input type="number" step="0.5" name="qp_rework" defaultValue={s.qualityPoints.rework} /></Field>
            <Field label="クレーム (点)"><Input type="number" step="0.5" name="qp_claim" defaultValue={s.qualityPoints.claim} /></Field>
            <Field label="クレーム＋手直し (点)"><Input type="number" step="0.5" name="qp_claim_rework" defaultValue={s.qualityPoints.claim_rework} /></Field>
            <Field label="同じ案件の上限 (点)" hint="0 = 上限なし"><Input type="number" step="0.5" min={0} name="qp_caseMax" defaultValue={s.qualityCaseMax} /></Field>
            <Field label="口コミ 1 点 (円)"><Input type="number" name="reviewYenPerPoint" defaultValue={s.reviewYenPerPoint} /></Field>
            <Field label="年度の開始月"><Input type="number" min={1} max={12} name="fiscalStartMonth" defaultValue={s.fiscalStartMonth} /></Field>
            <Field label="返信率の下限 (%)" hint="未満の店舗ははがきの項目なし"><Input type="number" name="replyGate" defaultValue={i.replyGate} /></Field>
          </div>
          <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
            {tier("t_replyRate", "はがき返信率 (%) 以上 → 店舗の職人 1 人あたり (円)", formatTiers(i.replyRate), "例: 60:70000 = 60% 以上で 7 万円")}
            {tier("t_phone", "① 電話対応 (全社平均) 以上 → 事務 1 人あたり", formatTiers(i.phone), "例: 4.7:50000")}
            {tier("t_score", "②③ (本人の平均)・④ (店舗の平均) 以上 → 1 人あたり", formatTiers(i.score), "例: 4.7:30000, 4.4:15000, 4.0:5000")}
            {tier("t_storeQuality", "店舗のクレーム・手直しポイント率 (%) 以下 → 職人 1 人あたり", formatTiers(i.storeQuality), "マイナスは減額。最後を超えたら最後の金額")}
            {tier("t_officeQuality", "事務のクレーム・手直しポイント率 (%) 以下 → 事務 1 人あたり", formatTiers(i.officeQuality), "例: 0:50000, 1:20000, 2:10000")}
          </div>
          <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
            <Field label="② 営業 MVP 1〜3 位 (円)"><Input name="m_sales" defaultValue={i.mvp.sales.join(", ")} /></Field>
            <Field label="③ 職人 MVP 1〜3 位 (円)"><Input name="m_craftsman" defaultValue={i.mvp.craftsman.join(", ")} /></Field>
            <Field label="口コミ件数 MVP 1〜3 位 (円)"><Input name="m_reviews" defaultValue={i.mvp.reviews.join(", ")} /></Field>
            <Field label="返信率 1 位の店舗 (円/人)"><Input type="number" name="m_replyTop" defaultValue={i.mvp.replyTop} /></Field>
            <Field label="④ 仕上り 1 位の店舗 (円/人)"><Input type="number" name="m_finishTop" defaultValue={i.mvp.finishTop} /></Field>
            <Field label="件数最少の単位 (円/人)"><Input type="number" name="m_fewestQuality" defaultValue={i.mvp.fewestQuality} /></Field>
            <Field label="率最低の店舗 (円/人)"><Input type="number" name="m_lowestQualityRate" defaultValue={i.mvp.lowestQualityRate} /></Field>
          </div>
          <div>
            <div className="label">月次の手当 (月締め・翌月に支給。KPI → インセンティブ の「月次の手当」で月ごとに決めます)</div>
            <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
              <Field label="月間人日の基準 (枚/人日)" hint="畳と襖類 (係数後)"><Input type="number" step="0.1" name="mo_manDayMin" defaultValue={i.monthly.manDayMin} /></Field>
              <Field label="月間人日 (円 × 人数 − 残業代)"><Input type="number" name="mo_manDayYen" defaultValue={i.monthly.manDayYen} /></Field>
              <Field label="伝票件数の基準 (件/事務 1 人)"><Input type="number" name="mo_slipPerClerk" defaultValue={i.monthly.slipPerClerk} /></Field>
              <Field label="伝票件数 (円 × 人数 − 残業代)"><Input type="number" name="mo_slipYen" defaultValue={i.monthly.slipYen} /></Field>
            </div>
          </div>
        </fieldset>
        {admin && <Button type="submit">保存</Button>}
      </form>
    </Card>
  );
}
