import "server-only";
import { BACKEND } from "@/lib/db/store";
import { fmtFax, normFax } from "./numbers";
import { mockFaxAdapter } from "./mock";

/**
 * クラウド FAX サービスとの接続 (アダプター)
 * ------------------------------------------------------------
 * FAX サービスごとの違い (送信の API・状態の取得・受信の通知の形式と署名) は、このインターフェイスの実装に閉じ込める。
 * 業務の処理 (src/lib/fax/outbound.ts・inbound.ts) はアダプターだけを呼び、サービスを入れ替えても変わらない。
 *
 * 設定 (環境変数。.env.local の「外部連携」から npm run env:apply で本番へ):
 *   FAX_PROVIDER        使う FAX サービス。未設定 = 未接続 (送信できない。受信は画面からの登録だけ)
 *                       mock = 模擬 (サンプルデータの検証環境 DATA_BACKEND=json でだけ動く。本番のデータベースでは動かない)
 *   FAX_NUMBER          自社の FAX 番号 (全社で 1 つ。例: 096-348-3177)
 *   FAX_WEBHOOK_SECRET  受信・状態の通知 (/api/integrations/fax) の署名の鍵
 *   (FAX サービスの API キーなどは、サービスを決めたときにそのアダプターで読む。値は画面・ログに出さない)
 *
 * 実際のサービスとの通信を仮に成功扱いにすることはしない。未接続のときは送信を断り、
 * 「PDF を印刷して FAX 機で送る → 送信の記録だけ残す」(provider = manual) で運用できるようにしている。
 */

/** 送信の依頼 */
export interface FaxSendRequest {
  /** 送信先の FAX 番号 (数字だけ) */
  to: string;
  pdf: Buffer;
  fileName: string;
  /** この送信の一意の参照 (FAX の ID)。サービスが対応していれば重複の防止に使う */
  reference: string;
}

/**
 * 送信の結果
 * - ok: サービスが受け付けた (状態は sending = 処理中、すぐ送れた場合は sent)
 * - retryable: サービスに届く前の失敗 (接続できない・混雑・一時的な障害)。時間をおいて自動で再送する
 * - permanent: 再送しても同じ結果になる失敗 (番号の誤り・設定の誤り)
 * - unknown: 依頼を送ったあとに通信が切れ、受け付けられたか分からない。二重送信を避けるため自動では再送しない
 */
export type FaxSendOutcome =
  | { ok: true; providerId: string; status: "sending" | "sent"; pages?: number }
  | { ok: false; kind: "retryable" | "permanent" | "unknown"; message: string };

export type FaxRemoteStatus = { status: "sending" | "sent" | "failed"; error?: string; pages?: number; completedAt?: string } | { error: string };

/** FAX サービスからの通知 (受信・送信の状態の変化) */
export type FaxWebhookEvent =
  | {
      type: "received";
      providerId: string;
      from: string;
      to?: string;
      receivedAt: string;
      pages?: number;
      pdf: Buffer;
      fileName?: string;
      contentType?: string;
      /** 模擬の受信だけ: 書類の文字 (AI がないときの番号の読み取りに使う) */
      text?: string;
    }
  | { type: "status"; providerId: string; status: "sending" | "sent" | "failed"; error?: string; pages?: number; at?: string };

export interface FaxAdapter {
  /** FaxMessage.provider に入れる名前 */
  name: string;
  label: string;
  mode: "mock" | "live";
  send(req: FaxSendRequest): Promise<FaxSendOutcome>;
  /** 送信の状態を問い合わせる (通知が来ないとき・画面の「状態を更新」) */
  status(providerId: string): Promise<FaxRemoteStatus>;
  /** 通知 (Webhook) の署名を確かめて読む。署名が正しくなければ null */
  parseWebhook(headers: Headers, body: Buffer): Promise<FaxWebhookEvent[] | null>;
}

const env = (k: string) => (process.env[k] ?? "").trim();

/** 実装済みの FAX サービス (サービスを決めたら、ここにアダプターを加える) */
const LIVE_ADAPTERS: Record<string, () => FaxAdapter> = {};

export type FaxConnection =
  | { mode: "off"; label: string; detail: string }
  | { mode: "mock" | "live"; label: string; detail: string; adapter: FaxAdapter }
  | { mode: "error"; label: string; detail: string };

/** いまの接続の状態 (画面の表示・送信の可否) */
export function faxConnection(): FaxConnection {
  const name = env("FAX_PROVIDER").toLowerCase();
  if (!name) return { mode: "off", label: "未接続", detail: "FAX サービスが未接続です (FAX_PROVIDER が未設定)。送信は「印刷して FAX 機で送る → 送信の記録」、受信は PDF の登録で運用できます" };
  if (name === "mock") {
    if (BACKEND !== "json") return { mode: "error", label: "設定の誤り", detail: "模擬 (FAX_PROVIDER=mock) はサンプルデータの検証環境 (DATA_BACKEND=json) でだけ使えます。本番のデータベースでは送信しません" };
    return { mode: "mock", label: "模擬 (検証環境)", detail: "サンプルデータの検証用の模擬の FAX です。実際には送信・受信しません", adapter: mockFaxAdapter() };
  }
  const make = LIVE_ADAPTERS[name];
  if (!make) return { mode: "error", label: "設定の誤り", detail: `FAX_PROVIDER=${name} に対応するアダプターがありません` };
  const adapter = make();
  return { mode: "live", label: adapter.label, detail: `${adapter.label} に接続しています`, adapter };
}

/** 自社の FAX 番号 (表示用) */
export function faxLocalNumber(): string {
  return fmtFax(env("FAX_NUMBER"));
}

export function faxLocalDigits(): string {
  return normFax(env("FAX_NUMBER"));
}

export function faxWebhookSecret(): string | null {
  return env("FAX_WEBHOOK_SECRET") || null;
}
