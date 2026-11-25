import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";

/**
 * Web Push (スマートフォン・パソコンのプッシュ通知) の暗号と署名 (Node の組み込みの暗号だけで作る。外部のライブラリを使わない)
 * ------------------------------------------------------------
 * - 本文の暗号: RFC 8291 (Message Encryption for Web Push) + RFC 8188 (aes128gcm)。端末の公開鍵 (p256dh) と auth で暗号にし、
 *   通知の配信サービス (Google・Apple・Mozilla) には中身が読めない形で渡す
 * - 送り主の証明: RFC 8292 (VAPID)。ES256 の JWT を Authorization: vapid t=…, k=… で付ける
 * テストは scripts/tests/chat/chat.test.mjs (RFC 8291 の付録の値と一致するか)
 */

export const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
export const fromB64u = (s: string) => Buffer.from(s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), "base64url");

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
const cat = (...parts: (Buffer | string | number[])[]) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "binary") : Array.isArray(p) ? Buffer.from(p) : p)));

export interface VapidKeys {
  /** 公開鍵 (非圧縮の P-256 の点 65 バイト、base64url)。ブラウザの applicationServerKey */
  publicKey: string;
  /** 秘密鍵 (32 バイト、base64url) */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(pad32(ecdh.getPrivateKey())) };
}

function pad32(b: Buffer): Buffer {
  return b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]);
}

/** 鍵の形が正しいか (公開鍵 65 バイト・0x04 で始まる、秘密鍵 32 バイト) */
export function validVapid(k: Partial<VapidKeys> | undefined): k is VapidKeys {
  try {
    if (!k?.publicKey || !k.privateKey) return false;
    const pub = fromB64u(k.publicKey);
    const priv = fromB64u(k.privateKey);
    if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return false;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch {
    return false;
  }
}

/** VAPID の Authorization の値 (送り先の配信サービスの origin ごと。有効期限は 12 時間) */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const pub = fromB64u(keys.publicKey);
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey };
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const input = `${head}.${claims}`;
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64u(sig)}, k=${keys.publicKey}`;
}

/**
 * 本文を暗号にする (aes128gcm。レコードは 1 つ)。
 * salt と送り主の一時的な秘密鍵 (asPrivate) はテストのときだけ渡す (ふだんは毎回ランダム)
 */
export function encryptPayload(payload: Buffer, p256dh: string, auth: string, opts: { salt?: Buffer; asPrivate?: Buffer; recordSize?: number } = {}): Buffer {
  const ua = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (ua.length !== 65 || ua[0] !== 4) throw new Error("端末の公開鍵 (p256dh) の形が正しくありません");
  if (authSecret.length < 16) throw new Error("端末の auth の形が正しくありません");
  const rs = opts.recordSize ?? 4096;
  if (payload.length + 17 > rs) throw new Error("通知の本文が長すぎます");
  const ecdh = createECDH("prime256v1");
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate);
  else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(ua);
  // RFC 8291 3.4: 共有の秘密 → IKM
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, cat("WebPush: info\0", ua, asPub, [1]));
  // RFC 8188 2.2: IKM と salt → 内容の鍵 (16 バイト) と nonce (12 バイト)
  const salt = opts.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, cat("Content-Encoding: aes128gcm\0", [1])).subarray(0, 16);
  const nonce = hmac(prk, cat("Content-Encoding: nonce\0", [1])).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 最後のレコードの区切り 0x02 を付ける (埋め草なし)
  const ct = Buffer.concat([cipher.update(cat(payload, [2])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPub.length, 20);
  return Buffer.concat([header, asPub, ct]);
}
