"use client";

import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import type { StoreId } from "@/lib/db/types";
import { guessAreaStore } from "@/lib/actions/areas";
import type { AreaStore } from "@/lib/store-area";

/**
 * 担当店舗 (施工・売上計上の店舗) の選択。同じフォームの住所の欄 (watch の順: 施工現場 → 住所) を見て、担当エリアの店舗を自動で選ぶ
 * (お客様のご要望 2026-11-24「③」・2026-11-26「■2」。src/lib/store-area.ts)。住所の欄が空ならお客様の住所 (fallbackAddress)。
 * 既存の案件に追加するとき (caseStore) は案件の店舗。手で選んだら、それ以降は自動で変えない (「自動で選ぶに戻す」で戻す)。
 * 送る項目: storeId・storeAuto (手で選んでいないとき "1" = サーバーでも住所・案件で決め直す)
 */
export function AutoStoreSelect({
  stores,
  canChooseAny,
  fallbackStoreId,
  choices = [],
  watch = ["siteAddress", "address"],
  initialAddress = "",
  fallbackAddress = "",
  initialArea,
  caseStore,
  initialStoreId,
  initialManual = false,
  label = "担当店舗 (施工・売上計上の店舗)",
  testId = "area-store",
  onValue,
}: {
  stores: { id: StoreId; name: string }[];
  /** 全店舗から選べる (全店舗のロール) */
  canChooseAny: boolean;
  /** 住所で決まらないときの店舗 (お客様の店舗・受け付けた店舗) */
  fallbackStoreId: StoreId;
  /** 全店舗から選べない人が選べる店舗 (自店舗など。住所の担当エリアの店舗・案件の店舗は自動で足す) */
  choices?: StoreId[];
  /** 見る住所の欄 (フォームの name。先にあるほうを使う) */
  watch?: string[];
  /** 画面を開いたときの住所の欄の値 (watch の順で最初の空でない値) */
  initialAddress?: string;
  /** 住所の欄が空のときに使う住所 (選んだお客様の住所) */
  fallbackAddress?: string;
  /** 画面を開いたときの住所の担当エリア (サーバーで判定済み。読み込み直しを省く) */
  initialArea?: AreaStore | null;
  /** 既存の案件に追加するときの案件の店舗 */
  caseStore?: { id: StoreId; name: string; number: string };
  /** 前に選んだ店舗 (initialManual のとき使う) */
  initialStoreId?: StoreId;
  initialManual?: boolean;
  label?: string;
  testId?: string;
  /** 選んでいる店舗が変わったとき (担当者の初期値を店舗に合わせる) */
  onValue?: (storeId: StoreId) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState(initialAddress.trim());
  const address = typed || fallbackAddress.trim();
  // initialArea がなければ、開いたときの住所も確かめる
  const [guess, setGuess] = useState<{ address: string; area: AreaStore | null }>({ address: initialArea === undefined ? "" : address, area: initialArea ?? null });
  const [checking, setChecking] = useState(false);
  const [manual, setManual] = useState(Boolean(initialManual && initialStoreId));
  const [picked, setPicked] = useState<StoreId>(initialStoreId ?? fallbackStoreId);
  const seq = useRef(0);
  const watchKey = watch.join(",");

  // 同じフォームの住所の欄の入力を見る
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const names = watchKey.split(",");
    const onInput = (e: Event) => {
      const t = e.target as HTMLInputElement | null;
      if (!t?.name || !names.includes(t.name)) return;
      const fd = new FormData(form);
      const v = names.map((n) => String(fd.get(n) ?? "").trim()).find(Boolean) ?? "";
      setTyped(v);
    };
    form.addEventListener("input", onInput);
    return () => form.removeEventListener("input", onInput);
  }, [watchKey]);

  // 住所が変わったら担当エリアを確かめ直す (入力が止まって 0.4 秒後)
  useEffect(() => {
    if (address === guess.address) return;
    const id = ++seq.current;
    const t = setTimeout(() => {
      if (address.length < 2) {
        setGuess({ address, area: null });
        return;
      }
      setChecking(true);
      guessAreaStore(address)
        .then((g) => seq.current === id && setGuess({ address, area: g }))
        .catch(() => seq.current === id && setGuess({ address, area: null }))
        .finally(() => seq.current === id && setChecking(false));
    }, 400);
    return () => clearTimeout(t);
  }, [address, guess.address]);

  // 確かめ直している間は前の結果のまま
  const area = guess.area;
  const auto: StoreId = caseStore?.id ?? area?.storeId ?? fallbackStoreId;
  const value: StoreId = manual ? picked : auto;
  const allowed = new Set<string>([...choices, fallbackStoreId, value, ...(area ? [area.storeId] : []), ...(caseStore ? [caseStore.id] : [])]);
  const options = canChooseAny ? stores : stores.filter((s) => allowed.has(s.id));
  useEffect(() => {
    onValue?.(value);
  }, [onValue, value]);
  const nameOf = (id: string) => stores.find((s) => s.id === id)?.name ?? id;

  const note = checking
    ? "住所から担当店舗を確かめています…"
    : manual
      ? caseStore && value !== caseStore.id
        ? `手で選んだ店舗にします (追加する案件 ${caseStore.number} の店舗は ${caseStore.name})`
        : area && value !== area.storeId
          ? `手で選んだ店舗にします (住所の担当エリアは ${area.storeName})`
          : "手で選んだ店舗にします"
      : caseStore
        ? `追加する案件 ${caseStore.number} の店舗: ${caseStore.name} (変えるときは選び直してください)`
        : area
          ? `住所から自動: ${area.storeName} (「${area.town}」の地域)。必要なら選び直してください`
          : address.length >= 2
            ? `住所から担当店舗を決められませんでした (地域一覧にない地域)。${nameOf(fallbackStoreId)}にします。必要なら選んでください`
            : `住所を入れると、担当エリアの店舗を自動で選びます (いまは ${nameOf(fallbackStoreId)})`;

  return (
    <div ref={ref}>
      <label className="block">
        <span className="label">{label}</span>
        <input type="hidden" name="storeAuto" value={manual ? "" : "1"} />
        <select
          name="storeId"
          value={value}
          onChange={(e) => {
            setPicked(e.target.value as StoreId);
            setManual(true);
          }}
          className="field"
          data-testid={testId}
        >
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.id === caseStore?.id ? " (案件の店舗)" : s.id === area?.storeId ? " (住所の担当エリア)" : ""}
            </option>
          ))}
        </select>
        <span className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-ink-3" aria-live="polite" data-testid={`${testId}-note`}>
          <MapPin className="mt-px h-3 w-3 shrink-0" aria-hidden />
          {note}
        </span>
      </label>
      {manual && (
        <button type="button" onClick={() => setManual(false)} className="mt-0.5 text-[11px] text-accent hover:underline">
          {caseStore ? "案件の店舗に戻す" : "住所から自動で選ぶに戻す"}
        </button>
      )}
    </div>
  );
}
