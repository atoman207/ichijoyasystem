"use client";

import { useState } from "react";
import { Plus, Trash } from "lucide-react";
import type { CustomerContact } from "@/lib/db/types";
import { CONTACT_RELATIONS } from "@/lib/customer-contacts";

/**
 * 顧客の連絡先 (本人以外の電話番号) の入力。夫・姉・祖母・勤務先など、続柄つきで複数登録する。
 * 送信は hidden の JSON (name="contacts")。保存は src/lib/actions/customers.ts (parseContacts)
 */

interface Row {
  key: string;
  id?: string;
  relation: string;
  name: string;
  phone: string;
  note: string;
}

let seq = 0;
const nextKey = () => `k${Date.now().toString(36)}_${seq++}`;

export function ContactsEditor({ initial = [] }: { initial?: CustomerContact[] }) {
  const [rows, setRows] = useState<Row[]>(() => initial.map((c) => ({ key: nextKey(), id: c.id, relation: c.relation, name: c.name ?? "", phone: c.phone, note: c.note ?? "" })));
  const update = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const payload = JSON.stringify(rows.map(({ id, relation, name, phone, note }) => ({ id, relation, name, phone, note })));

  return (
    <div>
      <input type="hidden" name="contacts" value={payload} />
      <datalist id="contact-relations">
        {CONTACT_RELATIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.key} className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-subtle/40 p-2 @xl:grid-cols-[8rem_1fr_10rem_1fr_auto]">
              <input className="field h-9 text-sm" list="contact-relations" value={r.relation} onChange={(e) => update(r.key, { relation: e.target.value })} placeholder="続柄 (例: 夫)" aria-label="続柄" />
              <input className="field h-9 text-sm" value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} placeholder="名前 (任意)" aria-label="名前" />
              <input className="field h-9 text-sm tnum" type="tel" value={r.phone} onChange={(e) => update(r.key, { phone: e.target.value })} placeholder="090-0000-0000" aria-label="電話番号" />
              <input className="field h-9 text-sm" value={r.note} onChange={(e) => update(r.key, { note: e.target.value })} placeholder="メモ (例: 平日は夕方以降)" aria-label="メモ" />
              <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="grid h-9 w-9 place-items-center justify-self-end rounded-lg text-ink-3 hover:bg-critical-soft hover:text-critical" aria-label="この連絡先を削除" title="削除">
                <Trash className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setRows((rs) => [...rs, { key: nextKey(), relation: "", name: "", phone: "", note: "" }])}
        className="mt-2 inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-subtle"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden /> 連絡先を追加
      </button>
    </div>
  );
}
