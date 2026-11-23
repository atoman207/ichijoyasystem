/**
 * パソコンのカメラの選び方 (CameraDialog が使う。ブラウザーの API を使わないので単体テストできる)
 * ------------------------------------------------------------
 * パソコンにつながるカメラ: 内蔵カメラ・USB の Web カメラ・書画カメラ・スマートフォン
 * (Android の USB の「ウェブカメラ」・Windows 11 の「スマートフォン連携」・Camo などのアプリ・Mac の連係カメラ)。
 * どれもブラウザーには「カメラ」の 1 つとして見えるので、システムの側は区別せずに選ぶ。
 *
 * 開く順番:
 * 1. 前に選んだカメラ (ID が同じ)
 * 2. 前に選んだカメラ (名前が同じ。USB をつなぎ直すと ID が変わることがあるため)
 * 3. スマートフォン・書画カメラらしい名前のカメラ、または内蔵カメラ以外のカメラ (内蔵カメラと並んでいるとき)
 * 4. ブラウザーの既定
 * カメラの名前はカメラの使用を許可したあとでないと分からない (許可の前は 4 になり、許可のあとで選び直す)。
 */

export interface CameraInfo {
  id: string;
  label: string;
}

export interface SavedCamera {
  id?: string;
  label?: string;
}

export type PickReason = "saved" | "saved-label" | "preferred" | "external" | "default";

/** スマートフォン (USB のウェブカメラ・アプリ・連係カメラ) と書画カメラの名前 */
const PREFERRED = /android|pixel|galaxy|xperia|aquos|arrows|motorola|moto |iphone|ipad|continuity|camo|droidcam|iriun|ivcam|epoccam|phone|スマートフォン|ipevo|elmo|czur|okiocam|document|書画|visualizer/i;
/** 内蔵カメラの名前 */
const BUILT_IN = /integrated|built-?in|内蔵|facetime|internal|truevision|surface camera|front camera|user-facing/i;

export const isPreferredCamera = (label: string) => PREFERRED.test(label);
export const isBuiltInCamera = (label: string) => BUILT_IN.test(label) && !PREFERRED.test(label);

export function pickCamera(list: CameraInfo[], saved?: SavedCamera | null): { id?: string; reason: PickReason } {
  const usable = list.filter((c) => c.id);
  if (saved?.id && usable.some((c) => c.id === saved.id)) return { id: saved.id, reason: "saved" };
  if (saved?.label) {
    const same = usable.find((c) => c.label === saved.label);
    if (same) return { id: same.id, reason: "saved-label" };
  }
  const named = usable.filter((c) => c.label);
  const preferred = named.filter((c) => isPreferredCamera(c.label));
  if (preferred.length) return { id: preferred[preferred.length - 1].id, reason: "preferred" };
  const builtIn = named.filter((c) => isBuiltInCamera(c.label));
  const others = named.filter((c) => !isBuiltInCamera(c.label));
  if (builtIn.length && others.length) return { id: others[others.length - 1].id, reason: "external" };
  return { reason: "default" };
}

/** 覚えたカメラ (以前は ID だけを文字で保存していた) */
export function parseSavedCamera(raw: string | null | undefined): SavedCamera | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : undefined;
      const label = typeof o.label === "string" ? o.label : undefined;
      return id || label ? { id, label } : undefined;
    }
  } catch {
    // 以前の形式 (ID の文字だけ)
  }
  return { id: raw };
}
