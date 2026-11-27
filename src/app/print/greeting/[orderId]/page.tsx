import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canOutputDocument } from "@/lib/auth/permissions";
import { orderAccessInfo } from "@/lib/case-access";
import { documentSettings } from "@/lib/doc-settings";
import { greetingDraft, GREETING_SERVICES } from "@/lib/greeting";
import { safeReturn } from "@/lib/actions/guards";
import { toDateKey } from "@/lib/format";
import { GreetingLetter } from "@/components/print/GreetingLetter";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "近隣挨拶文" };

/**
 * リフォーム現場の近隣挨拶文 (お客様のご要望 2026-11-27「■3」): 案件 (受注) の顧客名・担当者名・工事日程を入れた下書き → 画面で直して印刷 (A4 縦)。
 * 見られるのは受注を見られる社員 (帳票の出力と同じ canOutputDocument)。下書きは保存しない (開くたびに案件から作る)
 */
export default async function GreetingPrintPage({ params, searchParams }: { params: Promise<{ orderId: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const { orderId } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = await syncDb();
  const o = db.orders.find((x) => x.id === orderId);
  if (!o) notFound();
  if (!canOutputDocument(user, orderAccessInfo(db, user, o).access)) redirect("/orders");
  const ds = documentSettings(db);
  const draft = greetingDraft(db, o, toDateKey(new Date()), { name: ds.companyName.replace(/^株式会社\s*/, "株式会社　"), postalCode: ds.postalCode, address: ds.address, tel: ds.tel, services: GREETING_SERVICES });
  const back = safeReturn(sp.returnTo ?? "", `/orders/${o.id}`);
  return <GreetingLetter draft={draft} backHref={back} />;
}
