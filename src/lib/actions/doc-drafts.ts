"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import type { Channel, CommLog, Database, DocDraft, DocDraftChannel, DocDraftFormat, User } from "@/lib/db/types";
import { canApproveDocDraft, canViewDocDraft, skipsApproval } from "@/lib/auth/permissions";
import { DRAFT_TEMPLATES, factsByRef, type DraftTemplate } from "@/lib/ai/draft";
import {
  DOC_DRAFT_CHANNEL_LABEL,
  DOC_DRAFT_STATUS,
  DocDraftError,
  assertSendable,
  copyDocDraft,
  createDocDraft,
  docDraftApprovers,
  draftCase,
  draftCustomer,
  draftRefs,
  editDocDraft,
  markDocDraftSent,
  noteSendProblem,
  splitSubject,
  transitionDocDraft,
  type DocDraftTransition,
} from "@/lib/doc-drafts";
import { isEmail, isLineTarget } from "@/lib/notify/channels";
import { sendAndRecord, type Outgoing } from "@/lib/notify/send";
import { docDraftResultNotices, docDraftReviewNotices } from "@/lib/notify/events";
import { CHANNEL_LABEL } from "@/lib/constants";
import { choice, fail, requireActionUser, str, withMsg } from "./guards";

const LIST = "/ai/drafts";
const page = (id: string) => `${LIST}/${id}`;

/** 文書の下書きの表 (doc_drafts) がまだ本番のデータベースにないときは断る (デプロイ・npm run db:migrate の前) */
async function assertTable(back: string) {
  if (BACKEND !== "supabase" || !missingTables().includes("doc_drafts")) return;
  if ((await recheckMissingTables()).includes("doc_drafts")) fail(back, "データベースに文書の下書きの表 (doc_drafts) がまだありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。");
}

/** 関数の中の DocDraftError を画面のエラーにする */
function guarded<T>(back: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DocDraftError) fail(back, e.message);
    throw e;
  }
}

function findDraft(db: Database, user: User, id: string): DocDraft {
  const d = (db.docDrafts ?? []).find((x) => x.id === id);
  if (!d) fail(LIST, "文書が見つかりません。");
  if (!canViewDocDraft(user, d)) fail(LIST, "この文書を見る権限がありません。");
  return d;
}

const refreshPaths = (id?: string) => {
  revalidatePath(LIST);
  if (id) revalidatePath(page(id));
  revalidatePath("/ai");
};

/* ================================================================== */
/* 保存 (「文書の作成」で作った文面)                                       */
/* ================================================================== */

/**
 * 「文書の作成」で作った文面を下書きとして保存する (版 1)。関係する記録は番号から読み直す (閲覧できる記録だけ)。
 * 画面で直した文面 (テキストの欄) をそのまま保存する
 */
export async function saveDocDraft(formData: FormData) {
  const user = await requireActionUser();
  const back = "/ai?tab=draft";
  await assertTable(back);
  const template = str(formData, "template");
  if (!(template in DRAFT_TEMPLATES)) fail(back, "ひな形が分かりません。もう一度作成してください。");
  const t = DRAFT_TEMPLATES[template as DraftTemplate];
  const format = choice<DocDraftFormat>(formData, "format", ["email", "line", "document"], "email");
  const ref = str(formData, "ref").slice(0, 40);
  const db0 = getDb();
  const facts = ref ? factsByRef(db0, user, ref) : null;
  if (ref && !facts) fail(back, `番号「${ref}」の記録が見つからないか、閲覧する権限がありません。`);
  const { refs, storeId } = draftRefs(db0, user, facts ? { label: facts.label, href: facts.href } : undefined);
  const raw = str(formData, "body");
  const sub = str(formData, "subject");
  const split = sub ? { subject: sub, body: raw } : splitSubject(format, raw);
  if (!split.body) fail(back, "文面が空です。");
  const provider = choice<DocDraft["provider"]>(formData, "provider", ["claude", "openai", "rules"], "rules");
  const id = await mutate((db) =>
    guarded(back, () => {
      const d = createDocDraft(db, user, { template, templateLabel: t.label, format, audience: t.audience, subject: split.subject, body: split.body, provider, notes: str(formData, "notes"), refs, storeId });
      addAudit(db, { userId: user.id, action: "create", entity: "doc_draft", entityId: d.id, entityLabel: `${d.number} ${d.title}`, summary: `文書の下書きを保存 (${d.number} ${d.title})`, storeId: d.storeId });
      return d.id;
    }),
  );
  refreshPaths(id);
  redirect(withMsg(page(id), "下書きとして保存しました。内容を確かめて「内容を確認した」を押すと、承認に進みます。"));
}

/* ================================================================== */
/* 文面の修正                                                            */
/* ================================================================== */

export async function updateDocDraft(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = page(id);
  await assertTable(back);
  const r = await mutate((db) => {
    const d = findDraft(db, user, id);
    return guarded(back, () => {
      const res = editDocDraft(d, user, { subject: str(formData, "subject"), body: str(formData, "body"), note: str(formData, "note") });
      if (res.changed) addAudit(db, { userId: user.id, action: "update", entity: "doc_draft", entityId: d.id, entityLabel: `${d.number} ${d.title}`, summary: `文書の文面を修正 (第 ${d.version} 版${res.reset ? "・確認と承認はやり直し" : ""})`, storeId: d.storeId, changes: res.changes });
      return res;
    });
  });
  refreshPaths(id);
  if (!r.changed) redirect(withMsg(back, "変更はありませんでした。"));
  redirect(withMsg(back, r.reset ? "保存しました。文面を直したため、下書きに戻りました (もう一度「内容を確認した」→ 承認 が必要です)。" : "保存しました。"));
}

/* ================================================================== */
/* 状態の変更 (確認・承認・差し戻し・破棄・戻す)                               */
/* ================================================================== */

const DONE: Record<DocDraftTransition, string> = {
  review: "確認済みにしました。承認する人に知らせました。",
  approve: "承認しました。作成者が送信できます。",
  return: "差し戻しました。作成者に知らせました。",
  discard: "破棄しました。",
  restore: "下書きに戻しました。",
};

export async function changeDocDraftStatus(id: string, action: DocDraftTransition, formData: FormData) {
  const user = await requireActionUser();
  const back = page(id);
  if (!(action in DONE)) fail(back, "操作が分かりません。");
  await assertTable(back);
  const comment = str(formData, "comment");
  const r = await mutate((db) => {
    const d = findDraft(db, user, id);
    return guarded(back, () => {
      const t = transitionDocDraft(d, user, action, comment);
      addAudit(db, {
        userId: user.id,
        action: action === "approve" ? "approve" : action === "return" ? "reject" : "status",
        entity: "doc_draft",
        entityId: d.id,
        entityLabel: `${d.number} ${d.title}`,
        summary: `文書を「${DOC_DRAFT_STATUS[t.to].label}」に (${DOC_DRAFT_STATUS[t.from].label} → ${DOC_DRAFT_STATUS[t.to].label}${comment ? `・${comment.slice(0, 60)}` : ""})`,
        storeId: d.storeId,
        changes: [{ field: "status", before: DOC_DRAFT_STATUS[t.from].label, after: DOC_DRAFT_STATUS[t.to].label }],
      });
      // 管理者 (社長) が自分の文書を確認したときは承認を省略する (承認の記録は残す。CLAUDE.md の設計原則 3)
      let auto = false;
      if (action === "review" && d.createdBy === user.id && skipsApproval(user) && canApproveDocDraft(user, d)) {
        transitionDocDraft(d, user, "approve", "管理者の文書のため承認を省略");
        addAudit(db, { userId: user.id, action: "approve", entity: "doc_draft", entityId: d.id, entityLabel: `${d.number} ${d.title}`, summary: "文書を承認 (管理者の文書のため承認を省略)", storeId: d.storeId, changes: [{ field: "status", before: DOC_DRAFT_STATUS.reviewed.label, after: DOC_DRAFT_STATUS.approved.label }] });
        auto = true;
      }
      return { d: { ...d }, auto };
    });
  });
  // 知らせ (保存のあと)
  const db = getDb();
  if (action === "review" && !r.auto) await sendAndRecord(docDraftReviewNotices(db, r.d, docDraftApprovers(db, r.d)), user.id);
  if (action === "approve" || action === "return") await sendAndRecord(docDraftResultNotices(db, r.d, user.id, action === "approve" ? "approved" : "returned", comment || undefined), user.id);
  refreshPaths(id);
  redirect(withMsg(back, r.auto ? "確認済みにしました。管理者の文書のため承認を省略し、承認済みにしました。" : DONE[action]));
}

/* ================================================================== */
/* 送信                                                                  */
/* ================================================================== */

const COMM_CHANNEL: Record<DocDraftChannel, Channel> = { email: "email", line: "line", chatwork: "chatwork", manual_mail: "mail", manual_hand: "visit" };

/** 送った文書をやりとり履歴に残す (お客様の文書だけ)。受注のときは経過メモにも書く */
function recordComm(db: Database, user: User, d: DocDraft, channel: DocDraftChannel, deliveryId?: string): string | undefined {
  const customer = draftCustomer(db, d);
  if (!customer) return undefined;
  const c = draftCase(d);
  const relatedType = c && c.type !== "customer" ? c.type : undefined;
  const log: CommLog = {
    id: newId("cl"),
    customerId: customer.id,
    storeId: d.storeId,
    channel: COMM_CHANNEL[channel],
    direction: "outbound",
    subject: (d.subject || d.title).slice(0, 100),
    body: d.body,
    at: nowIso(),
    userId: user.id,
    relatedType,
    relatedId: relatedType ? c!.id : undefined,
    deliveryId,
  };
  db.commLogs.push(log);
  if (relatedType === "order") {
    const o = db.orders.find((x) => x.id === c!.id);
    if (o) {
      o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "note", body: `文書 ${d.number}「${d.title}」をお客様へ${channel.startsWith("manual") ? `${DOC_DRAFT_CHANNEL_LABEL[channel].replace(/ \(記録のみ\)$/, "")}で渡した` : `${CHANNEL_LABEL[COMM_CHANNEL[channel]]}で送信`}` });
      o.updatedAt = nowIso();
    }
  }
  return log.id;
}

/**
 * 承認済みの文書を送る (メール・LINE・Chatwork)。送る文面は承認された文面 (フォームの文面は使わない)。
 * 送れたときだけ送信済みにする。失敗・送信の設定がないときは承認済みのまま理由を残す
 */
export async function sendDocDraft(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = page(id);
  await assertTable(back);
  const d0 = findDraft(getDb(), user, id);
  guarded(back, () => assertSendable(d0, user));
  const channel = choice<"email" | "line" | "chatwork">(formData, "channel", ["email", "line", "chatwork"], "email");
  const to = str(formData, "to");
  if (channel === "email" && !isEmail(to)) fail(back, "メールアドレスを正しく入力してください。");
  if (channel === "line" && !isLineTarget(to)) fail(back, "LINE のユーザー ID (U で始まる 33 文字) を入力してください。");
  if (channel === "chatwork" && to && !/^\d{1,20}$/.test(to)) fail(back, "Chatwork のルーム ID は数字です (空欄なら社内通知のルーム)。");
  const label = str(formData, "toLabel").slice(0, 100) || (draftCustomer(getDb(), d0) ? `${draftCustomer(getDb(), d0)!.name} 様` : "");
  const c = draftCase(d0);
  const customer = draftCustomer(getDb(), d0);
  const out: Outgoing = {
    channel,
    to,
    toLabel: label || undefined,
    subject: channel === "line" ? undefined : d0.subject || d0.title,
    body: d0.body,
    purpose: "message",
    relatedType: c && c.type !== "customer" ? c.type : customer ? "customer" : undefined,
    relatedId: c && c.type !== "customer" ? c.id : customer?.id,
  };
  const sentVersion = d0.version;
  let outcome: { status: "sent" | "failed" | "skipped"; error?: string } = { status: "failed" };
  await sendAndRecord([out], user.id, (db, deliveries) => {
    const dl = deliveries[0];
    const d = (db.docDrafts ?? []).find((x) => x.id === id);
    outcome = { status: dl.status, error: dl.error };
    if (!d) return;
    if (dl.status === "sent") {
      const commLogId = recordComm(db, user, d, channel, dl.id);
      try {
        markDocDraftSent(d, user, { channel, recipient: dl.recipient, recipientLabel: label || undefined, deliveryId: dl.id, commLogId, comment: d.version !== sentVersion ? `送信中に文面が変わりました (送ったのは第 ${sentVersion} 版)` : undefined });
      } catch {
        // 送信の間にほかの人が状態を変えた: 送ったことだけは記録する
        noteSendProblem(d, user, "send_failed", { deliveryId: dl.id, comment: `送信はしましたが、状態を送信済みにできませんでした (いまの状態: ${DOC_DRAFT_STATUS[d.status].label})` });
      }
      addAudit(db, { userId: user.id, action: "send", entity: "doc_draft", entityId: d.id, entityLabel: `${d.number} ${d.title}`, summary: `文書を${DOC_DRAFT_CHANNEL_LABEL[channel]}で送信 (${label || dl.recipient})`, storeId: d.storeId, changes: [{ field: "status", before: DOC_DRAFT_STATUS.approved.label, after: DOC_DRAFT_STATUS.sent.label }] });
    } else {
      noteSendProblem(d, user, dl.status === "skipped" ? "send_skipped" : "send_failed", { deliveryId: dl.id, comment: dl.status === "skipped" ? `${DOC_DRAFT_CHANNEL_LABEL[channel]}の送信の設定がありません` : (dl.error ?? "原因不明") });
      addAudit(db, { userId: user.id, action: "send", entity: "doc_draft", entityId: d.id, entityLabel: `${d.number} ${d.title}`, summary: `文書を${DOC_DRAFT_CHANNEL_LABEL[channel]}で送れませんでした (${dl.status === "skipped" ? "送信の設定なし" : (dl.error ?? "原因不明").slice(0, 80)})`, storeId: d.storeId });
    }
  });
  refreshPaths(id);
  const o = outcome as { status: "sent" | "failed" | "skipped"; error?: string };
  if (o.status === "sent") redirect(withMsg(back, `${DOC_DRAFT_CHANNEL_LABEL[channel]}で送信しました。やりとり履歴・送信履歴にも残しました。`));
  if (o.status === "skipped") fail(back, `${DOC_DRAFT_CHANNEL_LABEL[channel]}の送信の設定がないため送れませんでした (設定 → 外部連携・AI)。文書は承認済みのままです。郵送・手渡しで渡したときは「記録だけ残す」を使ってください。`);
  fail(back, `送信できませんでした: ${o.error ?? "原因不明"}。文書は承認済みのままです。`);
}

/** 郵送・手渡しなどシステムの外で渡した: 記録だけ残して送信済みにする */
export async function recordDocDraftHanded(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = page(id);
  await assertTable(back);
  const how = choice<DocDraftChannel>(formData, "how", ["manual_mail", "manual_hand"], "manual_mail");
  const note = str(formData, "note").slice(0, 200);
  await mutate((db) => {
    const d = findDraft(db, user, id);
    guarded(back, () => {
      assertSendable(d, user);
      const commLogId = recordComm(db, user, d, how);
      const customer = draftCustomer(db, d);
      markDocDraftSent(d, user, { channel: how, recipientLabel: customer ? `${customer.name} 様` : undefined, recipient: note || undefined, commLogId, comment: note || undefined });
      addAudit(db, { userId: user.id, action: "status", entity: "doc_draft", entityId: d.id, entityLabel: `${d.number} ${d.title}`, summary: `文書を${DOC_DRAFT_CHANNEL_LABEL[how]}として送信済みに${note ? ` (${note})` : ""}`, storeId: d.storeId, changes: [{ field: "status", before: DOC_DRAFT_STATUS.approved.label, after: DOC_DRAFT_STATUS.sent.label }] });
    });
  });
  refreshPaths(id);
  redirect(withMsg(back, "送信済みとして記録しました。"));
}

/** 文書を複製して新しい下書きにする (送った文書を直して送り直すとき) */
export async function copyDocDraftAction(id: string) {
  const user = await requireActionUser();
  const back = page(id);
  await assertTable(back);
  const newIdValue = await mutate((db) => {
    const src = findDraft(db, user, id);
    return guarded(back, () => {
      const d = copyDocDraft(db, user, src);
      addAudit(db, { userId: user.id, action: "create", entity: "doc_draft", entityId: d.id, entityLabel: `${d.number} ${d.title}`, summary: `文書 ${src.number} を複製して下書きを作成 (${d.number})`, storeId: d.storeId });
      return d.id;
    });
  });
  refreshPaths(newIdValue);
  redirect(withMsg(page(newIdValue), `文書 ${findDraft(getDb(), user, id).number} を複製しました。直してから確認・承認に進めてください。`));
}
