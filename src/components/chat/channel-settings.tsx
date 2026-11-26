"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Archive, ArchiveRestore, Hash, ImagePlus, Lock, MessageSquare, Search, Settings2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui";
import { archiveChatChannel, createChatChannel, deleteChatChannel, updateChatChannel } from "@/lib/actions/chat";
import { matchName } from "@/lib/chat/text";
import { channelLabel, type ChatChannelView } from "@/lib/chat/types";
import { fullWhen, shortWhen } from "./client";
import { ErrorLine, PeoplePicker } from "./dialogs";
import { ChannelIcon, Modal, nameOf, type Dir } from "./parts";

/**
 * チャンネルの設定 (お客様のご要望 2026-11-26)
 * - チャンネルを作成・変更するときに画像を登録 (店舗のチャンネル = その店舗の画像 / 店長のチャンネル = 本部の画像)
 * - 管理者: すべてのチャンネル (非公開・アーカイブを含む) の追加・変更・削除 (チャンネルの管理)。メンバーでないチャンネルのメッセージは見えない
 */

const SYSTEM = new Set(["all", "store", "managers"]);
const IMAGE_SIDE = 512;

/* ================================================================== */
/* 画像                                                                 */
/* ================================================================== */

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => (URL.revokeObjectURL(url), resolve(img));
    img.onerror = () => (URL.revokeObjectURL(url), reject(new Error("この画像は読み込めませんでした。別の画像 (JPEG・PNG) を選んでください。")));
    img.src = url;
  });
}

/** 正方形に切り抜いて 512 px の JPEG にする (送る前に小さくする。透明な部分は白) */
export async function prepChannelImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") && !/\.(jpe?g|png|gif|webp|heic|heif)$/i.test(file.name)) throw new Error("画像 (写真・PNG など) を選んでください。");
  const img = await loadImage(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error("この画像は読み込めませんでした。");
  const side = Math.min(w, h);
  const out = Math.min(IMAGE_SIDE, side);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした。");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out, out);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("画像を処理できませんでした。");
  return blob;
}

/** 画像を登録する (エラーの文、成功なら空) */
export async function uploadChannelImage(channelId: string, blob: Blob): Promise<string> {
  const fd = new FormData();
  fd.set("channelId", channelId);
  fd.set("file", blob, "channel.jpg");
  try {
    const r = await fetch("/api/chat/channel-image", { method: "POST", body: fd });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return r.ok && j.ok ? "" : (j.error ?? "画像を保存できませんでした。");
  } catch {
    return "通信に失敗しました。";
  }
}

export async function removeChannelImage(channelId: string): Promise<string> {
  try {
    const r = await fetch(`/api/chat/channel-image?c=${encodeURIComponent(channelId)}`, { method: "DELETE" });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return r.ok && j.ok ? "" : (j.error ?? "画像を外せませんでした。");
  } catch {
    return "通信に失敗しました。";
  }
}

export interface ImageChoice {
  blob?: Blob;
  preview?: string;
  removed?: boolean;
}

/** 画像の欄 (選ぶ・外す。いまの画像の上に選んだ画像を重ねて見せる) */
export function ChannelImageField({ dir, channel, kind, value, onChange, label, note }: { dir: Dir; channel?: Pick<ChatChannelView, "kind" | "memberIds" | "visibility" | "color" | "image" | "imageInherited">; kind: ChatChannelView["kind"]; value: ImageChoice; onChange: (v: ImageChoice) => void; label: string; note?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => () => void (value.preview && URL.revokeObjectURL(value.preview)), [value.preview]);
  const shown = value.preview ?? (value.removed ? undefined : channel?.image);
  const inherited = !value.preview && !value.removed && channel?.imageInherited;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setErr("");
    setBusy(true);
    try {
      const blob = await prepChannelImage(file);
      onChange({ blob, preview: URL.createObjectURL(blob) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "画像を読み込めませんでした。");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      <div className="flex items-center gap-3">
        <ChannelIcon c={{ kind, memberIds: channel?.memberIds ?? [], visibility: channel?.visibility, color: channel?.color, image: shown }} dir={dir} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => input.current?.click()} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs text-ink hover:bg-subtle disabled:opacity-60" data-testid="chat-channel-image-pick">
              <ImagePlus className="h-3.5 w-3.5" />
              {busy ? "読み込んでいます…" : shown && !inherited ? "画像を変える" : "画像を選ぶ"}
            </button>
            {(value.preview || (channel?.image && !channel.imageInherited && !value.removed)) && (
              <button type="button" onClick={() => onChange(value.preview ? {} : { removed: true })} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs text-ink-2 hover:bg-subtle">
                <X className="h-3.5 w-3.5" />
                {value.preview ? "選んだ画像をやめる" : "画像を外す"}
              </button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-ink-3">{inherited ? "いまは本部のチャンネルの画像を使っています。" : (note ?? "正方形に切り抜いて小さくしてから登録します (写真・ロゴなど)。")}</p>
          {err && <p className="mt-1 text-[11px] text-critical-ink">{err}</p>}
        </div>
      </div>
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} data-testid="chat-channel-image-input" />
    </div>
  );
}

const imageLabel = (kind: ChatChannelView["kind"]) => (kind === "store" ? "店舗の画像" : kind === "managers" ? "店長のチャンネルの画像 (本部の画像)" : kind === "all" ? "全社のチャンネルの画像" : "チャンネルの画像 (任意)");
const imageNote = (kind: ChatChannelView["kind"]) =>
  kind === "store" ? "店舗の外観・ロゴなど。正方形に切り抜いて小さくしてから登録します。" : kind === "managers" ? "本部の外観・ロゴなど。登録しないときは本部のチャンネルの画像を使います。" : undefined;

/* ================================================================== */
/* 削除の確認                                                           */
/* ================================================================== */

export function DeleteChannelConfirm({ channel, messages, busy, onCancel, onDelete }: { channel: Pick<ChatChannelView, "name" | "kind" | "visibility">; messages?: number; busy: boolean; onCancel: () => void; onDelete: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <div className="rounded-xl border border-critical/40 bg-critical-soft/50 p-3" data-testid="chat-delete-confirm">
      <p className="text-sm font-semibold text-critical-ink">{channelLabel(channel)} を削除しますか？</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
        {messages !== undefined ? `メッセージ ${messages} 件` : "メッセージ"}・資料・写真もすべて消え、<strong>元に戻せません</strong>。残しておきたいときは「アーカイブ」にしてください (送れなくなり、一覧から外れます)。
      </p>
      <label className="mt-2 block">
        <span className="mb-1 block text-[11px] text-ink-2">確認のため、チャンネルの名前「{channel.name}」を入力してください</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} className="h-9 w-full rounded-xl border border-line bg-panel px-3 text-sm outline-none focus:border-critical focus:ring-4 focus:ring-critical/15" data-testid="chat-delete-name" />
      </label>
      <div className="mt-2 flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          やめる
        </Button>
        <Button type="button" variant="danger" size="sm" onClick={onDelete} disabled={busy || typed.trim().replace(/^#/, "") !== channel.name} data-testid="chat-delete-run">
          <Trash2 className="h-3.5 w-3.5" />
          完全に削除する
        </Button>
      </div>
    </div>
  );
}

/* ================================================================== */
/* チャンネルの作成・設定                                                 */
/* ================================================================== */

export interface ChannelSavedInfo {
  archived?: boolean;
  /** 保存はできたが、画像を保存できなかったときなど */
  note?: string;
}

/**
 * チャンネルを作成・設定する
 * - 作成 / 追加したチャンネル: 名前・説明・画像・公開範囲・メンバー (作成した人・管理者)。アーカイブ (作成した人・管理者)・削除 (管理者)
 * - 全社・店舗・店長のチャンネル: 名前は店舗の名前のまま。説明・メンバー (店舗・店長) は管理者、画像は管理者と店舗の店長 (店長のチャンネルは本部の店長)
 */
export function ChannelDialog({ dir, channel, messages, onClose, onSaved, onDeleted }: { dir: Dir; channel?: ChatChannelView; messages?: number; onClose: () => void; onSaved: (channelId: string, info?: ChannelSavedInfo) => void; onDeleted?: (channelId: string) => void }) {
  const system = Boolean(channel && SYSTEM.has(channel.kind));
  const kind = channel?.kind ?? "custom";
  const canSettings = !channel || channel.canManage;
  const canImage = !channel || channel.canEditImage;
  const amMember = Boolean(channel?.memberIds.includes(dir.me.id));
  /** 追加したチャンネルで自分がメンバー (作成を含む) なら自分は一覧に出さない (いつもメンバーに残る) */
  const hideMe = !channel || (!system && amMember);
  const [name, setName] = useState(channel?.name ?? "");
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [visibility, setVisibility] = useState<"public" | "private">(channel?.visibility ?? "public");
  const [ids, setIds] = useState<string[]>(channel ? channel.memberIds.filter((x) => !hideMe || x !== dir.me.id) : []);
  const [image, setImage] = useState<ImageChoice>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editing = Boolean(channel);

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      let id = channel?.id ?? "";
      if (!channel) {
        const r = await createChatChannel({ name, topic, memberIds: ids, visibility });
        if (!r.ok || !r.data) return setErr(r.error ?? "作成できませんでした。");
        id = r.data.channelId;
      } else if (canSettings) {
        const r = await updateChatChannel(channel.id, { name, topic, memberIds: ids, visibility });
        if (!r.ok) return setErr(r.error ?? "保存できませんでした。");
      }
      let note: string | undefined;
      if (canImage && image.blob) {
        const e = await uploadChannelImage(id, image.blob);
        if (e) note = `${editing ? "設定" : "チャンネル"}は保存しましたが、画像を登録できませんでした (${e})。`;
      } else if (canImage && image.removed) {
        const e = await removeChannelImage(id);
        if (e) note = `設定は保存しましたが、画像を外せませんでした (${e})。`;
      }
      onSaved(id, { note });
    } catch {
      setErr("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!channel || !confirm(`#${channel.name} をアーカイブしますか？\nメッセージは残りますが、一覧に出なくなり、送れなくなります (管理者が「チャンネルの管理」から元に戻せます)。`)) return;
    setBusy(true);
    try {
      const r = await archiveChatChannel(channel.id, true);
      if (!r.ok) setErr(r.error ?? "アーカイブできませんでした。");
      else onSaved(channel.id, { archived: true });
    } catch {
      setErr("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!channel) return;
    setBusy(true);
    try {
      const r = await deleteChatChannel(channel.id);
      if (!r.ok) setErr(r.error ?? "削除できませんでした。");
      else onDeleted?.(channel.id);
    } catch {
      setErr("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  const addStore = (storeId: string) => setIds((x) => [...new Set([...x, ...[...dir.users.values()].filter((u) => u.storeId === storeId && (!hideMe || u.id !== dir.me.id)).map((u) => u.id)])]);
  const needMembers = !system && visibility === "private" && !ids.length && !(channel && !hideMe && amMember);
  const systemNote: Record<string, string> = {
    all: "全社員が自動で参加しています (メンバーは変えられません)。",
    store: "この店舗に所属する社員とその店舗の店長が自動で参加しています。管理者はメンバーを足す・外すことができます (外した人は、管理者が戻すまで参加しません)。",
    managers: "各店舗の店長が自動で参加しています。管理者はメンバーを足す・外すことができます。メンバー以外には見えません。",
  };
  return (
    <Modal
      title={editing ? `#${channel!.name} の設定` : "チャンネルを作成"}
      wide
      onClose={onClose}
      footer={
        <>
          {editing && channel!.kind === "custom" && channel!.canManage && !channel!.archived && (
            <Button type="button" variant="secondary" onClick={() => void archive()} disabled={busy}>
              <Archive className="h-4 w-4" />
              アーカイブ
            </Button>
          )}
          {editing && channel!.canDelete && (
            <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy} data-testid="chat-channel-delete">
              <Trash2 className="h-4 w-4" />
              削除
            </Button>
          )}
          <span className="flex-1" />
          <Button type="button" variant="secondary" onClick={onClose}>
            やめる
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy || (!system && !name.trim()) || needMembers} data-testid="chat-channel-save">
            {busy ? "保存しています…" : editing ? "保存する" : "作成する"}
          </Button>
        </>
      }
    >
      {err && <ErrorLine text={err} />}
      <div className="space-y-3">
        {confirmDelete && channel && <DeleteChannelConfirm channel={channel} messages={messages} busy={busy} onCancel={() => setConfirmDelete(false)} onDelete={() => void remove()} />}
        {system ? (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-subtle/60 px-3 py-2 text-sm">
            <span className="font-semibold text-ink">{channelLabel(channel!)}</span>
            <span className="text-[11px] text-ink-3">{kind === "store" ? "名前は店舗の名前です (設定 → 店舗 で変えられます)" : "名前は変えられません"}</span>
          </div>
        ) : (
          canSettings && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-2">
                名前 <span className="text-critical">*</span>
              </span>
              <span className="relative block">
                <Hash className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-ink-3" />
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="例: 新商品の勉強会" className="h-9 w-full rounded-xl border border-line bg-panel pr-3 pl-8 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15" data-testid="chat-channel-name" />
              </span>
            </label>
          )
        )}
        {canSettings && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-2">説明 (任意)</span>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} placeholder={system ? "空にすると既定の説明に戻ります" : "何のためのチャンネルか"} className="h-9 w-full rounded-xl border border-line bg-panel px-3 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15" />
          </label>
        )}
        {canImage && <ChannelImageField dir={dir} channel={channel} kind={kind} value={image} onChange={setImage} label={imageLabel(kind)} note={imageNote(kind)} />}
        {!system && canSettings && (
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-ink-2">公開範囲</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  ["public", "公開", "社員なら誰でも「チャンネルを探す」から見つけて参加できます", Hash],
                  ["private", "非公開", "メンバーだけが見られます (招待した人だけ)", Lock],
                ] as const
              ).map(([v, label, desc, Icon]) => (
                <label key={v} className={clsx("flex cursor-pointer items-start gap-2.5 rounded-xl border p-3", visibility === v ? "border-accent bg-accent-soft/50" : "border-line hover:bg-subtle")}>
                  <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} className="mt-1 accent-accent" data-testid={`chat-visibility-${v}`} />
                  <span>
                    <span className="flex items-center gap-1 text-sm font-semibold text-ink">
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </span>
                    <span className="block text-[11px] text-ink-3">{desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {canSettings && kind !== "all" && (
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink-2">
              メンバー {system ? <span className="font-normal text-ink-3">({ids.length} 人)</span> : visibility === "private" ? <span className="text-critical">*</span> : <span className="font-normal text-ink-3">(任意。公開のチャンネルはあとから参加できます)</span>}
              <span className="font-normal text-ink-3">店舗の全員を追加:</span>
              {dir.stores.map((s) => (
                <button key={s.id} type="button" onClick={() => addStore(s.id)} className="rounded-full border border-line px-2 py-0.5 text-[11px] font-normal hover:bg-subtle">
                  + {s.name}
                </button>
              ))}
            </div>
            <PeoplePicker dir={dir} value={ids} onChange={setIds} exclude={hideMe ? [dir.me.id] : []} />
            <p className="mt-1.5 text-[11px] text-ink-3">{system ? systemNote[kind] : !channel ? "あなたも自動でメンバーになります。メンバーはあとから「メンバー」の画面で追加できます。" : amMember ? "あなたはメンバーのままです (抜けるときは「チャンネルから抜ける」)。" : "あなたはこのチャンネルのメンバーではありません (管理者として変更しています)。"}</p>
          </div>
        )}
        {system && kind === "all" && canSettings && <p className="text-[11px] text-ink-3">{systemNote.all}</p>}
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* チャンネルの管理 (管理者)                                              */
/* ================================================================== */

export type ManageRow = ChatChannelView & { messages: number; files: number };

type ManageFilter = "all" | "system" | "public" | "private" | "archived";

/**
 * 管理者のチャンネルの管理: すべてのチャンネル (全社・店舗・店長・追加したチャンネル。非公開・アーカイブを含む。DM は含めない)。
 * 設定 (名前・説明・画像・公開範囲・メンバー)・アーカイブ / 元に戻す・削除。メンバーでないチャンネルのメッセージは開けない
 */
export function ManageDialog({ dir, onClose, onOpen, onEdit, onCreate, onChanged }: { dir: Dir; onClose: () => void; onOpen: (id: string) => void; onEdit: (row: ManageRow) => void; onCreate: () => void; onChanged: (text: string, deletedId?: string) => void }) {
  const [rows, setRows] = useState<ManageRow[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<ManageFilter>("all");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    fetch("/api/chat/manage", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { channels?: ManageRow[]; error?: string }) => live && (j.channels ? setRows(j.channels) : setErr(j.error ?? "読み込めませんでした。")))
      .catch(() => live && setErr("読み込めませんでした。"));
    return () => {
      live = false;
    };
  }, [reload]);
  const counts = useMemo(() => {
    const r = rows ?? [];
    return { all: r.length, system: r.filter((c) => SYSTEM.has(c.kind)).length, public: r.filter((c) => c.kind === "custom" && c.visibility === "public" && !c.archived).length, private: r.filter((c) => c.kind === "custom" && c.visibility !== "public" && !c.archived).length, archived: r.filter((c) => c.archived).length };
  }, [rows]);
  const shown = (rows ?? [])
    .filter((c) => (filter === "system" ? SYSTEM.has(c.kind) : filter === "public" ? c.kind === "custom" && c.visibility === "public" && !c.archived : filter === "private" ? c.kind === "custom" && c.visibility !== "public" && !c.archived : filter === "archived" ? c.archived : true))
    .filter((c) => !q.trim() || matchName(q, c.name) > 0 || (c.topic ?? "").includes(q.trim()) || nameOf(dir, c.createdBy).includes(q.trim()));
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, text: string, deletedId?: string) => {
    setBusy(true);
    setErr("");
    try {
      const r = await fn();
      if (!r.ok) return setErr(r.error ?? "変更できませんでした。");
      setDeleting(null);
      onChanged(text, deletedId);
      setReload((n) => n + 1);
    } catch {
      setErr("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  const FILTERS: [ManageFilter, string][] = [
    ["all", "すべて"],
    ["system", "全社・店舗・店長"],
    ["public", "公開"],
    ["private", "非公開"],
    ["archived", "アーカイブ"],
  ];
  return (
    <Modal
      title="チャンネルの管理 (管理者)"
      wide
      onClose={onClose}
      footer={
        <>
          <p className="mr-auto text-[11px] text-ink-3">メンバーでないチャンネルのメッセージは、管理者も開けません。DM は含みません。</p>
          <Button type="button" onClick={onCreate}>
            チャンネルを作成
          </Button>
        </>
      }
    >
      <div className="mb-2 flex flex-wrap gap-1.5" role="tablist">
        {FILTERS.map(([f, label]) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={clsx("rounded-full border px-2.5 py-1 text-xs", filter === f ? "border-accent bg-accent text-white" : "border-line text-ink-2 hover:bg-subtle")}>
            {label} {rows ? counts[f] : ""}
          </button>
        ))}
      </div>
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-ink-3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="チャンネルの名前・説明・作成した人で探す" className="h-9 w-full rounded-xl border border-line bg-panel pr-3 pl-8 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15" />
      </label>
      {err && <ErrorLine text={err} />}
      {!rows && !err && <p className="py-6 text-center text-sm text-ink-3">読み込んでいます…</p>}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" data-testid="chat-manage-list">
        {rows && shown.length === 0 && <li className="px-3 py-6 text-center text-xs text-ink-3">見つかりません</li>}
        {shown.map((c) => {
          const system = SYSTEM.has(c.kind);
          const canOpen = !c.archived && (c.joined || (c.kind === "custom" && c.visibility === "public"));
          return (
            <li key={c.id} className="px-3 py-2.5" data-testid={`chat-manage-${c.id}`}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <ChannelIcon c={c} dir={dir} size={36} />
                  <div className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
                      <span className="truncate">{c.name}</span>
                      {system ? (
                        <span className="rounded-full bg-neutral-soft px-1.5 py-px text-[10px] font-medium text-ink-2">自動</span>
                      ) : c.visibility === "public" ? (
                        <span className="rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent-ink">公開</span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-warn-soft px-1.5 py-px text-[10px] font-medium text-warn-ink">
                          <Lock className="h-2.5 w-2.5" />
                          非公開
                        </span>
                      )}
                      {c.archived && <span className="rounded-full bg-line px-1.5 py-px text-[10px] font-medium text-ink-2">アーカイブ</span>}
                      {c.joined && <span className="rounded-full bg-good-soft px-1.5 py-px text-[10px] font-medium text-good-ink">参加中</span>}
                    </span>
                    <span className="block truncate text-[11px] text-ink-3">
                      メンバー {c.memberIds.length} 人 · メッセージ {c.messages} 件{c.lastAt ? ` · 最後 ${shortWhen(c.lastAt)}` : ""}
                      {c.kind === "custom" ? ` · 作成 ${nameOf(dir, c.createdBy)}${c.createdAt ? ` (${fullWhen(c.createdAt).slice(0, 10)})` : ""}` : ""}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 sm:justify-end">
                  {canOpen && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => onOpen(c.id)}>
                      <MessageSquare className="h-3.5 w-3.5" />
                      開く
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="secondary" onClick={() => onEdit(c)} disabled={busy} data-testid="chat-manage-edit">
                    <Settings2 className="h-3.5 w-3.5" />
                    設定
                  </Button>
                  {c.kind === "custom" &&
                    (c.archived ? (
                      <Button type="button" size="sm" variant="secondary" onClick={() => void act(() => archiveChatChannel(c.id, false), `#${c.name} を元に戻しました。`)} disabled={busy}>
                        <ArchiveRestore className="h-3.5 w-3.5" />
                        元に戻す
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="secondary" onClick={() => confirm(`#${c.name} をアーカイブしますか？\nメッセージは残りますが、一覧に出なくなり、送れなくなります。`) && void act(() => archiveChatChannel(c.id, true), `#${c.name} をアーカイブしました。`)} disabled={busy}>
                        <Archive className="h-3.5 w-3.5" />
                        アーカイブ
                      </Button>
                    ))}
                  {c.canDelete && (
                    <Button type="button" size="sm" variant="danger" onClick={() => setDeleting(deleting === c.id ? null : c.id)} disabled={busy} data-testid="chat-manage-delete">
                      <Trash2 className="h-3.5 w-3.5" />
                      削除
                    </Button>
                  )}
                </div>
              </div>
              {deleting === c.id && (
                <div className="mt-2">
                  <DeleteChannelConfirm channel={c} messages={c.messages} busy={busy} onCancel={() => setDeleting(null)} onDelete={() => void act(() => deleteChatChannel(c.id), `#${c.name} を削除しました。`, c.id)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
