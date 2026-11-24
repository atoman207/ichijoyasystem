"use client";

import { useRef, useState, useSyncExternalStore, useTransition, type FormEvent } from "react";
import { Camera, FileAudio, Mic, PenLine, Square } from "lucide-react";
import type { Channel, StoreId } from "@/lib/db/types";
import { CHANNEL_LABEL } from "@/lib/constants";
import { CaptureUploader } from "@/components/features/CaptureUploader";
import { browserCanListen, canRecord, useRecorder, type VoiceMode } from "@/components/chatbot/voice";

type Tab = "photo" | "text" | "audio";

const TABS: { key: Tab; label: string; icon: typeof Camera; note: string }[] = [
  { key: "photo", label: "メモを撮影", icon: Camera, note: "来店・イベント・現場で書いた手書きのメモを撮影します。AI がお名前・住所・電話番号・用件を読み取ります。" },
  { key: "text", label: "話す・入力する", icon: PenLine, note: "携帯にかかってきた電話や、聞いた内容を話して (または打って) 入力します。電話を切ったあと、思い出せるうちにどうぞ。" },
  { key: "audio", label: "通話の録音", icon: FileAudio, note: "電話の録音装置・スマートフォンの通話録音のファイル (MP3・WAV・M4A など、約 10 分まで) を文字にして読み取ります。" },
];

const noSubscribe = () => () => {};

const PLACEHOLDER = `例) 合志の山田様から携帯に電話。090-1234-5678。和室6畳の畳の表替えをしたい。来週の土曜の午前に見積に来てほしい。チラシを見たとのこと。`;

export function ReceptionInput({
  action,
  stores,
  defaultStoreId,
  canChooseStore,
  aiEnabled,
  voice,
  customer,
}: {
  action: (formData: FormData) => Promise<void>;
  stores: { id: StoreId; name: string }[];
  defaultStoreId: StoreId;
  canChooseStore: boolean;
  aiEnabled: boolean;
  /** サーバーの音声入力 (OpenAI) が使えるか */
  voice: boolean;
  /** 顧客の画面から開いたときのお客様 (お客様が決まっている。お客様のご要望 2026-11-24「■6」) */
  customer?: { id: string; name: string };
}) {
  const [tab, setTab] = useState<Tab>("photo");
  const [channel, setChannel] = useState<Channel>("visit");
  const [storeId, setStoreId] = useState<StoreId>(defaultStoreId);
  const choose = (t: Tab) => {
    setTab(t);
    // 入口の初期値: 写真 = 来店・対面、話す = 担当者の携帯、録音 = 会社の電話
    setChannel(t === "photo" ? "visit" : t === "text" ? "mobile" : "phone");
  };
  return (
    <div className="space-y-4">
      <div role="tablist" className="grid grid-cols-3 gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = tab === t.key;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => choose(t.key)} className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-xs font-medium transition ${on ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-panel text-ink-2 hover:border-accent/50"}`}>
              <Icon className="h-6 w-6" />
              {t.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-ink-3">{TABS.find((t) => t.key === tab)?.note}</p>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <label className="block">
          <span className="label">入口 (どこで受けたか)</span>
          <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className="field">
            {(["visit", "event", "referral", "mobile", "phone", "mail", "unknown"] as Channel[]).map((c) => (
              <option key={c} value={c}>{c === "phone" ? "電話 (会社・店舗の電話)" : c === "referral" ? "紹介 (現場・知人など)" : CHANNEL_LABEL[c]}</option>
            ))}
          </select>
        </label>
        {tab !== "photo" && (
          <label className="block">
            <span className="label">受付の店舗</span>
            <select value={storeId} onChange={(e) => setStoreId(e.target.value as StoreId)} disabled={!canChooseStore} className="field">
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {tab === "photo" && (
        <CaptureUploader
          action={action}
          defaultKind="reception"
          fixedKind
          stores={stores}
          defaultStoreId={defaultStoreId}
          canChooseStore={canChooseStore}
          aiEnabled={aiEnabled}
          hidden={{ source: "photo", channel, ...(customer ? { customerId: customer.id } : {}) }}
          labels={{
            submit: "読み取って受付に入れる",
            pending: "AI がメモを読み取り中… (10〜20 秒)",
            sample: "サンプルのメモで試す",
            drop: "メモを撮影するか、写真を選んでください",
            dropNote: "用紙全体が写るように、明るい場所で撮影してください (写真は自動で縮小)",
            note: aiEnabled ? "読み取った内容は、登録する前に画面で確かめて直せます。読みにくい文字は黄色で表示します。" : "AI の API キーが未設定のため、サンプルの内容が表示されます。",
          }}
        />
      )}
      {tab === "text" && <TextInput action={action} channel={channel} storeId={storeId} voice={voice} customerId={customer?.id} />}
      {tab === "audio" && <AudioInput channel={channel} storeId={storeId} voice={voice} customerId={customer?.id} />}
    </div>
  );
}

function TextInput({ action, channel, storeId, voice, customerId }: { action: (formData: FormData) => Promise<void>; channel: Channel; storeId: StoreId; voice: boolean; customerId?: string }) {
  const [text, setText] = useState("");
  const [spoken, setSpoken] = useState(false);
  const [pending, start] = useTransition();
  // 使える音声入力 (ブラウザーの機能なので画面に出てから決める。サーバーで作る画面は「なし」)
  const detected = useSyncExternalStore<VoiceMode>(
    noSubscribe,
    () => (voice && canRecord() ? "server" : browserCanListen() ? "browser" : "none"),
    () => "none",
  );
  const [fallback, setFallback] = useState<VoiceMode | null>(null);
  const mode = fallback ?? detected;
  const rec = useRecorder(
    mode,
    (t) => {
      setSpoken(true);
      setText((prev) => (prev.trim() ? `${prev.trim()}\n${t}` : t));
    },
    { maxSeconds: 180, silenceMs: 4000, onServerFail: () => setFallback(browserCanListen() ? "browser" : "none") },
  );
  const recording = rec.state === "recording" || rec.state === "starting";
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      await action(fd);
    });
  }
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input type="hidden" name="source" value={spoken ? "voice" : "text"} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="storeId" value={storeId} />
      {customerId && <input type="hidden" name="customerId" value={customerId} />}
      {mode !== "none" && (
        <div className="flex flex-wrap items-center gap-3">
          {recording ? (
            <button type="button" onClick={() => rec.stop()} className="inline-flex h-11 items-center gap-2 rounded-full bg-critical px-5 text-sm font-medium text-white">
              <Square className="h-4 w-4" /> 話し終わったら押す ({rec.seconds} 秒)
            </button>
          ) : (
            <button type="button" onClick={() => rec.start()} disabled={rec.state === "transcribing" || pending} className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60">
              <Mic className="h-4 w-4" /> {rec.state === "transcribing" ? "文字にしています…" : text ? "続きを話す" : "話して入力する"}
            </button>
          )}
          {recording && <span aria-hidden className="h-2 rounded-full bg-accent transition-all" style={{ width: `${Math.max(8, Math.round(rec.level * 120))}px` }} />}
          <span className="text-xs text-ink-3">3 分まで。お名前・電話番号・住所・用件・希望の日時をはっきりお話しください</span>
        </div>
      )}
      {rec.interim && <p className="text-xs text-ink-3">{rec.interim}</p>}
      {rec.error && <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-xs text-critical-ink">{rec.error}</p>}
      <textarea name="text" value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder={PLACEHOLDER} className="field min-h-[9rem]" />
      <button type="submit" disabled={pending || recording || text.trim().length < 4} className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60">
        {pending ? "AI が内容を読み取り中… (5〜15 秒)" : "読み取って受付に入れる"}
      </button>
    </form>
  );
}

function AudioInput({ channel, storeId, voice, customerId }: { channel: Channel; storeId: StoreId; voice: boolean; customerId?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!voice) return <p className="rounded-lg bg-subtle px-3 py-3 text-xs text-ink-2">録音の文字起こしには OpenAI の API キーが必要です (設定 → 外部連携・AI)。キーを設定すると、録音のファイルを選ぶだけで受付に入れられます。</p>;
  async function send() {
    const f = ref.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.set("file", f, f.name);
      fd.set("channel", channel);
      fd.set("storeId", storeId);
      if (customerId) fd.set("customerId", customerId);
      const res = await fetch("/api/reception/audio", { method: "POST", body: fd });
      const body = (await res.json().catch(() => null)) as { href?: string; error?: string } | null;
      if (!res.ok || !body?.href) throw new Error(body?.error ?? "録音を読み取れませんでした。");
      window.location.assign(body.href);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <button type="button" onClick={() => ref.current?.click()} className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-line-strong px-4 py-8 text-center hover:border-accent hover:bg-accent-soft/40">
        <FileAudio className="h-8 w-8 text-ink-3" />
        <span className="mt-2 text-sm font-medium text-ink">{name || "録音のファイルを選ぶ"}</span>
        <span className="mt-1 text-xs text-ink-3">MP3・WAV・M4A・WebM・OGG (9.5 MB まで。電話の録音で約 10 分)</span>
      </button>
      <input ref={ref} type="file" accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.aac,.flac" className="hidden" onChange={(e) => setName(e.target.files?.[0]?.name ?? "")} />
      {error && <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-xs text-critical-ink">{error}</p>}
      <button type="button" onClick={send} disabled={!name || busy} className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60">
        {busy ? "文字にして読み取り中… (1 分の録音で 15〜30 秒)" : "文字にして受付に入れる"}
      </button>
      <p className="text-[11px] leading-relaxed text-ink-3">録音のファイルはこのシステムに保存しません (文字起こしだけを受付に残します)。</p>
    </div>
  );
}
