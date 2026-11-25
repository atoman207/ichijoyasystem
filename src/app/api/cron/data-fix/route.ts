import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { addAudit, mutate, newId, nowIso, syncDb } from "@/lib/db/store";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { categoryName } from "@/lib/mgmt/categories";
import { applyLineFixes, planLineFixes } from "@/lib/quote-line-normalize";
import { isDateKey } from "@/lib/calendar";
import { addDays, toDateKey } from "@/lib/format";
import { isOnsiteQuoteText, isSiteSurveyText, placeholderKind } from "@/lib/schedule-sheet/parse";
import { SHEET_REF_PREFIX, eventFingerprint, sheetSettings, writeSheetSettings } from "@/lib/schedule-sheet/plan";
import { applyAreaImport, planAreaImport, storeIdOfName } from "@/lib/mgmt/areas";
import { prevDay } from "@/lib/mgmt/rules";
import { POSTAL_FETCHED_AT, POSTAL_SOURCE, postalFromAddress } from "@/lib/postal/lookup";
import { areaStoreOf } from "@/lib/store-area";
import type { Database, ScheduleKind } from "@/lib/db/types";
import { DAY_LOAD_ID, dayLoadChanges, readDayLoadSettings, writeDayLoadSettings, type DayLoadSettings } from "@/lib/day-sheet";
import { DOCUMENT_SETTINGS_ID, documentSettings } from "@/lib/doc-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 運用のデータの手直し (サーバーの中から 1 回だけ実行する。ログインなし・CRON_SECRET で確かめる)
 *   task = quote-line-units: 見積の明細の単位・品目を品名・仕様からそろえる (src/lib/quote-line-normalize.ts。
 *     お客様のご要望 2026-11-23「■1」の「今日登録したものも反映」)。from・to = 見積の作成日 (日本時間の日付。to を含む)
 *   既定は確認だけ (直す内容を返す)。apply=1 で書き込み、見積ごとに変更履歴を残す
 * 例: curl -X POST -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3300/api/cron/data-fix?task=quote-line-units&from=2026-11-23&to=2026-11-23&apply=1"
 *   task = store-name: 店舗の名前・略称を変える (id・name・short。お客様のご要望 2026-11-23「本社」→「本部」。画面では 設定 → 店舗)。
 *     既定は確認だけ、apply=1 で書き込み、変更履歴を残す
 *   task = schedule-kinds (旧 schedule-onsite): 予定表 (スプレッドシート) から取り込んだ「現見」「現調」の予定を、見積りから
 *     現場見積 (現見)・現地調査 (現調) にする (お客様のご要望 2026-11-24「■2」「業務フロー ③」。種類を足す前に取り込んだ予定)。
 *     あわせて、「襖 3」だけの引き取りで備考に見積・現調とある予定 (1 件の仕事量の目安の行。お客様のご説明 2026-11-25) を見積・現調にする。
 *     from = この日以降の予定 (既定は今日)。既定は確認だけ、apply=1 で書き込み、予定ごとに変更履歴
 *   task = sales-areas: 営業エリア (住所 → 担当店舗。お客様のご要望 2026-11-24「③」。src/lib/store-area.ts) を登録する。
 *     本文 (JSON) = { rows: [{ store, town }] (予定表の「地域一覧」), manual: [{ store, town, note? }] (地域一覧にない地域), validFrom?, sourceName? }。
 *     エリアは社外秘のためコードに書かず、ここで受け取る (画面では 管理会計 → 設定 → 営業エリア)。既定は確認だけ、apply=1 で書き込み、変更履歴
 *   task = postal-codes: 郵便番号が空の顧客に、住所から郵便番号を入れる (お客様のご要望 2026-11-24「①」。src/lib/postal/lookup.ts)。
 *     住所で決まらない (町名だけ・候補が 2 つ以上) 顧客は空のまま。入力済みの郵便番号は変えない。既定は確認だけ、apply=1 で書き込み、
 *     変更履歴はまとめて 1 件 (顧客ごとには残さない。試験期間の引き継ぎでは自動で入れた郵便番号を「変わった」に数えない = carryover.ts の DERIVED_FIELDS)。
 *     本番のデータベースに切り替えたあと (12/1) に本番でもう一度実行する
 *   task = day-load: 1 日の対応可能枚数の設定 (src/lib/day-sheet.ts。画面は 予定表 → 仕事量と提案の設定 →「1 日の対応可能枚数」) の
 *     店舗ごとの対象から外す社員 (お客様のご指示 2026-11-25「合志店は現段階では 2 名を対象人数から除外」)。社員の名前はコードに書かず、
 *     本文 (JSON) = { stores: { <店舗 ID>: { excludeUserIds: [社員の ID], people?: 人数 } }, perPerson?: 枚数 } で受け取る
 *     (書いた店舗だけ置き換え、ほかの店舗・項目は今の値)。既定は確認だけ、apply=1 で書き込み、変更履歴
 *   task = doc-bank: 請求書に印字する振込先 (設定 → 帳票。お客様のご指示 2026-11-25「⑨」)。口座はコードに書かず、
 *     本文 (JSON) = { accounts: [{ bank, branch, type, number, holder, holderKana }] } で受け取り、振込先をこの内容に置き換える
 *     (帳票のほかの項目は今の値)。既定は確認だけ、apply=1 で書き込み、変更履歴
 */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const task = url.searchParams.get("task");
  if (task === "store-name") return storeName(url);
  if (task === "sales-areas") return salesAreas(url, req);
  if (task === "postal-codes") return postalCodes(url);
  if (task === "schedule-onsite" || task === "schedule-kinds") return scheduleOnsite(url);
  if (task === "day-load") return dayLoadFix(url, req);
  if (task === "doc-bank") return docBankFix(url, req);
  if (task !== "quote-line-units") return NextResponse.json({ error: "unknown task" }, { status: 400 });
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? from;
  if (!isDateKey(from) || !isDateKey(to) || to < from) return NextResponse.json({ error: "from / to (YYYY-MM-DD) が正しくありません" }, { status: 400 });
  // 日本時間の日付 → UTC の日時の範囲
  const range = { from: new Date(`${from}T00:00:00+09:00`).toISOString(), to: new Date(`${addDays(to, 1)}T00:00:00+09:00`).toISOString() };
  const apply = url.searchParams.get("apply") === "1";

  const db0 = await syncDb();
  const plan = planLineFixes(db0, range);
  if (!apply || !plan.length) return NextResponse.json({ ok: true, applied: false, range, fixes: plan });

  const applied = await mutate((db) => {
    const fixes = planLineFixes(db, range);
    const now = nowIso();
    const byQuote = applyLineFixes(db, fixes, now);
    for (const [quoteId, list] of byQuote) {
      const q = db.quotes.find((x) => x.id === quoteId)!;
      const text = list.map((f) => `${f.line}行目 ${f.name.slice(0, 20)} ${f.field === "unit" ? "単位" : "品目"} ${f.field === "unit" ? (f.before ?? "") : f.before ? categoryName(db, f.before) : "自動"} → ${f.field === "unit" ? f.after : categoryName(db, f.after)}`);
      addAudit(db, {
        userId: SYSTEM_USER,
        action: "update",
        entity: "quote",
        entityId: q.id,
        entityLabel: q.number,
        summary: `明細の単位・品目を品名からそろえました (${list.length} か所。金額は変わりません): ${text.join(" / ").slice(0, 300)}`,
        storeId: q.storeId,
        changes: [{ field: "items", before: list.map((f) => ({ line: f.line, field: f.field, value: f.before ?? "" })), after: list.map((f) => ({ line: f.line, field: f.field, value: f.after })) }],
      });
    }
    return fixes;
  });
  return NextResponse.json({ ok: true, applied: true, range, fixes: applied });
}

/** 店舗の名前・略称 (設定 → 店舗 と同じ変更。変更履歴つき) */
async function storeName(url: URL) {
  const id = url.searchParams.get("id") ?? "";
  const name = (url.searchParams.get("name") ?? "").trim().slice(0, 30);
  const short = (url.searchParams.get("short") ?? "").trim().slice(0, 10);
  const apply = url.searchParams.get("apply") === "1";
  const db0 = await syncDb();
  const s0 = db0.stores.find((s) => s.id === id);
  if (!s0) return NextResponse.json({ error: "店舗がありません" }, { status: 404 });
  if (!name || !short) return NextResponse.json({ error: "name と short を指定してください" }, { status: 400 });
  if (db0.stores.some((s) => s.id !== id && s.name === name)) return NextResponse.json({ error: "ほかの店舗と同じ名前です" }, { status: 400 });
  const plan = { id, before: { name: s0.name, shortName: s0.shortName }, after: { name, shortName: short } };
  if (!apply || (s0.name === name && s0.shortName === short)) return NextResponse.json({ ok: true, applied: false, plan });
  await mutate((db) => {
    const s = db.stores.find((x) => x.id === id)!;
    const changes = [
      ...(s.name !== name ? [{ field: "name", before: s.name, after: name }] : []),
      ...(s.shortName !== short ? [{ field: "shortName", before: s.shortName, after: short }] : []),
    ];
    s.name = name;
    s.shortName = short;
    addAudit(db, { userId: SYSTEM_USER, action: "update", entity: "store", entityId: id, entityLabel: name, summary: `店舗の名前を変更 (${plan.before.name} → ${name}・略称 ${plan.before.shortName} → ${short})`, changes });
  });
  return NextResponse.json({ ok: true, applied: true, plan, at: nowIso() });
}

/** 営業エリアの登録 (地域一覧の取込 + 手で足す地域) */
async function salesAreas(url: URL, req: Request) {
  const apply = url.searchParams.get("apply") === "1";
  const body = (await req.json().catch(() => null)) as { rows?: { store: string; town: string }[]; manual?: { store: string; town: string; note?: string }[]; validFrom?: string; sourceName?: string } | null;
  if (!body || (!body.rows?.length && !body.manual?.length)) return NextResponse.json({ error: "rows か manual を JSON で送ってください" }, { status: 400 });
  const validFrom = body.validFrom && isDateKey(body.validFrom) ? body.validFrom : toDateKey(new Date());
  const sourceName = (body.sourceName ?? "地域一覧").slice(0, 80);
  const db0 = await syncDb();
  const plan = planAreaImport(db0, (body.rows ?? []).map((r, i) => ({ store: String(r.store ?? ""), town: String(r.town ?? ""), ref: `${i + 2}行目` })));
  const manual = (body.manual ?? []).map((m) => ({ storeId: storeIdOfName(db0, String(m.store ?? "")), town: String(m.town ?? "").replace(/[\s　]/g, "").slice(0, 40), note: m.note?.slice(0, 200) }));
  const badManual = manual.filter((m) => !m.storeId || !m.town);
  if (badManual.length) return NextResponse.json({ error: "manual に店舗・地域の分からない行があります", badManual }, { status: 400 });
  const summary = { validFrom, imported: plan.rows.length, byStore: plan.byStore, problems: plan.problems, manual: manual.map((m) => `${m.town} → ${m.storeId}`), before: db0.salesAreas.length };
  if (!apply) return NextResponse.json({ ok: true, applied: false, ...summary });
  let n = 0;
  await mutate((db) => {
    const now = nowIso();
    if (plan.rows.length) n = applyAreaImport(db, plan, validFrom, SYSTEM_USER, now, () => newId("sa"), sourceName);
    for (const m of manual) {
      // 同じ地域の行は前日で閉じてから足す (履歴が残る)
      for (const a of db.salesAreas) if (a.town === m.town && (!a.validTo || a.validTo >= validFrom)) a.validTo = a.validFrom >= validFrom ? prevDay(a.validFrom) : prevDay(validFrom);
      db.salesAreas.push({ id: newId("sa"), municipality: "", town: m.town, storeId: m.storeId!, validFrom, source: "manual", note: m.note, createdBy: SYSTEM_USER, createdAt: now });
    }
    addAudit(db, { userId: SYSTEM_USER, action: "import", entity: "sales_area", entityId: "import", entityLabel: sourceName, summary: `営業エリアを登録: 地域一覧 ${n} 件・地域一覧にない地域 ${manual.length} 件 (${validFrom} から)` });
  });
  return NextResponse.json({ ok: true, applied: true, ...summary, at: nowIso() });
}

/** 郵便番号の自動設定 (住所から。空の顧客だけ) */
async function postalCodes(url: URL) {
  const apply = url.searchParams.get("apply") === "1";
  const plan = (db: Database) => {
    const fill: { id: string; postalCode: string }[] = [];
    const reasons = { filled: 0, ambiguous: 0, not_found: 0, no_address: 0, already: 0 };
    const samples: { ambiguous: string[]; not_found: string[] } = { ambiguous: [], not_found: [] };
    for (const c of db.customers) {
      if ((c.postalCode ?? "").replace(/\D/g, "")) {
        reasons.already++;
        continue;
      }
      // 候補が 2 つ以上 (同じ町名がほかの市にもある) のときは、お客様の担当店舗の営業エリアの町を選ぶ
      const r = postalFromAddress(c.address, { prefer: (h) => areaStoreOf(db, `${h.city}${h.town}`)?.storeId === c.storeId });
      if (r.ok) {
        fill.push({ id: c.id, postalCode: r.hit.postalCode });
        reasons.filled++;
      } else {
        reasons[r.reason]++;
        if (r.reason !== "no_address" && samples[r.reason].length < 20) samples[r.reason].push(`${c.code} ${(c.address ?? "").slice(0, 20)}`);
      }
    }
    return { fill, reasons, samples };
  };
  const db0 = await syncDb();
  const p0 = plan(db0);
  const summary = { source: `${POSTAL_SOURCE} (${POSTAL_FETCHED_AT})`, ...p0.reasons, samples: p0.samples };
  if (!apply || !p0.fill.length) return NextResponse.json({ ok: true, applied: false, ...summary });
  let n = 0;
  // 2,000 件ずつ書く (本番の Supabase に一度に大量の行を送らない)
  for (let i = 0; i < p0.fill.length; i += 2000) {
    const part = p0.fill.slice(i, i + 2000);
    await mutate((db) => {
      const byId = new Map(db.customers.map((c) => [c.id, c]));
      for (const f of part) {
        const c = byId.get(f.id);
        if (!c || (c.postalCode ?? "").replace(/\D/g, "")) continue;
        c.postalCode = f.postalCode;
        n++;
      }
    });
  }
  await mutate((db) => {
    addAudit(db, { userId: SYSTEM_USER, action: "import", entity: "customer", entityId: "postal-codes", entityLabel: "郵便番号の自動設定", summary: `住所から郵便番号を入れました: ${n} 件 (郵便番号が空の顧客だけ。住所で決まらない ${p0.reasons.ambiguous + p0.reasons.not_found} 件は空のまま。${POSTAL_SOURCE} ${POSTAL_FETCHED_AT})` });
  });
  return NextResponse.json({ ok: true, applied: true, written: n, ...summary, at: nowIso() });
}

/** 予定表から取り込んだ「現見」「現調」の予定 (見積りのまま) → 直す種類 */
const KIND_TITLE: Partial<Record<ScheduleKind, string>> = { onsite_quote: "現場見積", site_survey: "現地調査", survey: "見積", site: "現場管理" };
const KIND_WORD: Partial<Record<ScheduleKind, string>> = { onsite_quote: "現見", site_survey: "現調", survey: "見積", site: "現場管理" };
function kindFix(e: { source?: string; kind: string; sourceRef?: string; memo?: string }): ScheduleKind | undefined {
  if (e.source !== "import" || !e.sourceRef?.startsWith(SHEET_REF_PREFIX)) return undefined;
  // 印 = sheet:<日付>|<店舗>|<欄>|<…>|<書き込み>
  const raw = e.sourceRef.slice(SHEET_REF_PREFIX.length).split("|").slice(4).join("|");
  if (e.kind === "survey") return isOnsiteQuoteText(raw) ? "onsite_quote" : isSiteSurveyText(raw) ? "site_survey" : undefined;
  // 「襖 3」だけの引き取り (メモの 1 行目) で、備考に見積・現調・現場の言葉 → 1 件の仕事量の目安の行
  const lines = (e.memo ?? "").split("\n");
  if (e.kind === "pickup" && lines[0].trim() === "襖 張替3") return placeholderKind(raw, lines.slice(1).join(" "));
  return undefined;
}
function onsiteTargets(db: Pick<Database, "schedule">, from: string) {
  return db.schedule.filter((e) => e.date >= from && kindFix(e));
}

async function scheduleOnsite(url: URL) {
  const fromParam = url.searchParams.get("from") ?? "";
  const from = isDateKey(fromParam) ? fromParam : toDateKey(new Date());
  const apply = url.searchParams.get("apply") === "1";
  const db0 = await syncDb();
  const list = (db: Pick<Database, "schedule">) => onsiteTargets(db, from).map((e) => ({ id: e.id, date: e.date, title: e.title, kind: kindFix(e), ref: e.sourceRef }));
  const plan = list(db0);
  if (!apply || !plan.length) return NextResponse.json({ ok: true, applied: false, from, events: plan });
  const done = await mutate((db) => {
    const targets = onsiteTargets(db, from);
    const settings = sheetSettings(db);
    const now = nowIso();
    const out: { id: string; date: string; title: string; kind: string }[] = [];
    for (const e of targets) {
      const kind = kindFix(e)!;
      const before = { kind: e.kind, title: e.title };
      e.kind = kind;
      e.title = e.title.replace(/\s*(?:現地調査・見積|見積|引き取り)$/, ` ${KIND_TITLE[kind]}`);
      e.updatedAt = now;
      // 取込で書いた予定の印も新しい内容にする (次の取込で「新システムで変えた予定」と取り違えない)
      const written = settings.written ?? {};
      if (written[e.id]) written[e.id] = eventFingerprint(e);
      settings.written = written;
      addAudit(db, {
        userId: SYSTEM_USER,
        action: "update",
        entity: "schedule",
        entityId: e.id,
        entityLabel: e.title,
        summary:
          before.kind === "pickup"
            ? `予定表の「襖 3」(見積などの 1 件の仕事量の目安) の行を、引き取りから${KIND_TITLE[kind]}にしました (備考の「${KIND_WORD[kind]}」から)`
            : `予定表の「${kind === "onsite_quote" ? "現見" : "現調"}」の予定を、見積りから${kind === "onsite_quote" ? "現場見積 (現見)" : "現地調査 (現調)"}にしました (種類の追加にあわせて)`,
        storeId: e.storeId,
        changes: [
          { field: "kind", before: before.kind, after: e.kind },
          ...(before.title !== e.title ? [{ field: "title", before: before.title, after: e.title }] : []),
        ],
      });
      out.push({ id: e.id, date: e.date, title: e.title, kind });
    }
    if (targets.length) writeSheetSettings(db, settings, SYSTEM_USER);
    return out;
  });
  return NextResponse.json({ ok: true, applied: true, from, events: done });
}

/** 1 日の対応可能枚数の設定 (店舗ごとの対象から外す社員・人数) */
async function dayLoadFix(url: URL, req: Request) {
  const apply = url.searchParams.get("apply") === "1";
  const body = (await req.json().catch(() => null)) as { stores?: Record<string, { excludeUserIds?: string[]; people?: number }>; perPerson?: number } | null;
  if (!body?.stores || typeof body.stores !== "object") return NextResponse.json({ error: "stores を JSON で送ってください" }, { status: 400 });
  const db0 = await syncDb();
  const before = readDayLoadSettings(db0);
  const next: DayLoadSettings = { ...before, stores: { ...before.stores } };
  for (const [id, v] of Object.entries(body.stores)) {
    const store = db0.stores.find((s) => s.id === id);
    if (!store || store.kind === "hq") return NextResponse.json({ error: `店舗 ${id} がありません (本部は対象外)` }, { status: 400 });
    const ex = [...new Set((v.excludeUserIds ?? []).map(String))];
    const unknown = ex.filter((u) => !db0.users.some((x) => x.id === u && x.storeId === id));
    if (unknown.length) return NextResponse.json({ error: `店舗 ${id} の社員ではない ID があります`, unknown }, { status: 400 });
    const people = v.people === undefined || v.people === null ? undefined : Number(v.people);
    if (people !== undefined && !(Number.isFinite(people) && people >= 0 && people <= 99)) return NextResponse.json({ error: "people は 0〜99" }, { status: 400 });
    next.stores[id] = { excludeUserIds: ex, people };
  }
  if (body.perPerson !== undefined) {
    const n = Number(body.perPerson);
    if (!(Number.isFinite(n) && n >= 1 && n <= 99)) return NextResponse.json({ error: "perPerson は 1〜99" }, { status: 400 });
    next.perPerson = n;
  }
  const changes = dayLoadChanges(db0, before, next);
  if (!apply || !changes.length) return NextResponse.json({ ok: true, applied: false, changes });
  await mutate((db) => {
    writeDayLoadSettings(db, next, SYSTEM_USER, nowIso());
    addAudit(db, { userId: SYSTEM_USER, action: "update", entity: "settings", entityId: DAY_LOAD_ID, entityLabel: "1 日の対応可能枚数", summary: `1 日の対応可能枚数の設定を変更 (${changes.length} 項目。お客様のご指示)`, changes });
  });
  return NextResponse.json({ ok: true, applied: true, changes, at: nowIso() });
}

/** 請求書の振込先 (設定 → 帳票の bankAccounts) を本文の内容に置き換える */
async function docBankFix(url: URL, req: Request) {
  const apply = url.searchParams.get("apply") === "1";
  const body = (await req.json().catch(() => null)) as { accounts?: Record<string, unknown>[] } | null;
  if (!Array.isArray(body?.accounts) || !body.accounts.length || body.accounts.length > 3) return NextResponse.json({ error: "accounts (1〜3 件) を JSON で送ってください" }, { status: 400 });
  const txt = (v: unknown, max: number) => (typeof v === "string" ? v.normalize("NFKC").trim().slice(0, max) : "");
  // 口座名義のカナはお客様の書いたとおり (「カ）」の全角の括弧を半角にしない)
  const raw = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const accounts = body.accounts.map((a) => ({ bank: txt(a.bank, 60), branch: txt(a.branch, 60), type: txt(a.type, 10) || "普通", number: txt(a.number, 20), holder: txt(a.holder, 80), ...(raw(a.holderKana, 80) ? { holderKana: raw(a.holderKana, 80) } : {}) }));
  if (accounts.some((a) => !a.bank || !a.number || !a.holder)) return NextResponse.json({ error: "銀行名・口座番号・口座名義は必須です" }, { status: 400 });
  const db0 = await syncDb();
  const before = documentSettings(db0).bankAccounts;
  const changed = JSON.stringify(before) !== JSON.stringify(accounts);
  if (!apply || !changed) return NextResponse.json({ ok: true, applied: false, changed, before: before.length, after: accounts.length });
  await mutate((db) => {
    const now = nowIso();
    const row = db.settings.find((s) => s.id === DOCUMENT_SETTINGS_ID);
    if (row) row.value = { ...(row.value ?? {}), bankAccounts: accounts };
    else db.settings.push({ id: DOCUMENT_SETTINGS_ID, value: { ...documentSettings(db), bankAccounts: accounts }, updatedBy: SYSTEM_USER, updatedAt: now });
    if (row) Object.assign(row, { updatedBy: SYSTEM_USER, updatedAt: now });
    addAudit(db, { userId: SYSTEM_USER, action: "update", entity: "settings", entityId: DOCUMENT_SETTINGS_ID, entityLabel: "帳票の会社情報", summary: `請求書の振込先を登録 (${accounts.length} 件。お客様のご指示)` });
  });
  return NextResponse.json({ ok: true, applied: true, accounts: accounts.length, at: nowIso() });
}
