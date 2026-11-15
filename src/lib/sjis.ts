/**
 * Shift_JIS への変換 (会計ソフトの取込用 CSV。弥生会計などは Shift_JIS のファイルを取り込む)
 * ------------------------------------------------------------
 * 追加のライブラリを使わず、Node の TextDecoder("shift_jis") で 2 バイトの文字の対応表を作って逆引きする。
 * - Windows で入力される文字 (～ − ∥ など) と Mac で入力される文字 (〜 − ‖) のどちらも同じ文字に変換する
 * - Shift_JIS にない文字 (絵文字・一部の旧字体など) は「?」にする
 */

let table: Map<number, number[]> | null = null;

function build(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const dec = new TextDecoder("shift_jis");
  // 半角カナ
  for (let b = 0xa1; b <= 0xdf; b++) map.set(0xff61 + (b - 0xa1), [b]);
  const leads: number[] = [];
  for (let l = 0x81; l <= 0x9f; l++) leads.push(l);
  // 0xED・0xEE (NEC 選定 IBM 拡張) は 0xFA・0xFB (IBM 拡張) と同じ文字のため後回しにし、0xF0〜0xF9 (外字) は使わない
  for (let l = 0xe0; l <= 0xfc; l++) if (l !== 0xed && l !== 0xee && (l < 0xf0 || l > 0xf9)) leads.push(l);
  leads.push(0xed, 0xee);
  for (const l of leads) {
    for (let t = 0x40; t <= 0xfc; t++) {
      if (t === 0x7f) continue;
      const s = dec.decode(new Uint8Array([l, t]));
      if (s.length !== 1 || s === "�") continue;
      const cp = s.codePointAt(0)!;
      if (!map.has(cp)) map.set(cp, [l, t]);
    }
  }
  // 環境によって入力される文字が違う記号をそろえる (どちらか一方しか対応表にないときは、もう一方も同じバイトにする)
  const alias: [number, number][] = [
    [0xff5e, 0x301c], // ～ 〜
    [0x2212, 0xff0d], // − －
    [0x2016, 0x2225], // ‖ ∥
    [0x00a2, 0xffe0], // ¢
    [0x00a3, 0xffe1], // £
    [0x00ac, 0xffe2], // ¬
    [0x2014, 0x2015], // — ―
    [0x00a5, 0x005c], // ¥ (円記号) → 0x5C
  ];
  for (const [a, b] of alias) {
    if (!map.has(a) && map.has(b)) map.set(a, map.get(b)!);
    else if (!map.has(b) && map.has(a)) map.set(b, map.get(a)!);
  }
  if (!map.has(0x00a5)) map.set(0x00a5, [0x5c]);
  return map;
}

export function encodeShiftJis(text: string): Uint8Array {
  table ??= build();
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else {
      const b = table.get(cp);
      if (b) out.push(...b);
      else out.push(0x3f);
    }
  }
  return Uint8Array.from(out);
}
