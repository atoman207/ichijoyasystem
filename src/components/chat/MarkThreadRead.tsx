"use client";

import { useEffect } from "react";
import { markChatRead } from "@/lib/actions/chat";
import { signalChatRefresh } from "./client";

/** 社内連絡・業務依頼のスレッドを開いたら、そのスレッドのメンションを既読にする (チャットのアイコンの要対応から外す) */
export function MarkThreadRead({ threadId, at }: { threadId: string; at: string }) {
  useEffect(() => {
    void markChatRead(`thread:${threadId}`, at)
      .then(() => signalChatRefresh())
      .catch(() => undefined);
  }, [threadId, at]);
  return null;
}
