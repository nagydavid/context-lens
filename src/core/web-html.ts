/**
 * Bounded, zero-dependency HTML-to-text converter for documentation pages.
 *
 * A hand-rolled tokenizer feeds an explicit-stack state machine (no recursion, no whole-document
 * regex conversion). Page chrome is dropped, the main content root is preferred, and the output is
 * deterministic, line-oriented lightweight markdown so line ranges stay meaningful.
 */

export interface HtmlToTextOptions {
  baseUrl?: URL;
  maxDepth?: number;
  maxTokens?: number;
  wrapWidth?: number;
}

export interface HtmlToTextResult {
  title: string;
  text: string;
  truncated: boolean;
}

const MAX_ATTRS = 64;
const RAW_TEXT = new Set(["script", "style", "noscript", "template", "svg", "iframe", "canvas", "textarea", "title"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const DROP = new Set(["nav", "aside", "footer", "form", "button", "select", "dialog", "head"]);
const CHROME_TOKENS = new Set(["sidebar", "navbar", "nav", "toc", "breadcrumb", "cookie", "banner", "skip", "footer"]);
const GUTTER_TOKENS = new Set(["linenos", "lineno", "linenodiv"]);
const PARA = new Set(["p", "table", "dl", "h1", "h2", "h3", "h4", "h5", "h6"]);
const SEP = new Set(["div", "section", "article", "main", "li", "dt", "dd", "figure", "figcaption", "details", "summary", "address", "tr", "thead", "tbody", "tfoot", "hr", "br"]);

const NAMED = new Map<string, string>(Object.entries({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", times: "×", divide: "÷", middot: "·", bull: "•", deg: "°",
  euro: "€", pound: "£", yen: "¥", sect: "§", para: "¶",
}));

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#([xX][0-9a-fA-F]{1,8}|\d{1,10})|([a-zA-Z][a-zA-Z0-9]{1,8}));?/g, (m, num: string | undefined, name: string | undefined) => {
    if (num !== undefined) {
      const cp = num[0] === "x" || num[0] === "X" ? parseInt(num.slice(1), 16) : parseInt(num, 10);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
      return String.fromCodePoint(cp);
    }
    if (name !== undefined && m.endsWith(";")) return NAMED.get(name) ?? m;
    return m;
  });
}

type Tok =
  | { k: "text"; text: string }
  | { k: "close"; name: string }
  | { k: "open"; name: string; attrs: Map<string, string>; self: boolean };

const isWs = (c: string | undefined): boolean => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
const isAlpha = (c: string | undefined): boolean => c !== undefined && /[a-zA-Z]/.test(c);

interface ParsedTag { end: number; name: string; attrs: Map<string, string>; self: boolean; closing: boolean }

/** Returns null when the input ends inside the tag (unterminated). */
function parseTag(s: string, lt: number): ParsedTag | null {
  const n = s.length;
  let j = lt + 1;
  const closing = s[j] === "/";
  if (closing) j++;
  const ns = j;
  while (j < n && !isWs(s[j]) && s[j] !== "/" && s[j] !== ">") j++;
  const name = s.slice(ns, j).toLowerCase();
  const attrs = new Map<string, string>();
  let self = false;
  for (;;) {
    while (j < n && (isWs(s[j]) || s[j] === "/")) {
      if (s[j] === "/" && s[j + 1] === ">") self = true;
      j++;
    }
    if (j >= n) return null;
    if (s[j] === ">") return { end: j + 1, name, attrs, self, closing };
    const as = j;
    while (j < n && !isWs(s[j]) && s[j] !== "=" && s[j] !== ">" && s[j] !== "/") j++;
    if (j === as) { j++; continue; }
    const an = s.slice(as, j).toLowerCase();
    while (j < n && isWs(s[j])) j++;
    let val = "";
    if (s[j] === "=") {
      j++;
      while (j < n && isWs(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, j + 1);
        if (e < 0) return null;
        val = s.slice(j + 1, e);
        j = e + 1;
      } else {
        const vs = j;
        while (j < n && !isWs(s[j]) && s[j] !== ">") j++;
        val = s.slice(vs, j);
      }
    }
    if (attrs.size < MAX_ATTRS && !attrs.has(an)) attrs.set(an, decodeEntities(val));
  }
}

function tokenize(html: string, maxTokens: number): { toks: Tok[]; title: string; truncated: boolean } {
  const toks: Tok[] = [];
  let title = "";
  let truncated = false;
  let i = 0;
  const n = html.length;
  const add = (t: Tok): boolean => {
    if (toks.length >= maxTokens) { truncated = true; return false; }
    toks.push(t);
    return true;
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { add({ k: "text", text: html.slice(i) }); break; }
    if (lt > i && !add({ k: "text", text: html.slice(i, lt) })) break;
    const c = html[lt + 1];
    if (c === "!" || c === "?") {
      let e: number;
      if (html.startsWith("<!--", lt)) { e = html.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; }
      else if (html.startsWith("<![CDATA[", lt)) { e = html.indexOf("]]>", lt + 9); i = e < 0 ? n : e + 3; }
      else { e = html.indexOf(">", lt + 2); i = e < 0 ? n : e + 1; }
      continue;
    }
    if (!isAlpha(c) && !(c === "/" && isAlpha(html[lt + 2]))) {
      if (!add({ k: "text", text: "<" })) break;
      i = lt + 1;
      continue;
    }
    const tag = parseTag(html, lt);
    if (!tag) { add({ k: "text", text: html.slice(lt) }); break; }
    i = tag.end;
    if (tag.closing) {
      if (!add({ k: "close", name: tag.name })) break;
      continue;
    }
    if (RAW_TEXT.has(tag.name) && !tag.self) {
      const re = new RegExp(`</${tag.name}[\\s/>]`, "gi");
      re.lastIndex = i;
      const m = re.exec(html);
      const contentEnd = m ? m.index : n;
      if (tag.name === "title" && !title) title = decodeEntities(html.slice(i, contentEnd)).replace(/\s+/g, " ").trim();
      const gt = m ? html.indexOf(">", contentEnd) : -1;
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (RAW_TEXT.has(tag.name)) continue;
    if (!add({ k: "open", name: tag.name, attrs: tag.attrs, self: tag.self })) break;
  }
  return { toks, title, truncated };
}

const nameTokens = (v: string | undefined): string[] => (v ? v.toLowerCase().split(/[\s_-]+/) : []);

interface Entry {
  name: string;
  drop: boolean;
  off: boolean;
  isRoot: boolean;
  isPre?: boolean;
  href?: string;
  bufLen?: number;
  flushes?: number;
}

export function htmlToText(html: string, opts: HtmlToTextOptions = {}): HtmlToTextResult {
  const maxDepth = opts.maxDepth ?? 256;
  const maxTokens = opts.maxTokens ?? 200000;
  const width = opts.wrapWidth ?? 120;
  const { toks, title, truncated } = tokenize(html, maxTokens);

  // Content root: first main, else article, else role=main, else body, else whole document.
  const findRoot = (pred: (t: Extract<Tok, { k: "open" }>) => boolean): number =>
    toks.findIndex((t) => t.k === "open" && pred(t));
  let rootIdx = findRoot((t) => t.name === "main");
  if (rootIdx < 0) rootIdx = findRoot((t) => t.name === "article");
  if (rootIdx < 0) rootIdx = findRoot((t) => t.attrs.get("role") === "main");
  if (rootIdx < 0) rootIdx = findRoot((t) => t.name === "body");

  const lines: string[] = [];
  const stack: Entry[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  let buf = "";
  let flushes = 0;
  let skip = 0;
  let ignoredOpen = 0;
  let quote = 0;
  let bullet: string | null = null;
  let heading = "";
  let pre = null as { lang: string; text: string } | null;
  let cells: string[] | null = null;
  let inCell = false;
  let done = false;

  const contIndent = (): string => "  ".repeat(lists.length);
  const flush = (): void => {
    flushes++;
    const text = buf.replace(/\s+/g, " ").trim();
    buf = "";
    if (!text) return;
    const q = "> ".repeat(quote);
    const cont = q + contIndent();
    let line = q + (bullet ?? contIndent());
    bullet = null;
    let has = false;
    for (const w of text.split(" ")) {
      if (has && line.length + 1 + w.length > width) { lines.push(line); line = cont + w; }
      else { line += (has ? " " : "") + w; }
      has = true;
    }
    lines.push(line);
  };
  const sep = (): void => { if (inCell) buf += " "; else flush(); };
  const para = (): void => {
    if (inCell) { buf += " "; return; }
    flush();
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  };

  const resolveHref = (href: string | undefined): URL | null => {
    if (!href || href.startsWith("#")) return null;
    try {
      const u = opts.baseUrl ? new URL(href.trim(), opts.baseUrl) : new URL(href.trim());
      return u.protocol === "http:" || u.protocol === "https:" ? u : null;
    } catch {
      return null;
    }
  };

  const openEffects = (e: Entry, attrs: Map<string, string>): void => {
    const name = e.name;
    if (name.length === 2 && name[0] === "h" && name[1] >= "1" && name[1] <= "6") {
      para();
      heading = "#".repeat(Number(name[1])) + " ";
      buf = heading;
    } else if (name === "pre") {
      para();
      e.isPre = true;
      pre = { lang: /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(attrs.get("class") ?? "")?.[1] ?? "", text: "" };
    } else if (name === "code") {
      if (pre) {
        if (!pre.lang) pre.lang = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(attrs.get("class") ?? "")?.[1] ?? "";
      } else buf += "`";
    } else if (name === "blockquote") {
      para();
      quote++;
    } else if (name === "ul" || name === "ol") {
      if (lists.length === 0) para(); else sep();
      lists.push({ ordered: name === "ol", n: 0 });
    } else if (name === "li") {
      sep();
      const top = lists[lists.length - 1];
      const indent = "  ".repeat(Math.max(0, lists.length - 1));
      if (top) { top.n++; bullet = indent + (top.ordered ? `${top.n}. ` : "- "); }
    } else if (name === "tr") {
      sep();
      cells = [];
    } else if (name === "td" || name === "th") {
      inCell = true;
      buf = "";
    } else if (name === "a") {
      const u = resolveHref(attrs.get("href"));
      if (u) { e.href = u.href; e.bufLen = buf.length; e.flushes = flushes; }
    } else if (PARA.has(name)) para();
    else if (SEP.has(name)) sep();
  };

  const closeEffects = (e: Entry): void => {
    const name = e.name;
    if (name.length === 2 && name[0] === "h" && name[1] >= "1" && name[1] <= "6") {
      if (buf.trim() === heading.trim()) buf = "";
      para();
    } else if (e.isPre && pre) {
      const body = pre.text.replace(/^\r?\n/, "").replace(/\s+$/, "");
      const ticks = Math.max(3, ...(body.match(/`+/g) ?? []).map((m) => m.length + 1));
      const fence = "`".repeat(ticks);
      flush();
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(fence + pre.lang, ...body.split(/\r?\n/), fence, "");
      pre = null;
    } else if (name === "code") {
      if (!pre) buf += "`";
    } else if (name === "blockquote") {
      flush();
      quote = Math.max(0, quote - 1);
      para();
    } else if (name === "ul" || name === "ol") {
      flush();
      lists.pop();
      if (lists.length === 0) para();
    } else if (name === "td" || name === "th") {
      cells?.push(buf.replace(/\s+/g, " ").trim());
      buf = "";
      inCell = false;
    } else if (name === "tr") {
      if (cells?.some((c) => c)) lines.push("> ".repeat(quote) + cells.join(" | "));
      cells = null;
    } else if (name === "a") {
      if (e.href !== undefined && e.bufLen !== undefined && e.flushes === flushes) {
        const text = buf.slice(e.bufLen).trim();
        const norm = (s: string): string => s.replace(/\/+$/, "");
        if (text && norm(text) !== norm(e.href)) buf += ` (${e.href})`;
      }
    } else if (PARA.has(name)) para();
    else if (SEP.has(name)) sep();
  };

  const popTo = (idx: number): void => {
    while (stack.length > idx) {
      const e = stack.pop();
      if (!e) break;
      if (e.drop) skip--;
      if (!e.off) closeEffects(e);
      if (e.isRoot) done = true;
    }
  };
  const nearest = (names: string[]): number => {
    for (let k = stack.length - 1; k >= 0; k--) if (names.includes(stack[k]?.name ?? "")) return k;
    return -1;
  };

  const shouldDrop = (name: string, attrs: Map<string, string>, isRoot: boolean): boolean => {
    if (DROP.has(name)) return true;
    if (name === "header") return nearest(["main", "article"]) < 0;
    if (attrs.has("hidden") || attrs.get("aria-hidden")?.trim().toLowerCase() === "true") return true;
    if (attrs.has("data-line-number")) return true;
    const toks = [...nameTokens(attrs.get("class")), ...nameTokens(attrs.get("id"))];
    if (toks.some((t) => GUTTER_TOKENS.has(t))) return true;
    if (isRoot || name === "html" || name === "body" || name === "main" || name === "article") return false;
    return toks.some((t) => CHROME_TOKENS.has(t));
  };

  const addText = (raw: string): void => {
    if (skip > 0) return;
    const decoded = decodeEntities(raw);
    if (pre) { pre.text += decoded; return; }
    let s = decoded.replace(/\s+/g, " ");
    if (buf === "" || buf.endsWith(" ")) s = s.replace(/^ /, "");
    buf += s;
  };

  for (let t = Math.max(rootIdx, 0); t < toks.length && !done; t++) {
    const tok = toks[t];
    if (!tok) break;
    if (tok.k === "text") { addText(tok.text); continue; }
    if (tok.k === "close") {
      if (ignoredOpen > 0 && !VOID.has(tok.name)) { ignoredOpen--; continue; }
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k]?.name === tok.name) { idx = k; break; }
      if (idx >= 0) popTo(idx);
      continue;
    }
    const { name, attrs } = tok;
    if (VOID.has(name) || tok.self) {
      if (skip > 0) continue;
      if (name === "br") { if (pre) pre.text += "\n"; else sep(); }
      else if (name === "hr") para();
      else if (name === "img") {
        const alt = attrs.get("alt")?.trim();
        if (alt && !pre) addText(` ${alt} `);
      }
      continue;
    }
    if (stack.length >= maxDepth) { ignoredOpen++; continue; }
    // Implied end tags for the common unclosed-element cases.
    if (name === "li") { const k = nearest(["li", "ul", "ol"]); if (k >= 0 && stack[k]?.name === "li") popTo(k); }
    else if (name === "td" || name === "th") { const k = nearest(["td", "th", "tr", "table"]); if (k >= 0 && (stack[k]?.name === "td" || stack[k]?.name === "th")) popTo(k); }
    else if (name === "tr") { const k = nearest(["tr", "table"]); if (k >= 0 && stack[k]?.name === "tr") popTo(k); }
    else if (name === "p" && stack[stack.length - 1]?.name === "p") popTo(stack.length - 1);
    const isRoot = t === rootIdx;
    const drop = shouldDrop(name, attrs, isRoot);
    const entry: Entry = { name, drop, off: drop || skip > 0, isRoot };
    if (drop) skip++;
    stack.push(entry);
    if (!entry.off) openEffects(entry, attrs);
  }
  popTo(0);
  flush();

  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  let first = 0;
  while (first < lines.length && lines[first] === "") first++;
  return { title, text: lines.slice(first).join("\n"), truncated };
}
