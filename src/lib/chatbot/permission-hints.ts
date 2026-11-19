import "server-only";
import type { User } from "@/lib/db/types";
import { PERMISSION_TABLE } from "@/lib/auth/permission-table";
import { CELL_TEXT } from "./sources";
import { normalizeQuestion, similarity } from "./store";

const COL = { admin: "admin", hq_staff: "hq", store_manager: "manager", store_staff: "staff" } as const;

/** 質問に関係しそうな権限一覧の行と、質問した人のロールでできるか */
export function permissionHints(q: string, role: User["role"]): string[] {
  const norm = normalizeQuestion(q);
  return PERMISSION_TABLE.map((r) => ({ r, score: similarity(norm, normalizeQuestion(r.action.replace(/\s*\([^)]*\)/g, ""))) }))
    .filter((x) => x.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ r }) => `・${r.action} → ${CELL_TEXT[r[COL[role]]]}`);
}

