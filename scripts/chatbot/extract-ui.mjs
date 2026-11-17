#!/usr/bin/env node
/**
 * チャットボットの資料用に、各画面の表示 (カードの見出し・説明・入力欄・ボタン・注意書き) を抜き出す
 * ------------------------------------------------------------
 * src/app/(app)/**\/page.tsx と、そこから読み込んでいる src/components の部品 (2 段まで) の日本語の表示を集め、
 * src/lib/chatbot/ui-catalog.json に書く (本番のサーバーにはソースがないため、ファイルにしてコミットする)。
 * 画面を変えたら `npm run chatbot:catalog` で作り直す (npm run build の前にも自動で実行)
 *
 *   node scripts/chatbot/extract-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APP = path.join(ROOT, "src/app/(app)");
const OUT = path.join(ROOT, "src/lib/chatbot/ui-catalog.json");
const JA = /[぀-ヿ㐀-鿿]/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "page.tsx") out.push(p);
  }
  return out;
}

const clean = (s) =>
  s
    .replace(/\$\{[^}]*\}/g, "…")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return undefined;
  for (const ext of [".tsx", "/index.tsx"]) if (fs.existsSync(base + ext)) return base + ext;
  return undefined;
}

/** 表示の部品 (src/components/ui・layout・charts・brand は共通部品なので除く) */
function componentImports(file, src) {
  const out = [];
  for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
    const spec = m[1];
    if (!/^(@\/components\/|\.)/.test(spec) || /components\/(ui|layout|charts|brand|chatbot)\b/.test(spec)) continue;
    const r = resolveImport(file, spec);
    if (r) out.push(r);
  }
  return out;
}

function extract(src) {
  const cards = [];
  const fields = new Set();
  const buttons = new Set();
  const notes = new Set();
  let header;
  const ph = src.match(/<PageHeader[^>]*?\btitle=(?:"([^"]+)"|\{`([^`]+)`\})/);
  if (ph) header = clean(ph[1] ?? ph[2]);
  for (const m of src.matchAll(/<CardHeader\b([\s\S]*?)\/>/g)) {
    const attrs = m[1];
    const t = attrs.match(/\btitle=(?:"([^"]+)"|\{`([^`]+)`\})/);
    const d = attrs.match(/\bdescription=(?:"([^"]+)"|\{`([^`]+)`\})/);
    const title = t ? clean(t[1] ?? t[2]) : "";
    const desc = d ? clean(d[1] ?? d[2]) : "";
    if ((title && JA.test(title)) || (desc && JA.test(desc))) cards.push(desc ? `「${title}」: ${desc}` : `「${title}」`);
  }
  for (const m of src.matchAll(/<Field\b[^>]*?\blabel=(?:"([^"]+)"|\{`([^`]+)`\})(?:[^>]*?\bhint=(?:"([^"]+)"|\{`([^`]+)`\}))?/g)) {
    const label = clean(m[1] ?? m[2]);
    const hint = m[3] ?? m[4] ? clean(m[3] ?? m[4]) : "";
    if (JA.test(label)) fields.add(hint ? `${label} (${hint})` : label);
  }
  for (const m of src.matchAll(/<(Button|LinkButton|button|SubmitButton|ConfirmButton)\b[^>]*>([^<]{1,80})<\/\1>/g)) {
    const t = clean(m[2]);
    if (t.length >= 2 && JA.test(t)) buttons.add(t);
  }
  for (const m of src.matchAll(/<(Note|Hint)\b[^>]*>([\s\S]{1,600}?)<\/\1>/g)) {
    const t = clean(m[2].replace(/<[^>]+>/g, " "));
    if (t.length >= 6 && JA.test(t)) notes.add(t);
  }
  return { header, cards, fields: [...fields], buttons: [...buttons], notes: [...notes] };
}

const routeOf = (file) => {
  const rel = path.relative(APP, path.dirname(file)).split(path.sep).join("/");
  return rel ? `/${rel}` : "/";
};

const pages = walk(APP).sort();
const catalog = [];
for (const file of pages) {
  const src = fs.readFileSync(file, "utf8");
  const parts = [extract(src)];
  const seen = new Set([file]);
  let queue = componentImports(file, src);
  for (let depth = 0; depth < 2 && queue.length; depth++) {
    const next = [];
    for (const c of queue) {
      if (seen.has(c)) continue;
      seen.add(c);
      const csrc = fs.readFileSync(c, "utf8");
      parts.push(extract(csrc));
      next.push(...componentImports(c, csrc));
    }
    queue = next;
  }
  const merge = (k) => [...new Set(parts.flatMap((p) => p[k]))];
  const entry = { route: routeOf(file), title: parts[0].header ?? "", cards: merge("cards"), fields: merge("fields"), buttons: merge("buttons"), notes: merge("notes") };
  if (entry.cards.length + entry.fields.length + entry.buttons.length + entry.notes.length > 0) catalog.push(entry);
}

fs.writeFileSync(OUT, `${JSON.stringify(catalog, null, 1)}\n`);
console.log(`[chatbot] ui-catalog: ${catalog.length} 画面 → ${path.relative(ROOT, OUT)}`);
