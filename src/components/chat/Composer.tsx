"use client";

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import clsx from "clsx";
import { AlertTriangle, AtSign, Bold, Camera, Code, FileText, Italic, Link2, List, ListOrdered, ListTodo, Loader2, Lock, Paperclip, Quote, SendHorizontal, Smile, SquareCode, Strikethrough, Type, X } from "lucide-react";
import { chatTyping, sendChatMessage } from "@/lib/actions/chat";
import { matchName, mentionQuery, mentionText } from "@/lib/chat/text";
import { CHAT_MAX_FILES, channelLabel, type ChatChannelView, type ChatFileAccess, type ChatMessageView, type ChatTaskInput } from "@/lib/chat/types";
import { prepareFile } from "@/components/attachments/image-prep";
import { sizeLabel } from "./client";
import { emptyTask, ErrorLine, TaskFields } from "./dialogs";
import { EmojiPicker, UserAvatar, nameOf, type Dir } from "./parts";

export interface ComposerHandle {
  addFiles: (files: File[]) => void;
  focus: () => void;
}

interface Pending {
  key: string;
  name: string;
  size: number;
  preview?: string;
  photo: boolean;
  progress: number;
  uploadId?: string;
  error?: string;
  access: ChatFileAccess;
}

interface Suggest {
  kind: "user" | "store" | "all";
  id: string;
  label: string;
  sub: string;
  insert: string;
}

const draftKey = (channelId: string, parentId?: string) => `ichijoya-chat-draft:${channelId}:${parentId ?? ""}`;

function readDraft(k: string): string {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(k: string, v: string) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    // 保存できない (プライベートモードなど)
  }
}

/** 1 ファイルを預ける (進み具合つき) */
function upload(channelId: string, file: File, extra: { thumb?: Blob; width?: number; height?: number }, onProgress: (p: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.set("channelId", channelId);
    fd.set("file", file, file.name);
    if (extra.thumb) fd.set("thumb", extra.thumb, "thumb.jpg");
    if (extra.width) fd.set("width", String(extra.width));
    if (extra.height) fd.set("height", String(extra.height));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/chat/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let j: { ok?: boolean; id?: string; error?: string } = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {
        // 応答が JSON でない (サーバーの上限など)
      }
      if (xhr.status >= 200 && xhr.status < 300 && j.id) resolve({ id: j.id });
      else reject(new Error(j.error || (xhr.status === 413 ? "ファイルが大きすぎます (1 ファイル 9 MB まで)。" : `送れませんでした (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error("通信に失敗しました。電波の良いところでもう一度お試しください。"));
    xhr.send(fd);
  });
}

export function Composer({
  channel,
  parentId,
  dir,
  canImportant,
  maxFileBytes,
  onSent,
  placeholder,
  handleRef,
  compact = false,
  typing = [],
  onEditLast,
}: {
  channel: ChatChannelView;
  parentId?: string;
  dir: Dir;
  canImportant: boolean;
  maxFileBytes: number;
  onSent: (m: ChatMessageView, info?: { taskError?: string }) => void;
  placeholder: string;
  handleRef?: Ref<ComposerHandle>;
  compact?: boolean;
  /** このチャンネル・スレッドで入力中の人 */
  typing?: string[];
  /** 入力欄が空のときの ↑ (最後に送った自分のメッセージを編集) */
  onEditLast?: () => void;
}) {
  const key = draftKey(channel.id, parentId);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [important, setImportant] = useState(false);
  const [taskOn, setTaskOn] = useState(false);
  const [task, setTask] = useState<ChatTaskInput>(emptyTask);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [sug, setSug] = useState<{ start: number; query: string; index: number } | null>(null);
  const [fine, setFine] = useState(true);
  const [alsoChannel, setAlsoChannel] = useState(false);
  const [showFormat, setShowFormat] = useState(true);
  const [emoji, setEmoji] = useState<DOMRect | null>(null);
  const typedAt = useRef(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const camInput = useRef<HTMLInputElement>(null);
  const filesRef = useRef<Pending[]>([]);
  /** 文字を差し込んだあとのカーソルの位置 (画面に反映した直後に合わせる。続けて打った文字が前に入らないように) */
  const caretRef = useRef<number | [number, number] | null>(null);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useLayoutEffect(() => {
    const el = ta.current;
    const pos = caretRef.current;
    if (!el || pos === null) return;
    caretRef.current = null;
    el.focus();
    if (Array.isArray(pos)) el.setSelectionRange(pos[0], pos[1]);
    else el.setSelectionRange(pos, pos);
  }, [text]);

  // チャンネル・スレッドを変えたら下書きを読み直す
  useEffect(() => {
    setText(readDraft(key));
    setFiles([]);
    setImportant(false);
    setTaskOn(false);
    setTask(emptyTask());
    setErr("");
  }, [key]);
  useEffect(() => {
    const f = window.matchMedia?.("(pointer: fine)").matches ?? true;
    const t = window.setTimeout(() => {
      setFine(f);
      // スマートフォンは書式のボタンをしまっておく (「Aa」で出す)
      if (!f) setShowFormat(false);
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => writeDraft(key, text), 400);
    return () => window.clearTimeout(t);
  }, [key, text]);
  // 入力欄の高さを内容に合わせる
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, compact ? 160 : 220)}px`;
  }, [text, compact]);

  const addFiles = useCallback(
    (list: File[]) => {
      setErr("");
      const room = CHAT_MAX_FILES - filesRef.current.length;
      if (room <= 0) return setErr(`資料・写真は 1 回に ${CHAT_MAX_FILES} 件までです。`);
      for (const raw of list.slice(0, room)) {
        const k = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const photo = raw.type.startsWith("image/") && raw.type !== "image/svg+xml";
        const preview = photo ? URL.createObjectURL(raw) : undefined;
        setFiles((x) => [...x, { key: k, name: raw.name || "file", size: raw.size, preview, photo, progress: 0, access: "members" }]);
        void (async () => {
          try {
            const prepared = await prepareFile(raw);
            if (prepared.file.size > maxFileBytes) throw new Error(`「${raw.name}」は ${sizeLabel(prepared.file.size)} です。1 ファイル ${sizeLabel(maxFileBytes)} までです。`);
            const r = await upload(channel.id, prepared.file, { thumb: prepared.thumb, width: prepared.width, height: prepared.height }, (p) => setFiles((x) => x.map((f) => (f.key === k ? { ...f, progress: p } : f))));
            setFiles((x) => x.map((f) => (f.key === k ? { ...f, uploadId: r.id, progress: 100, size: prepared.file.size } : f)));
          } catch (e) {
            setFiles((x) => x.map((f) => (f.key === k ? { ...f, error: e instanceof Error ? e.message : "送れませんでした" } : f)));
          }
        })();
      }
      if (list.length > room) setErr(`資料・写真は 1 回に ${CHAT_MAX_FILES} 件までです (${list.length - room} 件は追加しませんでした)。`);
    },
    [channel.id, maxFileBytes],
  );

  useImperativeHandle(handleRef, () => ({ addFiles, focus: () => ta.current?.focus() }), [addFiles]);

  const removeFile = (k: string) =>
    setFiles((x) => {
      const f = x.find((y) => y.key === k);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return x.filter((y) => y.key !== k);
    });

  // メンションの候補
  const suggestions = useMemo<Suggest[]>(() => {
    if (!sug) return [];
    const q = sug.query;
    const members = new Set(channel.memberIds);
    const users = [...dir.users.values()]
      .filter((u) => u.id !== dir.me.id && (channel.kind !== "dm" || members.has(u.id)))
      .map((u) => ({ u, s: matchName(q, u.name, u.kana) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || Number(members.has(b.u.id)) - Number(members.has(a.u.id)) || a.u.kana.localeCompare(b.u.kana, "ja"))
      .slice(0, 7)
      .map<Suggest>(({ u }) => ({ kind: "user", id: u.id, label: u.name, sub: [dir.stores.find((s) => s.id === u.storeId)?.name, u.title].filter(Boolean).join(" · "), insert: mentionText(u.name) }));
    const stores =
      channel.kind === "dm"
        ? []
        : dir.stores.filter((s) => matchName(q, s.name) > 0).map<Suggest>((s) => ({ kind: "store", id: s.id, label: s.name, sub: "店舗の全員に知らせる", insert: `@${s.name} ` }));
    const all = canImportant && channel.kind !== "dm" && matchName(q, "全員") + matchName(q, "all") > 0 ? [{ kind: "all" as const, id: "all", label: "全員", sub: "このチャンネルの全員に知らせる (自分あての通知)", insert: "@全員 " }] : [];
    return [...all, ...users, ...stores].slice(0, 9);
  }, [sug, dir, channel, canImportant]);

  const refreshSug = (value: string, caret: number) => {
    const m = mentionQuery(value, caret);
    setSug(m ? { ...m, index: 0 } : null);
  };

  const pick = (s: Suggest) => {
    const el = ta.current;
    if (!el || !sug) return;
    const caret = el.selectionStart ?? text.length;
    const next = text.slice(0, sug.start) + s.insert + text.slice(caret);
    caretRef.current = sug.start + s.insert.length;
    setText(next);
    setSug(null);
  };

  const insertAt = () => {
    const el = ta.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const add = before && !/\s$/.test(before) ? " @" : "@";
    const next = before + add + text.slice(caret);
    const pos = caret + add.length;
    caretRef.current = pos;
    setText(next);
    refreshSug(next, pos);
  };

  /** 選んだ文字を書式の印で囲む (選んでいなければ印だけ入れて、間にカーソル) */
  const wrap = (left: string, right = left) => {
    const el = ta.current;
    if (!el) return;
    const a = el.selectionStart ?? text.length;
    const b = el.selectionEnd ?? a;
    const sel = text.slice(a, b);
    caretRef.current = sel ? [a + left.length, a + left.length + sel.length] : a + left.length;
    setText(text.slice(0, a) + left + sel + right + text.slice(b));
  };
  /** 選んだ行の頭に印を付ける (引用・箇条書き・番号) */
  const prefixLines = (make: (i: number) => string) => {
    const el = ta.current;
    if (!el) return;
    const a = el.selectionStart ?? text.length;
    const b = el.selectionEnd ?? a;
    const start = text.lastIndexOf("\n", a - 1) + 1;
    const endIdx = text.indexOf("\n", b);
    const end = endIdx < 0 ? text.length : endIdx;
    const lines = text.slice(start, end).split("\n").map((l, i) => make(i) + l);
    const joined = lines.join("\n");
    caretRef.current = start + joined.length;
    setText(text.slice(0, start) + joined + text.slice(end));
  };
  const insertLink = () => {
    const url = window.prompt("リンク先の URL (https://…)", "https://");
    if (!url || !/^https?:\/\/\S+$/.test(url.trim())) return;
    const el = ta.current;
    const a = el?.selectionStart ?? text.length;
    const b = el?.selectionEnd ?? a;
    const sel = text.slice(a, b);
    const ins = sel ? `${sel} ${url.trim()} ` : `${url.trim()} `;
    caretRef.current = a + ins.length;
    setText(text.slice(0, a) + ins + text.slice(b));
  };
  const insertText = (v: string) => {
    const el = ta.current;
    const a = el?.selectionStart ?? text.length;
    const b = el?.selectionEnd ?? a;
    caretRef.current = a + v.length;
    setText(text.slice(0, a) + v + text.slice(b));
  };
  const FORMATS: { label: string; icon: typeof Bold; run: () => void; key?: string }[] = [
    { label: "太字 (Ctrl + B)", icon: Bold, run: () => wrap("*"), key: "b" },
    { label: "斜体 (Ctrl + I)", icon: Italic, run: () => wrap("_"), key: "i" },
    { label: "取り消し線 (Ctrl + Shift + X)", icon: Strikethrough, run: () => wrap("~") },
    { label: "リンク", icon: Link2, run: insertLink },
    { label: "箇条書き", icon: List, run: () => prefixLines(() => "・ ") },
    { label: "番号つきの箇条書き", icon: ListOrdered, run: () => prefixLines((i) => `${i + 1}. `) },
    { label: "引用", icon: Quote, run: () => prefixLines(() => "> ") },
    { label: "コード", icon: Code, run: () => wrap("`") },
    { label: "コードのかたまり", icon: SquareCode, run: () => wrap("```\n", "\n```") },
  ];

  const uploading = files.some((f) => !f.uploadId && !f.error);
  const failed = files.some((f) => f.error);
  const canSend = !sending && !uploading && !failed && (text.trim().length > 0 || files.length > 0);

  const send = async () => {
    if (!canSend) {
      if (failed) setErr("送れなかった資料・写真があります。× で外してから送ってください。");
      return;
    }
    if (taskOn && !task.assigneeIds.length) return setErr("業務依頼の依頼先を選んでください。");
    setSending(true);
    setErr("");
    try {
      const fileAccess = Object.fromEntries(files.filter((f) => f.uploadId && f.access === "managers").map((f) => [f.uploadId!, "managers" as const]));
      const r = await sendChatMessage({ channelId: channel.id, parentId, alsoChannel: Boolean(parentId && alsoChannel), body: text, important: important && !parentId, uploadIds: files.map((f) => f.uploadId!).filter(Boolean), fileAccess, task: taskOn && !parentId ? task : undefined });
      if (!r.ok || !r.data) {
        setErr(r.error ?? "送れませんでした。");
        return;
      }
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
      setText("");
      writeDraft(key, "");
      setFiles([]);
      setImportant(false);
      setTaskOn(false);
      setTask(emptyTask());
      setAlsoChannel(false);
      onSent(r.data.message, { taskError: r.data.taskError });
      requestAnimationFrame(() => ta.current?.focus());
    } catch {
      setErr("通信に失敗しました。入力した内容は残っています。もう一度送ってください。");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (sug && suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setSug({ ...sug, index: (sug.index + d + suggestions.length) % suggestions.length });
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
        e.preventDefault();
        pick(suggestions[sug.index] ?? suggestions[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSug(null);
        return;
      }
    }
    // 書式のショートカット (Slack と同じ)
    if ((e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      const k = e.key.toLowerCase();
      if (k === "b" || k === "i") {
        e.preventDefault();
        wrap(k === "b" ? "*" : "_");
        return;
      }
      if (k === "x" && e.shiftKey) {
        e.preventDefault();
        wrap("~");
        return;
      }
    }
    // 空の入力欄で ↑ = 最後に送った自分のメッセージを編集
    if (e.key === "ArrowUp" && !text && onEditLast && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onEditLast();
      return;
    }
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // パソコン: Enter で送信・Shift + Enter で改行。スマートフォン: Enter は改行 (送信はボタン)。Ctrl / ⌘ + Enter はいつも送信
    if (e.ctrlKey || e.metaKey || (fine && !e.shiftKey)) {
      e.preventDefault();
      void send();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const list = [...e.clipboardData.files];
    if (list.length) {
      e.preventDefault();
      addFiles(list);
    }
  };

  const top = !parentId;
  return (
    <div className={clsx("relative border-t border-line bg-panel", compact ? "px-3 pt-2 pb-2.5" : "px-3 pt-2.5 pb-3 @xl:px-4")}>
      {err && <ErrorLine text={err} />}
      {taskOn && top && (
        <div className="mb-2 rounded-xl border border-warn/40 bg-warn-soft/40 p-3 @container">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-warn-ink">
            <ListTodo className="h-4 w-4" />
            業務依頼として送る
            <button type="button" onClick={() => setTaskOn(false)} className="ml-auto rounded p-0.5 text-ink-3 hover:bg-subtle" aria-label="業務依頼にしない">
              <X className="h-4 w-4" />
            </button>
          </div>
          <TaskFields dir={dir} value={task} onChange={setTask} prefer={channel.memberIds} />
        </div>
      )}
      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <li key={f.key} className={clsx("relative flex w-44 items-center gap-2 rounded-xl border bg-panel p-1.5 pr-6 shadow-xs", f.error ? "border-critical/50" : "border-line")}>
              {f.preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- 送る前の写真 (端末の中)
                <img src={f.preview} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
                  <FileText className="h-5 w-5" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-ink">{f.name}</span>
                {f.error ? (
                  <span className="line-clamp-2 block text-[10px] text-critical-ink">{f.error}</span>
                ) : f.uploadId ? (
                  canImportant ? (
                    <button type="button" onClick={() => setFiles((x) => x.map((y) => (y.key === f.key ? { ...y, access: y.access === "members" ? "managers" : "members" } : y)))} className={clsx("inline-flex items-center gap-0.5 text-[10px]", f.access === "managers" ? "font-semibold text-warn-ink" : "text-ink-3 hover:text-ink")} title="押すと公開範囲を切り替えます">
                      <Lock className="h-3 w-3" />
                      {f.access === "managers" ? "店長以上だけ" : "全員 (メンバー)"}
                    </button>
                  ) : (
                    <span className="block text-[10px] text-ink-3">{sizeLabel(f.size)}</span>
                  )
                ) : (
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-line">
                    <span className="block h-full bg-accent transition-[width]" style={{ width: `${Math.max(f.progress, 5)}%` }} />
                  </span>
                )}
              </span>
              <button type="button" onClick={() => removeFile(f.key)} className="absolute top-1 right-1 rounded-full p-0.5 text-ink-3 hover:bg-subtle hover:text-ink" aria-label={`${f.name} を外す`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {parentId && channel.kind !== "dm" && (
        <label className="mb-1.5 flex items-center gap-1.5 text-[12px] text-ink-2">
          <input type="checkbox" checked={alsoChannel} onChange={(e) => setAlsoChannel(e.target.checked)} className="h-3.5 w-3.5 accent-accent" data-testid="chat-also-channel" />
          {channelLabel(channel)} にも送信する
        </label>
      )}
      <div className={clsx("rounded-2xl border bg-panel transition focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15", important ? "border-warn" : "border-line-strong")}>
        {showFormat && (
          <div className="flex items-center gap-0.5 overflow-x-auto rounded-t-2xl border-b border-line bg-subtle/50 px-1.5 py-1" role="toolbar" aria-label="書式">
            {FORMATS.map((f, i) => (
              <span key={f.label} className="contents">
                {(i === 3 || i === 4 || i === 7) && <span className="mx-0.5 h-4 w-px shrink-0 bg-line-strong" aria-hidden />}
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={f.run} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-panel hover:text-ink" aria-label={f.label} title={f.label}>
                  <f.icon className="h-4 w-4" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            refreshSug(e.target.value, e.target.selectionStart ?? e.target.value.length);
            // 入力中を知らせる (3 秒に 1 回まで)
            if (e.target.value.trim() && Date.now() - typedAt.current > 3000) {
              typedAt.current = Date.now();
              void chatTyping(channel.id, parentId).catch(() => undefined);
            }
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onClick={(e) => refreshSug(text, e.currentTarget.selectionStart ?? text.length)}
          onBlur={() => window.setTimeout(() => setSug(null), 150)}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          maxLength={8000}
          data-testid={parentId ? "chat-reply-input" : "chat-input"}
          className="block max-h-[220px] min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-relaxed outline-none placeholder:text-ink-3"
        />
        <div className="flex items-center gap-0.5 overflow-x-auto px-1.5 pb-1.5">
          <button type="button" onClick={() => fileInput.current?.click()} className="rounded-lg p-2 text-ink-2 hover:bg-subtle hover:text-ink" aria-label="資料・写真を添付" title="資料・写真を添付 (貼り付け・ドラッグでも追加できます)">
            <Paperclip className="h-[18px] w-[18px]" />
          </button>
          {!fine && (
            <button type="button" onClick={() => camInput.current?.click()} className="rounded-lg p-2 text-ink-2 hover:bg-subtle hover:text-ink" aria-label="撮影して送る">
              <Camera className="h-[18px] w-[18px]" />
            </button>
          )}
          <button type="button" onClick={() => setShowFormat((x) => !x)} aria-pressed={showFormat} className={clsx("rounded-lg p-2 hover:bg-subtle hover:text-ink", showFormat ? "text-accent" : "text-ink-2")} aria-label="書式のボタンを出す・しまう" title="書式 (太字・斜体・箇条書き・コード など)">
            <Type className="h-[18px] w-[18px]" />
          </button>
          <button type="button" onClick={(e) => setEmoji(e.currentTarget.getBoundingClientRect())} className="rounded-lg p-2 text-ink-2 hover:bg-subtle hover:text-ink" aria-label="絵文字" title="絵文字">
            <Smile className="h-[18px] w-[18px]" />
          </button>
          <button type="button" onClick={insertAt} className="rounded-lg p-2 text-ink-2 hover:bg-subtle hover:text-ink" aria-label="メンション (@)" title="メンション (@名前・@店舗)">
            <AtSign className="h-[18px] w-[18px]" />
          </button>
          {top && canImportant && channel.kind !== "dm" && (
            <button type="button" onClick={() => setImportant((x) => !x)} aria-pressed={important} className={clsx("inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium", important ? "bg-warn text-white" : "text-ink-2 hover:bg-subtle hover:text-ink")} title="重要メッセージ: 受け取った人が「確認しました」を押すまで要対応に残り、誰が確認したかが分かります" data-testid="chat-important-toggle">
              <AlertTriangle className="h-4 w-4" />
              <span className="max-[420px]:hidden">重要</span>
            </button>
          )}
          {top && (
            <button type="button" onClick={() => setTaskOn((x) => !x)} aria-pressed={taskOn} className={clsx("inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium", taskOn ? "bg-warn-soft text-warn-ink" : "text-ink-2 hover:bg-subtle hover:text-ink")} title="業務依頼として送る (依頼先・期限つき。完了まで残ります)" data-testid="chat-task-toggle">
              <ListTodo className="h-4 w-4" />
              <span className="max-[420px]:hidden">業務依頼</span>
            </button>
          )}
          <span className="flex-1" />
          <span className="mr-1 hidden text-[10px] text-ink-3 @3xl:inline">{fine ? "Enter で送信・Shift + Enter で改行" : ""}</span>
          <button type="button" onClick={() => void send()} disabled={!canSend} className={clsx("inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-sm font-medium transition", canSend ? (important ? "bg-warn text-white hover:brightness-95" : "bg-accent text-white hover:bg-accent-hover") : "bg-subtle text-ink-3")} aria-label="送信" data-testid={parentId ? "chat-reply-send" : "chat-send"}>
            {sending || uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
            <span className="max-[380px]:hidden">{uploading ? "準備中" : "送信"}</span>
          </button>
        </div>
      </div>
      <p className={clsx("mt-1 h-4 truncate text-[11px] text-ink-3", !typing.length && "invisible")} aria-live="polite" data-testid="chat-typing">
        {typing.length ? `${typing.slice(0, 3).map((id) => nameOf(dir, id)).join("、")}${typing.length > 3 ? ` ほか ${typing.length - 3} 人` : ""} さんが入力中…` : "\u00a0"}
      </p>
      {emoji && <EmojiPicker anchor={emoji} onPick={(e) => insertText(e)} onClose={() => setEmoji(null)} />}
      {important && <p className="mt-1.5 text-[11px] text-warn-ink">重要メッセージとして送ります。チャンネルのメンバーが「確認しました」を押すまで要対応に残り、確認の状態が分かります。</p>}
      {sug && suggestions.length > 0 && (
        <ul className="absolute bottom-full left-3 z-20 mb-1 w-72 overflow-hidden rounded-xl border border-line bg-panel p-1 shadow-pop" role="listbox" aria-label="メンションの候補">
          {suggestions.map((s, i) => (
            <li key={`${s.kind}:${s.id}`} role="option" aria-selected={i === sug.index}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)} className={clsx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left", i === sug.index ? "bg-accent-soft" : "hover:bg-subtle")}>
                {s.kind === "user" ? <UserAvatar dir={dir} id={s.id} size={24} /> : <span className="flex h-6 w-6 items-center justify-center rounded-full bg-warn-soft text-[11px] font-bold text-warn-ink">@</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{s.label}</span>
                  <span className="block truncate text-[10px] text-ink-3">{s.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
      <input ref={camInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
    </div>
  );
}
