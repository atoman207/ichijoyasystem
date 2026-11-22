import type { MapUsePurpose } from "@/lib/db/types";

/**
 * 住宅地図の用途 (ゼンリン GIS の「印刷」「画像出力」で選ぶ用途と、その地図でしてよいこと)
 * ゼンリンの利用条件: 社内の資料はご契約部署の中だけ。施主様などお客様・取引先・不特定多数に見せるときは、別に「地図複製利用」の手続きが必要
 * (https://gis.zenrin.co.jp/product/gis/pkg/bufc/manual/export_map.html の「注意事項」)
 */

export const MAP_USE_PURPOSES: MapUsePurpose[] = ["internal", "official", "contractor", "neighbors"];

export const MAP_USE_PURPOSE_LABEL: Record<MapUsePurpose, string> = {
  internal: "社内の資料 (内部利用)",
  official: "官公署への届出",
  contractor: "工事関係者への配布",
  neighbors: "近隣住民への説明",
};

/** その地図でしてよいこと (画面の注意書き) */
export const MAP_USE_PURPOSE_NOTE: Record<MapUsePurpose, string> = {
  internal: "社内 (ご契約部署) の中だけで使います。お客様 (施主様)・取引先には渡せません (渡すときは地図複製利用の手続きが必要)。",
  official: "許認可の申請・届出の書類に添付できます。それ以外の第三者には渡せません。",
  contractor: "工事関係者 (協力業者など) に現場の案内図として渡せます。お客様 (施主様) には渡せません。",
  neighbors: "工事の案内として現場の周辺住民に配れます。",
};

export const isMapUsePurpose = (v: unknown): v is MapUsePurpose => typeof v === "string" && (MAP_USE_PURPOSES as string[]).includes(v);

/** ゼンリン GIS (ZENRIN GISパッケージ 建設 for 施工) の画面。ログインはご自身の ID で (システムは自動でログインしない) */
export const ZENRIN_GIS = { label: "ゼンリン GIS", url: "https://app.zip-site.com/bufc/app/" };
