"use client";

import { Eraser } from "lucide-react";
import { AssistantConversation, useChatState } from "./AssistantChat";

/** AI アシスタントの画面の会話 (画面左下のチャットボットとは別の会話) */
export function AssistantPage({ userName, userId, avatarSrc }: { userName: string; userId: string; avatarSrc?: string }) {
  const state = useChatState("ichijoya-assistant-page");
  return (
    <div className="flex h-[calc(100dvh-12rem)] min-h-[520px] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-subtle/40 px-4 py-2.5 text-xs text-ink-3">
        <p className="min-w-0 leading-relaxed">
          回答は相談の履歴に残ります。続けて「店舗別にして」「前年と比べて」と聞くと、前の集計条件を引き継ぎます。
        </p>
        {state.msgs.length > 0 && (
          <button type="button" onClick={state.reset} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-ink-2 hover:bg-subtle hover:text-ink">
            <Eraser className="h-3.5 w-3.5" aria-hidden /> 新しい会話
          </button>
        )}
      </div>
      <AssistantConversation state={state} userName={userName} user={{ id: userId, name: userName, avatarSrc }} variant="page" />
    </div>
  );
}
