import "server-only";
import type { Database, PurchaseOrder, User } from "@/lib/db/types";
import { canAccessStore, canSeeAllStores } from "@/lib/auth/permissions";
import { CATEGORY_LABEL } from "@/lib/constants";
import { defaultDelivery } from "@/lib/purchase-orders";
import { orderOption } from "@/lib/purchase-order-options";
import { fmtFax } from "@/lib/fax/numbers";
import { toDateKey } from "@/lib/format";
import type { EditorInitial } from "./PurchaseOrderEditor";

/** 発注書の作成・編集の画面に渡すデータ (仕入先・商品マスタ・店舗・案件・初期値) */
export function editorData(db: Database, user: User, opts: { po?: PurchaseOrder; orderIds?: string[]; supplierId?: string }) {
  const { po } = opts;
  const storeId = po?.storeId ?? db.orders.find((o) => o.id === opts.orderIds?.[0])?.storeId ?? user.storeId;
  const safeStore = canAccessStore(user, storeId) ? storeId : user.storeId;
  const delivery = defaultDelivery(db, safeStore);
  const orderIds = po ? po.orderIds : (opts.orderIds ?? []);
  const orders = orderIds
    .map((id) => db.orders.find((o) => o.id === id))
    .filter((o): o is NonNullable<typeof o> => Boolean(o) && canAccessStore(user, o!.storeId))
    .map((o) => orderOption(db, o));
  const initial: EditorInitial = po
    ? {
        supplierId: po.supplierId,
        storeId: po.storeId,
        issuedOn: po.issuedOn,
        desiredDate: po.desiredDate ?? "",
        deliveryPlace: po.deliveryPlace,
        deliveryAddress: po.deliveryAddress ?? "",
        faxTo: po.faxTo ? fmtFax(po.faxTo) : "",
        notes: po.notes ?? "",
        showCustomer: Boolean(po.showCustomer),
        lines: po.lines.map((l) => ({ ...l, qty: String(l.qty), unitPrice: typeof l.unitPrice === "number" ? String(l.unitPrice) : "" })),
      }
    : {
        supplierId: opts.supplierId && db.suppliers.some((s) => s.id === opts.supplierId) ? opts.supplierId : "",
        storeId: safeStore,
        issuedOn: toDateKey(new Date()),
        desiredDate: "",
        deliveryPlace: delivery.place,
        deliveryAddress: delivery.address,
        faxTo: "",
        notes: "",
        showCustomer: false,
        lines: [],
      };
  const stores = db.stores
    .filter((s) => canSeeAllStores(user) || s.id === user.storeId)
    .map((s) => ({ id: s.id, name: s.name, ...(({ place, address }) => ({ place, address }))(defaultDelivery(db, s.id)) }));
  return {
    initial,
    orders,
    stores,
    canChooseStore: canSeeAllStores(user),
    suppliers: db.suppliers
      .filter((s) => s.active !== false || s.id === po?.supplierId)
      .sort((a, b) => Number(a.kind === "partner") - Number(b.kind === "partner") || a.name.localeCompare(b.name, "ja"))
      .map((s) => ({ id: s.id, name: s.name, fax: fmtFax(s.fax), kind: s.kind ?? "supplier", active: s.active !== false })),
    products: db.products
      .filter((p) => p.active)
      .map((p) => ({ id: p.id, label: `${CATEGORY_LABEL[p.category]} · ${p.name}${p.grade ? ` ${p.grade}` : ""}${p.sizeLabel ? ` (${p.sizeLabel})` : ""}`, name: p.name, spec: [p.grade, p.sizeLabel].filter(Boolean).join(" "), unit: p.unit, price: p.unitPrice })),
  };
}
