"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ListPlus, Plus, Search, Trash2, X } from "lucide-react";
import { buttonClass } from "@/components/ui";
import type { OrderOption } from "@/lib/purchase-order-options";

/**
 * 発注書の作成・編集 (/purchase-orders/new・/purchase-orders/<ID>/edit)
 * - 仕入先・送信先 FAX・発注元の店舗・発注日・希望納期・納品先・備考
 * - 案件 (受注) を複数加え、見積の明細・商品マスタ・手入力で明細を作る (1 枚に別の案件の明細を混ぜられる)
 * 明細は JSON (hidden の lines) でサーバーへ送り、サーバー (src/lib/purchase-orders.ts の parseLines) で検証する
 */

export interface EditorLine {
  id?: string;
  orderId?: string;
  productId?: string;
  name: string;
  code?: string;
  spec?: string;
  qty: string;
  unit: string;
  dueDate?: string;
  notes?: string;
  unitPrice?: string;
}

export interface EditorInitial {
  supplierId: string;
  storeId: string;
  issuedOn: string;
  desiredDate: string;
  deliveryPlace: string;
  deliveryAddress: string;
  faxTo: string;
  notes: string;
  showCustomer: boolean;
  lines: EditorLine[];
}

interface Props {
  action: (formData: FormData) => void | Promise<void>;
  initial: EditorInitial;
  suppliers: { id: string; name: string; fax: string; kind: string; active: boolean }[];
  products: { id: string; label: string; name: string; spec: string; unit: string; price: number }[];
  stores: { id: string; name: string; place: string; address: string }[];
  canChooseStore: boolean;
  orders: OrderOption[];
  /** 送信済みの発注書 (直すと版が上がる・仕入先は変えられない) */
  sentLocked: boolean;
}

let seq = 0;
const tmpId = () => `new-${Date.now().toString(36)}-${(seq += 1)}`;
const blank = (orderId?: string): EditorLine => ({ id: tmpId(), orderId, name: "", qty: "1", unit: "枚" });

export function PurchaseOrderEditor({ action, initial, suppliers, products, stores, canChooseStore, orders: initialOrders, sentLocked }: Props) {
  const [supplierId, setSupplierId] = useState(initial.supplierId);
  const [storeId, setStoreId] = useState(initial.storeId);
  const [place, setPlace] = useState(initial.deliveryPlace);
  const [address, setAddress] = useState(initial.deliveryAddress);
  const [lines, setLines] = useState<EditorLine[]>(initial.lines.length ? initial.lines.map((l) => ({ ...l, id: l.id ?? tmpId() })) : [blank(initialOrders[0]?.id)]);
  const [orders, setOrders] = useState(initialOrders);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<OrderOption[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchSeq = useRef(0);
  const supplier = suppliers.find((s) => s.id === supplierId);
  const json = useMemo(() => JSON.stringify(lines.map(({ id, ...rest }) => ({ id: id?.startsWith("new-") ? undefined : id, ...rest }))), [lines]);

  const update = (i: number, patch: Partial<EditorLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, d: -1 | 1) =>
    setLines((ls) => {
      const j = i + d;
      if (j < 0 || j >= ls.length) return ls;
      const next = [...ls];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const addItems = (o: OrderOption, items: OrderOption["items"]) =>
    setLines((ls) => [...ls.filter((l) => l.name.trim()), ...items.map((it) => ({ id: tmpId(), orderId: o.id, productId: it.productId, name: it.name, spec: it.spec, qty: String(it.qty), unit: it.unit }))]);

  async function search() {
    const term = q.trim();
    if (term.length < 2) {
      setSearchError("2 文字以上で検索してください (受注番号・お客様・件名)");
      return;
    }
    const my = (searchSeq.current += 1);
    setSearching(true);
    setSearchError("");
    try {
      const res = await fetch(`/api/orders/lookup?q=${encodeURIComponent(term)}`, { cache: "no-store" });
      const data = (await res.json()) as { orders?: OrderOption[]; error?: string };
      if (my !== searchSeq.current) return;
      if (!res.ok) setSearchError(data.error ?? "検索できませんでした");
      setHits(data.orders ?? []);
    } catch {
      if (my === searchSeq.current) setSearchError("検索できませんでした。通信状況を確認してください");
    } finally {
      if (my === searchSeq.current) setSearching(false);
    }
  }

  function addOrder(o: OrderOption & { siteAddress: string }) {
    setOrders((os) => (os.some((x) => x.id === o.id) ? os : [...os, o]));
    setHits(null);
    setQ("");
  }

  const removeOrder = (id: string) => {
    setOrders((os) => os.filter((o) => o.id !== id));
    setLines((ls) => ls.map((l) => (l.orderId === id ? { ...l, orderId: undefined } : l)));
  };

  const storeOf = stores.find((s) => s.id === storeId);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="lines" value={json} />
      <section className="rounded-2xl border border-line/70 bg-panel p-5 shadow-card">
        <h2 className="mb-3 text-[15px] font-semibold text-ink">発注先と納品先</h2>
        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
          <label className="block">
            <span className="label">仕入先<span className="ml-1 text-critical">*</span></span>
            <select name="supplierId" className="field" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required disabled={sentLocked}>
              <option value="">選んでください</option>
              {suppliers.filter((s) => s.active || s.id === initial.supplierId).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.kind === "partner" ? "[協力業者] " : ""}{s.name}{s.fax ? ` (FAX ${s.fax})` : " (FAX 未登録)"}
                </option>
              ))}
            </select>
            {sentLocked && <input type="hidden" name="supplierId" value={supplierId} />}
            <span className="mt-1 block text-[11px] text-ink-3">{sentLocked ? "送信した発注書は仕入先を変えられません (複製して新しく作ります)" : "一覧にない仕入先は「仕入先・協力業者」で登録します"}</span>
          </label>
          <label className="block">
            <span className="label">送信先の FAX 番号</span>
            <input name="faxTo" className="field" inputMode="tel" defaultValue={initial.faxTo} placeholder={supplier?.fax ? `${supplier.fax} (仕入先の FAX)` : "例: 096-123-4567"} />
            <span className="mt-1 block text-[11px] text-ink-3">空欄のときは仕入先の FAX 番号に送ります。送信の前にもう一度確認します</span>
          </label>
          {canChooseStore && (
            <label className="block">
              <span className="label">発注元の店舗</span>
              <select name="storeId" className="field" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span className="mt-1 block text-[11px] text-ink-3">発注書を見られる範囲 (店舗のロール) と、発注書に載せる担当店舗</span>
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">発注日</span>
              <input type="date" name="issuedOn" className="field" defaultValue={initial.issuedOn} required />
            </label>
            <label className="block">
              <span className="label">着日 (全体の希望)</span>
              <input type="date" name="desiredDate" className="field" defaultValue={initial.desiredDate} />
            </label>
          </div>
          <label className="block">
            <span className="label">納品先<span className="ml-1 text-critical">*</span></span>
            <input name="deliveryPlace" className="field" value={place} onChange={(e) => setPlace(e.target.value)} required maxLength={100} />
          </label>
          <label className="block">
            <span className="label">納品先の住所</span>
            <input name="deliveryAddress" className="field" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          {storeOf && (
            <button type="button" className="rounded-full border border-line px-2.5 py-1 text-ink-2 hover:bg-subtle" onClick={() => { setPlace(storeOf.place); setAddress(storeOf.address); }}>
              発注元の店舗にする
            </button>
          )}
          {orders.filter((o) => o.siteAddress).map((o) => (
            <button key={o.id} type="button" className="rounded-full border border-line px-2.5 py-1 text-ink-2 hover:bg-subtle" onClick={() => { setPlace(`現場直送 (${o.number})`); setAddress(o.siteAddress); }}>
              {o.number} の現場へ直送
            </button>
          ))}
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm text-ink-2">
          <input type="checkbox" name="showCustomer" defaultChecked={initial.showCustomer} className="mt-1" />
          <span>
            お客様の氏名・住所・電話番号を発注書に載せる
            <span className="block text-[11px] text-ink-3">現場直送で仕入先が直接連絡する場合など、必要なときだけ。既定では現場名に「名字 様」と案件番号だけを載せます</span>
          </span>
        </label>
      </section>

      <section className="rounded-2xl border border-line/70 bg-panel p-5 shadow-card">
        <h2 className="mb-1 text-[15px] font-semibold text-ink">案件 (受注)</h2>
        <p className="mb-3 text-xs text-ink-3">同じ仕入先へ、複数の案件の材料をまとめて発注できます。案件を加えると、見積の明細から品目を選べます</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-0 flex-1">
            <span className="label">案件を探す</span>
            <input
              className="field"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void search();
                }
              }}
              placeholder="受注番号・お客様の名前・件名"
              aria-label="案件を探す"
            />
          </label>
          <button type="button" onClick={() => void search()} className={buttonClass("secondary", "md")} disabled={searching}>
            <Search className="h-4 w-4" aria-hidden /> {searching ? "検索中…" : "検索"}
          </button>
        </div>
        {searchError && <p className="mt-2 text-xs text-critical-ink">{searchError}</p>}
        {hits && (
          <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-line">
            {hits.length === 0 && <p className="p-3 text-xs text-ink-3">見つかりませんでした</p>}
            {hits.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-3 py-2 last:border-0">
                <div className="min-w-0 text-sm">
                  <span className="font-mono text-xs">{o.number}</span> {o.customerName} 様 · {o.title}
                  <span className="ml-1 text-xs text-ink-3">{o.storeName}{o.scheduledStart ? ` · 施工 ${o.scheduledStart}` : ""}</span>
                </div>
                <button type="button" onClick={() => addOrder(o)} disabled={orders.some((x) => x.id === o.id)} className={buttonClass("soft", "sm")}>
                  {orders.some((x) => x.id === o.id) ? "追加済み" : "追加"}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 space-y-3">
          {orders.length === 0 && <p className="text-xs text-ink-3">案件はまだありません (在庫の補充など、案件のない発注もできます)</p>}
          {orders.map((o) => (
            <div key={o.id} className="rounded-xl border border-line bg-subtle/40 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <span className="font-mono text-xs font-semibold">{o.number}</span> {o.customerName} 様 · {o.title}
                  <div className="text-xs text-ink-3">{o.storeName}{o.scheduledStart ? ` · 施工予定 ${o.scheduledStart}` : " · 施工日未定"}</div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => setLines((ls) => [...ls.filter((l) => l.name.trim()), blank(o.id)])} className={buttonClass("ghost", "sm")}>
                    <Plus className="h-3.5 w-3.5" aria-hidden /> 行を追加
                  </button>
                  {o.items.length > 0 && (
                    <button type="button" onClick={() => addItems(o, o.items)} className={buttonClass("soft", "sm")}>
                      <ListPlus className="h-3.5 w-3.5" aria-hidden /> 見積の明細をすべて追加
                    </button>
                  )}
                  <button type="button" onClick={() => removeOrder(o.id)} className={buttonClass("ghost", "sm")} aria-label={`${o.number} を外す`}>
                    <X className="h-3.5 w-3.5" aria-hidden /> 外す
                  </button>
                </div>
              </div>
              {o.items.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {o.items.map((it, k) => (
                    <button key={k} type="button" onClick={() => addItems(o, [it])} className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-ink-2 hover:border-accent hover:text-accent">
                      + {it.name}{it.spec ? ` (${it.spec})` : ""} {it.qty}{it.unit}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-line/70 bg-panel p-5 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ink">明細 <span className="text-sm font-normal text-ink-3">{lines.filter((l) => l.name.trim()).length} 行</span></h2>
          <button type="button" onClick={() => setLines((ls) => [...ls, blank(orders.length === 1 ? orders[0].id : undefined)])} className={buttonClass("secondary", "sm")}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> 行を追加
          </button>
        </div>
        <div className="space-y-3">
          {lines.map((l, i) => (
            <div key={l.id} className="rounded-xl border border-line p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-ink-2">{i + 1} 行目</span>
                <div className="flex gap-1">
                  <button type="button" onClick={() => move(i, -1)} className={buttonClass("ghost", "sm")} aria-label="上へ" disabled={i === 0}><ArrowUp className="h-3.5 w-3.5" aria-hidden /></button>
                  <button type="button" onClick={() => move(i, 1)} className={buttonClass("ghost", "sm")} aria-label="下へ" disabled={i === lines.length - 1}><ArrowDown className="h-3.5 w-3.5" aria-hidden /></button>
                  <button type="button" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [blank()]))} className={buttonClass("ghost", "sm")} aria-label={`${i + 1} 行目を削除`}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-6">
                <label className="col-span-2 block @3xl:col-span-2">
                  <span className="label">案件</span>
                  <select className="field" value={l.orderId ?? ""} onChange={(e) => update(i, { orderId: e.target.value || undefined })}>
                    <option value="">(案件なし)</option>
                    {orders.map((o) => <option key={o.id} value={o.id}>{o.number} {o.customerName} 様</option>)}
                  </select>
                </label>
                <label className="col-span-2 block @3xl:col-span-4">
                  <span className="label">商品マスタから選ぶ</span>
                  <select
                    className="field"
                    value={l.productId ?? ""}
                    onChange={(e) => {
                      const p = products.find((x) => x.id === e.target.value);
                      update(i, p ? { productId: p.id, name: p.name, spec: p.spec || l.spec, unit: p.unit } : { productId: undefined });
                    }}
                  >
                    <option value="">(手入力)</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </label>
                <label className="col-span-2 block @3xl:col-span-3">
                  <span className="label">商品名<span className="ml-1 text-critical">*</span></span>
                  <input className="field" value={l.name} onChange={(e) => update(i, { name: e.target.value })} maxLength={120} />
                </label>
                <label className="block">
                  <span className="label">品番</span>
                  <input className="field" value={l.code ?? ""} onChange={(e) => update(i, { code: e.target.value })} maxLength={60} />
                </label>
                <label className="col-span-1 block @3xl:col-span-2">
                  <span className="label">仕様 (等級・サイズ・色)</span>
                  <input className="field" value={l.spec ?? ""} onChange={(e) => update(i, { spec: e.target.value })} maxLength={200} />
                </label>
                <label className="block">
                  <span className="label">数量<span className="ml-1 text-critical">*</span></span>
                  <input className="field text-right" inputMode="decimal" value={l.qty} onChange={(e) => update(i, { qty: e.target.value })} />
                </label>
                <label className="block">
                  <span className="label">単位</span>
                  <input className="field" value={l.unit} onChange={(e) => update(i, { unit: e.target.value })} maxLength={10} />
                </label>
                <label className="block">
                  <span className="label">着日</span>
                  <input type="date" className="field" value={l.dueDate ?? ""} onChange={(e) => update(i, { dueDate: e.target.value })} />
                </label>
                <label className="block">
                  <span className="label">単価 (任意)</span>
                  <input className="field text-right" inputMode="numeric" value={l.unitPrice ?? ""} onChange={(e) => update(i, { unitPrice: e.target.value })} placeholder="空欄可" />
                </label>
                <label className="col-span-2 block @3xl:col-span-2">
                  <span className="label">備考</span>
                  <input className="field" value={l.notes ?? ""} onChange={(e) => update(i, { notes: e.target.value })} maxLength={200} />
                </label>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-ink-3">発注書の表は「品名・数量・現場名・着日・備考」です (品番・仕様は品名の下、案件番号は現場名の下に載ります)。単価を入れた行は備考に単価を載せます。着日が空の行は全体の希望の着日を載せます。商品名が空の行は保存しません</p>
      </section>

      <section className="rounded-2xl border border-line/70 bg-panel p-5 shadow-card">
        <label className="block">
          <span className="label">備考 (発注書に載せます)</span>
          <textarea name="notes" className="field min-h-[88px]" defaultValue={initial.notes} maxLength={2000} placeholder="例: 午前中の納品をお願いします。在庫がない場合はご連絡ください" />
        </label>
      </section>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        <button type="submit" name="intent" value="draft" className={buttonClass("secondary", "md")}>下書きで保存</button>
        <button type="submit" name="intent" value="issue" className={buttonClass("primary", "md")}>保存して発行 (送信へ)</button>
      </div>
    </form>
  );
}
