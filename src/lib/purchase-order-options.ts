import type { Database, Order } from "@/lib/db/types";

/**
 * 発注書の作成画面 (ブラウザ) に渡す案件 (受注) の情報。見積の明細から品目を選べるようにする
 * (社内の画面なので、お客様の名前も出す。発注書の PDF に載せるかは showCustomer で決める)
 */
export interface OrderOption {
  id: string;
  number: string;
  title: string;
  customerName: string;
  storeId: string;
  storeName: string;
  scheduledStart?: string;
  /** 現場の住所 (現場直送の納品先に使う) */
  siteAddress: string;
  status: string;
  items: { name: string; spec?: string; qty: number; unit: string; productId?: string }[];
}

export function orderOption(db: Database, o: Order): OrderOption {
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  return {
    id: o.id,
    number: o.number,
    title: o.title,
    customerName: db.customers.find((c) => c.id === o.customerId)?.name ?? "",
    storeId: o.storeId,
    storeName: db.stores.find((s) => s.id === o.storeId)?.name ?? "",
    scheduledStart: o.scheduledStart,
    siteAddress: o.siteAddress ?? "",
    status: o.status,
    items: (q?.items ?? []).filter((i) => i.qty > 0 && !/諸経費|値引|出張|運搬/.test(i.name)).map((i) => ({ name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, productId: i.productId })),
  };
}
