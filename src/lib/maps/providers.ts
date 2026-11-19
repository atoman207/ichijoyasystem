import "server-only";
import type { MapLocation } from "@/lib/db/types";

/**
 * 外部の地図サービスとの境界 (住宅地図の提供元・住所からの位置の自動取得)
 * ------------------------------------------------------------
 * ゼンリン (住宅地図)
 * - ゼンリンは使用許諾を受けて使う外部のデータ提供元。自動取得 (API) は、次がすべてそろうまで使わない:
 *   ① ゼンリンの公式の API (または公式に認められた取得方法) の仕様と接続情報
 *   ② 契約で「社内サーバーへの保存」と「社内の複数人での閲覧」が認められていることの確認 (ZENRIN_LICENSE_CONFIRMED=yes)
 *   ③ その API 用のアダプター (このファイルの LIVE_ADAPTERS に追加する)
 * - ログイン画面の自動操作・ダウンロードの自動化・1 つのアカウントの使い回し・利用制限の回避はしない
 * - 自動取得が使えない間も、許諾を確認した PDF の登録 (画面・一括取込) と Google マップのリンクは使える
 * - 未接続のときに「取得できた」と表示しない (requestResidentialMap は必ず失敗を返す)
 *
 * Google (住所 → 緯度経度)
 * - GOOGLE_MAPS_API_KEY (Geocoding API) があるときだけ、場所の画面の「住所から位置を求める」で使う (1 件ずつ、人が押したときだけ。一括では送らない)
 * - 求めた位置は「未確認」または「要確認」とし、人が地図で確かめてから「確認済み」にする
 */

export interface ResidentialMapAdapter {
  id: string;
  label: string;
  /** 場所の住宅地図の PDF を取得する */
  fetchMap(location: Pick<MapLocation, "address" | "lat" | "lng">): Promise<{ bytes: Buffer; fileName: string; edition?: string; copyrightNotice: string; licenseRef?: string }>;
}

/** 実際に接続できる住宅地図のアダプター (公式 API の仕様と契約の確認がとれたものだけを追加する。2026-11 時点ではなし) */
const LIVE_ADAPTERS: Record<string, ResidentialMapAdapter> = {};

export interface ProviderStatus {
  provider: "zenrin";
  label: string;
  /** 自動取得が使えるか */
  enabled: boolean;
  /** 使えない理由・必要なもの */
  reasons: string[];
  /** 設定されている項目 (値は出さない) */
  configured: { endpoint: boolean; apiKey: boolean; licenseConfirmed: boolean; adapter: boolean };
}

export function zenrinStatus(): ProviderStatus {
  const configured = {
    endpoint: Boolean(process.env.ZENRIN_API_ENDPOINT?.trim()),
    apiKey: Boolean(process.env.ZENRIN_API_KEY?.trim()),
    licenseConfirmed: process.env.ZENRIN_LICENSE_CONFIRMED?.trim().toLowerCase() === "yes",
    adapter: Boolean(LIVE_ADAPTERS.zenrin),
  };
  const reasons: string[] = [];
  if (!configured.adapter) reasons.push("ゼンリンの公式 API (または公式に認められた取得方法) の仕様が確認できていないため、接続用のアダプターがありません");
  if (!configured.endpoint || !configured.apiKey) reasons.push("API の接続先・認証情報 (ZENRIN_API_ENDPOINT・ZENRIN_API_KEY) が設定されていません");
  if (!configured.licenseConfirmed) reasons.push("契約で社内サーバーへの保存と社内の複数人での閲覧が認められていることの確認 (ZENRIN_LICENSE_CONFIRMED=yes) がありません");
  return { provider: "zenrin", label: "ゼンリン 住宅地図", enabled: reasons.length === 0, reasons, configured };
}

/** 住宅地図の自動取得。使えないときは理由つきで失敗を返す (取得できたように見せない) */
export async function requestResidentialMap(location: Pick<MapLocation, "address" | "lat" | "lng">): Promise<{ ok: true; bytes: Buffer; fileName: string; edition?: string; copyrightNotice: string; licenseRef?: string } | { ok: false; error: string }> {
  const st = zenrinStatus();
  if (!st.enabled) return { ok: false, error: `住宅地図の自動取得は使えません: ${st.reasons.join(" / ")}。許諾を確認した PDF を登録してください。` };
  try {
    const r = await LIVE_ADAPTERS.zenrin.fetchMap(location);
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: `住宅地図の取得に失敗しました: ${(err as Error).message}` };
  }
}

/* ---------------- Google Geocoding ---------------- */

export function geocodingEnabled(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim());
}

export interface GeocodeCandidate {
  lat: number;
  lng: number;
  placeId?: string;
  formattedAddress: string;
  /** ROOFTOP (建物) / RANGE_INTERPOLATED / GEOMETRIC_CENTER / APPROXIMATE */
  locationType: string;
  partialMatch: boolean;
}

/**
 * 住所から位置を求める (Google Geocoding API)。候補が 1 つで建物の位置 (ROOFTOP) かつ部分一致でないときだけ unverified、
 * それ以外は needs_review。どちらも人が地図で確かめるまで「確認済み」にしない
 */
export async function geocode(address: string): Promise<{ ok: true; best: GeocodeCandidate; candidates: GeocodeCandidate[]; status: "unverified" | "needs_review"; note: string } | { ok: false; error: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) return { ok: false, error: "Google の位置の自動取得は設定されていません (GOOGLE_MAPS_API_KEY)。地図で位置を確かめて手で入力してください。" };
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&language=ja&region=jp&key=${encodeURIComponent(key)}`;
  let body: { status: string; error_message?: string; results?: { formatted_address: string; place_id?: string; partial_match?: boolean; geometry: { location: { lat: number; lng: number }; location_type: string } }[] };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    body = (await res.json()) as typeof body;
  } catch (err) {
    return { ok: false, error: `Google に接続できませんでした (${(err as Error).message})。` };
  }
  if (body.status === "ZERO_RESULTS") return { ok: false, error: "Google で住所が見つかりませんでした。地図で位置を確かめて手で入力してください。" };
  if (body.status !== "OK" || !body.results?.length) return { ok: false, error: `Google の位置の取得に失敗しました (${body.status}${body.error_message ? `: ${body.error_message}` : ""})。` };
  const candidates: GeocodeCandidate[] = body.results.slice(0, 5).map((r) => ({ lat: r.geometry.location.lat, lng: r.geometry.location.lng, placeId: r.place_id, formattedAddress: r.formatted_address, locationType: r.geometry.location_type, partialMatch: Boolean(r.partial_match) }));
  const best = candidates[0];
  const precise = candidates.length === 1 && best.locationType === "ROOFTOP" && !best.partialMatch;
  const note = `Google の候補 ${candidates.length} 件 / 精度 ${best.locationType}${best.partialMatch ? " / 部分一致" : ""} / ${best.formattedAddress}`;
  return { ok: true, best, candidates, status: precise ? "unverified" : "needs_review", note };
}
