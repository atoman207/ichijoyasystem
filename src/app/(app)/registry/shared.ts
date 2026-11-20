import type { KnowledgeVisibility } from "@/lib/db/types";
import type { Tone } from "@/lib/constants";
import type { RegistryAction } from "@/lib/registry/classify";
import type { MaterialDoc } from "@/lib/registry/materials-db";
import type { DataStore } from "@/lib/registry/catalog";
import { KNOWLEDGE_VISIBILITY_LABEL } from "@/lib/knowledge";
import { ACTION_LABEL } from "@/lib/registry/classify";

/** データ台帳の画面で共通の表示 (色 + ラベル) */
export const ACTION_TONE: Record<RegistryAction, Tone> = { knowledge: "accent", materials: "info", structured: "good", ledger: "neutral", exclude: "warn" };

export const STATUS_LABEL: Record<MaterialDoc["status"], { label: string; tone: Tone }> = {
  ok: { label: "文字あり", tone: "good" },
  empty: { label: "文字なし", tone: "neutral" },
  error: { label: "読めない", tone: "critical" },
  skipped: { label: "取り込まない", tone: "warn" },
};

export const STORE_STATUS: Record<DataStore["status"], { label: string; tone: Tone }> = {
  ok: { label: "正常", tone: "good" },
  warn: { label: "要確認", tone: "warn" },
  off: { label: "未使用", tone: "neutral" },
};

export const VIS_KEYS = Object.keys(KNOWLEDGE_VISIBILITY_LABEL) as KnowledgeVisibility[];
export const ACTION_KEYS = Object.keys(ACTION_LABEL) as RegistryAction[];

export function fmtBytes(n?: number): string {
  if (!n) return "-";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export const num = (n: number) => n.toLocaleString("ja-JP");
