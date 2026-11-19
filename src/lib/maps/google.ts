/**
 * Google マップのリンク (公式の Maps URLs: https://developers.google.com/maps/documentation/urls/get-started)
 * ------------------------------------------------------------
 * - 必ず api=1 を付ける。値は encodeURIComponent で符号化する (緯度経度の「,」は %2C)
 * - 位置の優先順: 確認済みの緯度経度 > Place ID (住所を予備に付ける) > 住所の文字
 *   (確認していない緯度経度は使わない。住所が完全でも位置が正しいとは限らないため、人が地図で確かめたものだけを使う)
 * - API キーは不要 (リンクを開くのは利用者のブラウザ・スマートフォンの Google マップ)
 * このファイルは画面 (クライアント) からも読み込む
 */

export interface MapTarget {
  /** 住所の文字 (表示用に整えたもの) */
  address?: string;
  lat?: number;
  lng?: number;
  /** 緯度経度を人が確認した (地図で位置を合わせた) */
  coordsVerified?: boolean;
  /** Google の Place ID */
  placeId?: string;
}

export type MapLinkBasis = "coords" | "place_id" | "address" | "none";

export function validCoords(lat: unknown, lng: unknown): lat is number {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/** 日本の範囲 (おおよそ)。外れていれば入力の間違い (緯度と経度の逆など) の可能性が高い */
export function inJapan(lat: number, lng: number): boolean {
  return lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154;
}

/** 緯度経度の表示・URL 用 (小数 7 桁 ≒ 1 cm。末尾の 0 は省く) */
export function fmtCoord(n: number): string {
  return String(Math.round(n * 1e7) / 1e7);
}

/** Google の Place ID らしい文字か (英数・_・- のみ、10〜300 文字) */
export function validPlaceId(id: string | undefined | null): boolean {
  return Boolean(id && /^[A-Za-z0-9_-]{10,300}$/.test(id));
}

function linkPoint(t: MapTarget): { basis: MapLinkBasis; query?: string; placeId?: string } {
  const placeId = validPlaceId(t.placeId) ? t.placeId : undefined;
  if (t.coordsVerified && validCoords(t.lat, t.lng)) return { basis: "coords", query: `${fmtCoord(t.lat!)},${fmtCoord(t.lng!)}`, placeId };
  const address = t.address?.trim();
  if (placeId) return { basis: "place_id", query: address || placeId, placeId };
  if (address) return { basis: "address", query: address };
  return { basis: "none" };
}

/** 地図で場所を開く (検索) のリンク */
export function mapsSearchUrl(t: MapTarget): string | undefined {
  const p = linkPoint(t);
  if (p.basis === "none" || !p.query) return undefined;
  let url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.query)}`;
  if (p.placeId) url += `&query_place_id=${encodeURIComponent(p.placeId)}`;
  return url;
}

/** 経路案内 (現在地から) のリンク。出発地を指定しないと、スマートフォンでは現在地からの案内になる */
export function mapsDirectionsUrl(t: MapTarget, travelmode: "driving" | "walking" | "transit" | "bicycling" = "driving"): string | undefined {
  const p = linkPoint(t);
  if (p.basis === "none" || !p.query) return undefined;
  let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.query)}`;
  if (p.placeId) url += `&destination_place_id=${encodeURIComponent(p.placeId)}`;
  return `${url}&travelmode=${travelmode}`;
}

export function mapLinkBasis(t: MapTarget): MapLinkBasis {
  return linkPoint(t).basis;
}

export const BASIS_LABEL: Record<MapLinkBasis, string> = {
  coords: "確認済みの位置 (緯度経度)",
  place_id: "Google の場所 ID",
  address: "住所の文字で検索",
  none: "位置の情報なし",
};

/**
 * 位置の手入力を読む: 「32.8031, 130.7079」/ Google マップの URL (…/@32.8031,130.7079,17z・?q=32.8,130.7・!3d32.8!4d130.7・query=32.8%2C130.7)
 */
export function parseCoordinates(input: string | undefined | null): { lat: number; lng: number } | null {
  if (!input) return null;
  let s = input.trim().normalize("NFKC");
  try {
    if (/%2C/i.test(s)) s = decodeURIComponent(s);
  } catch {
    /* そのまま */
  }
  const pats = [/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, /[?&](?:q|query|ll|destination|center)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, /^\(?\s*(-?\d+(?:\.\d+)?)\s*[,，、\s]\s*(-?\d+(?:\.\d+)?)\s*\)?$/];
  for (const re of pats) {
    const m = re.exec(s);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (validCoords(lat, lng)) return { lat, lng };
  }
  return null;
}
