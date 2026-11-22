"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { speechChunks } from "@/lib/speech-text";

/**
 * 「質問する」の音声 (読み上げと音声入力)
 * ------------------------------------------------------------
 * - server: サーバーの音声 (OpenAI。読み上げは 20 代の日本人女性の声、音声入力は日本語の文字起こし)。ログインした社員
 * - browser: ブラウザーの音声機能 (読み上げ speechSynthesis の日本語の女性の声・音声認識 SpeechRecognition)。
 *   ログイン前の画面と、サーバーの音声が使えないとき (キーなし・失敗) に使う
 * スマートフォン (特に iPhone) は、操作 (ボタンを押す) の中で一度音を鳴らさないと後から自動で再生できないため、
 * 送信・録音のボタンを押したときに unlock() で無音を鳴らしておく
 */

export type VoiceMode = "server" | "browser" | "none";

const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

/** ブラウザーの読み上げで選ぶ声 (日本語の女性の声。上から順に優先) */
const FEMALE = [/Nanami/i, /Mayu/i, /Aoi/i, /Shiori/i, /Haruka/i, /Ayumi/i, /Kyoko/i, /O-?ren/i, /Mizuki/i, /Google 日本語/i, /Female|女性/i];
const MALE = /Ichiro|Otoya|Keita|Daichi|Naoki|Hattori|Takumi|Kenji|Male|男性/i;

function pickBrowserVoice(): SpeechSynthesisVoice | undefined {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return undefined;
  const ja = window.speechSynthesis.getVoices().filter((v) => /^ja(-|_|$)/i.test(v.lang));
  for (const re of FEMALE) {
    const v = ja.find((x) => re.test(x.name) && !MALE.test(x.name));
    if (v) return v;
  }
  return ja.find((v) => !MALE.test(v.name)) ?? ja[0];
}

export function browserCanSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function browserCanListen(): boolean {
  return Boolean(recognitionCtor());
}

export function canRecord(): boolean {
  return typeof window !== "undefined" && window.isSecureContext !== false && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
}

/* ================================================================== */
/* 読み上げ                                                              */
/* ================================================================== */

export interface SpeakOptions {
  /** 要点だけを読む (会話モード。続きは画面で) */
  brief?: boolean;
  /** 読み終わったとき (止めたときは呼ばない) */
  onEnd?: () => void;
}

const RATE_KEY = "ichijoya-chatbot-rate";
export const RATES = [0.9, 1, 1.2, 1.4] as const;

export function useSpeaker(mode: VoiceMode) {
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [rate, setRateState] = useState(1);
  const rateRef = useRef(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 再生中のかたまりの終わりを待っている処理 (止めたときに終わらせる) */
  const waitRef = useRef<(() => void) | null>(null);
  const seq = useRef(0);

  // ブラウザーの声の一覧は後から読み込まれる・保存した速さ
  useEffect(() => {
    try {
      const r = Number(localStorage.getItem(RATE_KEY));
      if ((RATES as readonly number[]).includes(r)) {
        rateRef.current = r;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 保存した設定はブラウザでしか読めない
        setRateState(r);
      }
    } catch {
      /* 保存なし */
    }
    if (!browserCanSpeak()) return;
    const load = () => window.speechSynthesis.getVoices();
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", load);
  }, []);

  const setRate = useCallback((r: number) => {
    rateRef.current = r;
    setRateState(r);
    if (audioRef.current) audioRef.current.playbackRate = r;
    try {
      localStorage.setItem(RATE_KEY, String(r));
    } catch {
      /* 保存できない */
    }
  }, []);

  const release = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };

  const stop = useCallback(() => {
    seq.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    waitRef.current?.();
    waitRef.current = null;
    release();
    if (browserCanSpeak()) window.speechSynthesis.cancel();
    setSpeakingId(null);
    setLoadingId(null);
  }, []);

  useEffect(() => stop, [stop]);

  /** 操作 (クリック・キー入力) の中で呼ぶ: あとから自動で再生できるようにする */
  const unlock = useCallback(() => {
    try {
      if (!audioRef.current) audioRef.current = new Audio();
      const a = audioRef.current;
      if (!a.src || a.src === SILENT_WAV) {
        a.src = SILENT_WAV;
        void a.play().catch(() => {});
      }
      if (browserCanSpeak() && mode !== "server") {
        // iPhone の読み上げも、最初の 1 回は操作の中で始める必要がある
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    } catch {
      /* 音が使えない環境 */
    }
  }, [mode]);

  const speakBrowser = useCallback((id: number, parts: string[], my: number, onEnd?: () => void) => {
    if (!browserCanSpeak()) {
      setError("このブラウザーは読み上げに対応していません。");
      setSpeakingId(null);
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    const voice = pickBrowserVoice();
    // 長い文は途中で止まるブラウザーがあるため、文ごとに分けて読む
    const sentences = parts.join("").match(/[^。！？!?]+[。！？!?]?/g) ?? [];
    if (!sentences.length) {
      setSpeakingId(null);
      onEnd?.();
      return;
    }
    setSpeakingId(id);
    sentences.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      u.lang = "ja-JP";
      if (voice) u.voice = voice;
      u.rate = 1.05 * rateRef.current;
      u.pitch = 1.15;
      if (i === sentences.length - 1)
        u.onend = () => {
          if (my !== seq.current) return;
          setSpeakingId(null);
          onEnd?.();
        };
      u.onerror = () => my === seq.current && setSpeakingId(null);
      synth.speak(u);
    });
  }, []);

  /** 1 かたまりの音声 (サーバー) */
  const fetchChunk = (text: string, signal: AbortSignal): Promise<Blob> =>
    fetch("/api/assistant/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, hasTable: false }), signal }).then(async (res) => {
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("audio/")) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "読み上げの音声を作れませんでした。");
      }
      return res.blob();
    });

  const speak = useCallback(
    async (id: number, text: string, hasTable = false, opts: SpeakOptions = {}) => {
      stop();
      setError("");
      const my = ++seq.current;
      if (mode === "none") return;
      const chunks = speechChunks(text, { hasTable, brief: opts.brief });
      if (!chunks.length) {
        opts.onEnd?.();
        return;
      }
      if (mode === "browser") return speakBrowser(id, chunks, my, opts.onEnd);
      setLoadingId(id);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let i = 0;
      try {
        // 最初の 1 文をすぐに読み始め、読んでいる間に次のかたまりを作る
        let next = fetchChunk(chunks[0], ctrl.signal);
        for (; i < chunks.length; i++) {
          const blob = await next;
          if (my !== seq.current) return;
          if (i + 1 < chunks.length) {
            next = fetchChunk(chunks[i + 1], ctrl.signal);
            next.catch(() => {});
          }
          release();
          urlRef.current = URL.createObjectURL(blob);
          if (!audioRef.current) audioRef.current = new Audio();
          const a = audioRef.current;
          a.src = urlRef.current;
          a.playbackRate = rateRef.current;
          const ended = new Promise<void>((resolve, reject) => {
            waitRef.current = resolve;
            a.onended = () => resolve();
            a.onerror = () => reject(new Error("音声を再生できませんでした。"));
          });
          setLoadingId(null);
          setSpeakingId(id);
          await a.play();
          await ended;
          waitRef.current = null;
          if (my !== seq.current) return;
        }
        release();
        setSpeakingId(null);
        opts.onEnd?.();
      } catch (err) {
        if (my !== seq.current || (err as Error).name === "AbortError") return;
        setLoadingId(null);
        // 自動再生が止められた・サーバーの音声が使えないときは、残りをブラウザーの声で読む
        if ((err as Error).name === "NotAllowedError") {
          setSpeakingId(null);
          setError("音声を再生できませんでした。もう一度 🔈 を押してください。");
          return;
        }
        if (browserCanSpeak()) speakBrowser(id, chunks.slice(i), my, opts.onEnd);
        else {
          setSpeakingId(null);
          setError((err as Error).message);
        }
      }
    },
    [mode, speakBrowser, stop],
  );

  return { speak, stop, unlock, speakingId, loadingId, error, clearError: () => setError(""), rate, setRate };
}

/* ================================================================== */
/* 音声入力                                                              */
/* ================================================================== */

export type RecState = "idle" | "starting" | "recording" | "transcribing";

const MAX_SECONDS = 60;
/** 話し終わってから止めるまでの無音の長さ */
const SILENCE_MS = 1600;
/** 録音を始めてから声が聞こえないときに止めるまで */
const NO_SPEECH_MS = 9000;

function micError(err: unknown): string {
  const name = (err as Error)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "マイクの使用が許可されていません。アドレス欄の左のアイコン (鍵など) からマイクを「許可」にして、もう一度お試しください。";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "マイクが見つかりません。マイクをつないでから、もう一度お試しください。";
  if (name === "NotReadableError") return "マイクを使えませんでした (ほかのアプリが使っている可能性があります)。";
  return "マイクを使えませんでした。もう一度お試しください。";
}

function pickMime(): string | undefined {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return undefined;
}

/** 録音の終わり方: text = 文字になった / empty = 声が聞き取れなかった / error = 失敗 / cancel = やめた */
export type RecResult = "text" | "empty" | "error" | "cancel";

export interface RecorderOptions {
  /** 録音が終わったとき (会話モードで次を決める) */
  onDone?: (r: RecResult) => void;
  /** サーバーの音声入力が使えなかった (ブラウザーの音声認識に切り替える) */
  onServerFail?: () => void;
  /** 録音の長さの上限 (秒。既定 60)。受付の内容を話して入力するときは長くする */
  maxSeconds?: number;
  /** 話し終わってから止めるまでの無音の長さ (ミリ秒。既定 1600)。考えながら話す入力は長くする */
  silenceMs?: number;
}

export function useRecorder(mode: VoiceMode, onText: (text: string) => void, options: RecorderOptions = {}) {
  const [state, setState] = useState<RecState>("idle");
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const cleanupRef = useRef<() => void>(() => {});
  const finishRef = useRef<(send: boolean) => void>(() => {});
  const onTextRef = useRef(onText);
  const optsRef = useRef(options);
  useEffect(() => {
    onTextRef.current = onText;
    optsRef.current = options;
  });

  useEffect(() => () => cleanupRef.current(), []);

  const startServer = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      setState("idle");
      setError(micError(err));
      return;
    }
    const mime = pickMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setState("idle");
      setError("このブラウザーでは録音できません。");
      return;
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    // 音の大きさ (表示と、話し終わりの判定)
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const ctx = AC ? new AC() : undefined;
    const analyser = ctx?.createAnalyser();
    if (ctx && analyser) {
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
    }
    const buf = new Float32Array(analyser?.fftSize ?? 1024);
    const t0 = Date.now();
    // 周りの音の大きさ (すぐ下がり、ゆっくり上がる。話し始めがすぐでも、話し声を周りの音と取り違えない)
    let floor = 0.01;
    let spoke = false;
    let lastVoice = Date.now();
    let sendOnStop = true;
    let silent = false;
    const tick = window.setInterval(() => {
      const now = Date.now();
      setSeconds(Math.floor((now - t0) / 1000));
      if (analyser) {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        setLevel(Math.min(1, rms * 8));
        floor = rms < floor ? rms : floor + (rms - floor) * 0.005;
        if (rms > Math.max(0.02, floor * 3)) {
          spoke = true;
          lastVoice = now;
        }
        if (spoke && now - lastVoice > (optsRef.current.silenceMs ?? SILENCE_MS)) finish(true);
        else if (!spoke && now - t0 > NO_SPEECH_MS) {
          setError("声が聞き取れませんでした。マイクに近づいて、もう一度お話しください。");
          silent = true;
          finish(false);
        }
      }
      if (now - t0 > (optsRef.current.maxSeconds ?? MAX_SECONDS) * 1000) finish(true);
    }, 100);
    const cleanup = () => {
      window.clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
      setLevel(0);
    };
    cleanupRef.current = () => {
      sendOnStop = false;
      if (rec.state !== "inactive") rec.stop();
      cleanup();
    };
    const finish = (send: boolean) => {
      sendOnStop = send;
      if (rec.state !== "inactive") rec.stop();
    };
    finishRef.current = finish;
    rec.onstop = async () => {
      cleanup();
      if (!sendOnStop || !chunks.length) {
        setState("idle");
        optsRef.current.onDone?.(silent ? "empty" : "cancel");
        return;
      }
      setState("transcribing");
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
      let result: RecResult = "error";
      try {
        const form = new FormData();
        form.append("audio", blob, `voice.${/mp4|m4a/.test(blob.type) ? "m4a" : /ogg/.test(blob.type) ? "ogg" : "webm"}`);
        const res = await fetch("/api/assistant/transcribe", { method: "POST", body: form });
        const body = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
        if (!res.ok) {
          // サーバーの音声入力が止まっている (キーなし・障害) ときは、次からブラウザーの音声認識を使う
          if (res.status >= 500 && recognitionCtor()) optsRef.current.onServerFail?.();
          throw new Error(body?.error ?? "音声を文字にできませんでした。");
        }
        const text = (body?.text ?? "").trim();
        if (!text) {
          setError("声が聞き取れませんでした。もう一度お話しください。");
          result = "empty";
        } else {
          result = "text";
          onTextRef.current(text);
        }
      } catch (err) {
        setError((err as Error).message || "音声を文字にできませんでした。");
      } finally {
        setState("idle");
        optsRef.current.onDone?.(result);
      }
    };
    rec.start(250);
    setState("recording");
  }, []);

  const startBrowser = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setState("idle");
      setError("このブラウザーは音声入力に対応していません。Chrome・Edge・Safari をお使いください。");
      return;
    }
    const r = new Ctor();
    r.lang = "ja-JP";
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = "";
    let send = true;
    let failed: RecResult | undefined;
    const t0 = Date.now();
    const tick = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - t0) / 1000));
      if (Date.now() - t0 > (optsRef.current.maxSeconds ?? MAX_SECONDS) * 1000) r.stop();
    }, 250);
    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0]?.transcript ?? "";
      const last = e.results[e.results.length - 1];
      if (last?.isFinal) finalText = text;
      setInterim(text);
      setLevel(0.6);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setError("マイクの使用が許可されていません。アドレス欄の左のアイコンからマイクを「許可」にしてください。");
      else if (e.error === "no-speech") setError("声が聞き取れませんでした。もう一度お話しください。");
      else if (e.error !== "aborted") setError("音声入力に失敗しました。もう一度お試しください。");
      failed = e.error === "no-speech" ? "empty" : e.error === "aborted" ? "cancel" : "error";
      send = false;
    };
    r.onend = () => {
      window.clearInterval(tick);
      setLevel(0);
      setState("idle");
      const text = (finalText || "").trim();
      setInterim("");
      if (send && text) onTextRef.current(text);
      optsRef.current.onDone?.(send && text ? "text" : (failed ?? (send ? "empty" : "cancel")));
    };
    cleanupRef.current = () => {
      send = false;
      window.clearInterval(tick);
      try {
        r.abort();
      } catch {
        /* 終わっている */
      }
    };
    finishRef.current = (doSend: boolean) => {
      send = doSend;
      r.stop();
    };
    try {
      r.start();
      setState("recording");
    } catch {
      window.clearInterval(tick);
      setState("idle");
      setError("音声入力を始められませんでした。");
    }
  }, []);

  const start = useCallback(() => {
    if (state !== "idle") return;
    setError("");
    setSeconds(0);
    setInterim("");
    setState("starting");
    if (mode === "server" && canRecord()) void startServer();
    else startBrowser();
  }, [mode, startBrowser, startServer, state]);

  /** 録音を終えて送る */
  const stop = useCallback(() => finishRef.current(true), []);
  /** 録音をやめる (送らない) */
  const cancel = useCallback(() => {
    cleanupRef.current();
    setState("idle");
    setInterim("");
  }, []);

  return { state, level, seconds, interim, error, start, stop, cancel, clearError: () => setError("") };
}
