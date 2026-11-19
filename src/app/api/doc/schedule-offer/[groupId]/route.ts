import { NextResponse } from "next/server";
import { addAudit, mutate, newId, nowIso, syncDb } from "@/lib/db/store";
import type { ScheduleHold } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { shortDate } from "@/lib/calendar";
import { verifyOfferLink } from "@/lib/scheduling/offer-link";
import { sendAndRecord } from "@/lib/notify/send";
import { scheduleHoldNotices } from "@/lib/notify/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * お客様が日程の候補を選ぶページ (ログインなし・期限つきの署名リンク。src/lib/scheduling/offer-link.ts)
 * GET: 候補の一覧 / POST: 選んだ候補を記録して、店舗の担当者に知らせる (予定の確定は担当者が行う)
 * お客様に見せるのは日時と店舗名だけ (担当者の名前・ほかの予定は出さない)。検索エンジンに載らないよう noindex
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#eef4fb;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;color:#1f2937}main{max-width:520px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 12px}.card{background:#fff;border:1px solid #dbe4ef;border-radius:14px;padding:16px;margin:12px 0}button{width:100%;padding:14px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:16px;font-weight:600;cursor:pointer}button:hover{background:#1d4ed8}.muted{color:#6b7280;font-size:13px;line-height:1.6}textarea{width:100%;box-sizing:border-box;min-height:64px;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font:inherit;margin:8px 0}.when{font-size:18px;font-weight:700;margin:0 0 8px}.ok{color:#047857;font-weight:600}</style></head><body><main>${body}</main></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

const when = (h: ScheduleHold) => `${shortDate(h.date)}${h.endDate ? `〜${shortDate(h.endDate)}` : ""} ${h.startTime ? `${h.startTime}頃` : h.slot === "am" ? "午前" : h.slot === "pm" ? "午後" : "終日"}`;

async function load(req: Request, groupId: string) {
  const url = new URL(req.url);
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  const check = verifyOfferLink(groupId, exp, sig);
  if (check !== "ok") return { error: page("日程のご案内", `<h1>日程のご案内</h1><div class="card"><p>${check === "expired" ? "このご案内の有効期限が切れています。" : "リンクが正しくありません。"}お手数ですが、株式会社一畳屋までお電話でご連絡ください。</p></div>`, check === "expired" ? 410 : 403) };
  const db = await syncDb();
  const holds = (db.scheduleHolds ?? []).filter((h) => h.groupId === groupId).sort((a, b) => a.rank - b.rank);
  if (!holds.length) return { error: page("日程のご案内", `<h1>日程のご案内</h1><div class="card"><p>ご案内が見つかりません。お手数ですが、株式会社一畳屋までご連絡ください。</p></div>`, 404) };
  return { db, holds, query: `exp=${encodeURIComponent(exp ?? "")}&sig=${encodeURIComponent(sig ?? "")}` };
}

export async function GET(req: Request, { params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const r = await load(req, groupId);
  if ("error" in r) return r.error;
  const { db, holds, query } = r;
  const store = db.stores.find((s) => s.id === holds[0].storeId);
  const kind = SCHEDULE_KIND[holds[0].kind].label;
  const confirmed = holds.find((h) => h.status === "confirmed");
  const chosen = holds.find((h) => h.customerChoiceAt && h.status === "held");
  const head = `<h1>${esc(kind)}の日程のご案内</h1><p class="muted">株式会社一畳屋 ${esc(store?.name ?? "")}</p>`;
  if (confirmed) return page("日程のご案内", `${head}<div class="card"><p class="ok">${esc(when(confirmed))} で承りました。</p><p class="muted">当日はどうぞよろしくお願いいたします。</p></div>`);
  if (chosen) return page("日程のご案内", `${head}<div class="card"><p class="ok">第 ${chosen.rank} 候補 (${esc(when(chosen))}) をお選びいただきました。</p><p class="muted">担当者が確認のうえ、確定のご連絡をいたします。変更のご希望はお電話でお知らせください。</p></div>`);
  const open = holds.filter((h) => h.status === "held" && h.expiresAt > nowIso());
  if (!open.length) return page("日程のご案内", `${head}<div class="card"><p>ご案内した候補の受付期間が終わりました。お手数ですが、お電話でご連絡ください。新しい候補をご案内いたします。</p></div>`);
  const forms = open
    .map((h) => `<form class="card" method="post" action="?${query}"><p class="when">第 ${h.rank} 候補: ${esc(when(h))}</p><input type="hidden" name="holdId" value="${esc(h.id)}"><textarea name="note" maxlength="300" placeholder="ご連絡事項 (任意。駐車場所・ご在宅の時間など)"></textarea><button type="submit">この日にする</button></form>`)
    .join("");
  return page("日程のご案内", `${head}<p class="muted">ご都合のよい日をお選びください。どの日もご都合が合わない場合は、お電話でお知らせください。</p>${forms}`);
}

export async function POST(req: Request, { params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const r = await load(req, groupId);
  if ("error" in r) return r.error;
  const form = await req.formData().catch(() => null);
  const holdId = String(form?.get("holdId") ?? "");
  const note = String(form?.get("note") ?? "").slice(0, 300).trim();
  const target = r.holds.find((h) => h.id === holdId && h.status === "held" && h.expiresAt > nowIso());
  if (!target) return page("日程のご案内", `<h1>日程のご案内</h1><div class="card"><p>この候補は選べなくなりました。お手数ですが、お電話でご連絡ください。</p></div>`, 409);
  if (r.holds.some((h) => h.customerChoiceAt)) return GET(req, { params: Promise.resolve({ groupId }) });
  await mutate((db) => {
    const h = db.scheduleHolds.find((x) => x.id === holdId);
    if (!h || h.status !== "held") return;
    const t = nowIso();
    h.customerChoiceAt = t;
    h.customerChoiceNote = note ? `お客様: ${note}` : "お客様がリンクから選択";
    h.updatedAt = t;
    db.commLogs.push({ id: newId("cl"), customerId: h.customerId, channel: "web", direction: "inbound", subject: `日程の候補を選択: 第 ${h.rank} 候補 ${h.date}`, body: note || "(連絡事項なし)", at: t, userId: "system", relatedType: h.orderId ? "order" : h.inquiryId ? "inquiry" : undefined, relatedId: h.orderId ?? h.inquiryId, storeId: h.storeId });
    addAudit(db, { userId: "system", action: "update", entity: "schedule_hold", entityId: h.groupId, entityLabel: h.title, summary: `お客様が案内のリンクから第 ${h.rank} 候補 (${h.date}) を選択`, storeId: h.storeId });
  });
  const db = await syncDb();
  await sendAndRecord(scheduleHoldNotices(db, [target], "system", "customer_choice", note), "system").catch(() => {});
  return GET(req, { params: Promise.resolve({ groupId }) });
}
