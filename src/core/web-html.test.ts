import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { htmlToText } from "./web-html.js";

const text = (html: string, opts?: Parameters<typeof htmlToText>[1]): string => htmlToText(html, opts).text;

describe("htmlToText content root and chrome", () => {
  it("prefers main over body and drops nav/footer/aside", () => {
    const out = text("<body><nav>NAVTEXT</nav><main><h1>Doc</h1><p>Body</p></main><aside>ASIDE</aside><footer>FOOT</footer></body>");
    strictEqual(out, "# Doc\n\nBody");
  });

  it("falls back to article, role=main, body, then the whole document", () => {
    ok(text("<div>OUT</div><article>IN</article>") === "IN");
    ok(text('<div>OUT</div><div role="main">IN</div>') === "IN");
    ok(text("<div>OUT</div><body>IN</body>") === "IN");
    strictEqual(text("plain <b>text</b> only"), "plain text only");
  });

  it("drops header outside main/article but keeps it inside", () => {
    strictEqual(text("<body><header>TOP</header><p>x</p></body>"), "x");
    strictEqual(text("<main><header><h1>Kept</h1></header></main>"), "# Kept");
  });

  it("removes hidden and aria-hidden subtrees", () => {
    const out = text('<main><p>a</p><div hidden>H1<p>H2</p></div><span aria-hidden="true">H3</span><p>b</p></main>');
    strictEqual(out, "a\n\nb");
  });

  it("removes class/id chrome tokens without false positives", () => {
    const out = text(
      '<main><div class="sidebar">SIDE</div><div id="toc">TOC</div><div class="nav-item">NI</div>' +
        '<div class="navigation-guide">GUIDE</div><p class="footer-note">FN</p><p class="has-content">KEEP</p></main>',
    );
    ok(!/SIDE|TOC|NI|FN/.test(out), out);
    ok(out.includes("GUIDE") && out.includes("KEEP"), out);
  });

  it("does not drop the content root or body for a chrome-like class", () => {
    strictEqual(text('<body class="has-sidebar nav-open"><p>ok</p></body>'), "ok");
  });

  it("removes script, style, comments, CDATA and doctype", () => {
    const out = text(
      "<!DOCTYPE html><body><script>var a = '<div>no</div>'; if (1 < 2) {}</script><style>p{x:'<b>'}</style>" +
        "<!-- hidden --><![CDATA[ cdata ]]><p>shown</p><script>var s = \"<\\/script>\";</script></body>",
    );
    strictEqual(out, "shown");
  });

  it("treats script content as raw: a closing tag inside text after </script> is real text", () => {
    strictEqual(text("<body><script>x</script>after</body>"), "after");
  });
});

describe("htmlToText structure", () => {
  it("renders headings, nested lists, blockquote and tables", () => {
    const out = text(
      "<main><h2>Two</h2><ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol><li>x<li>y</ol>" +
        "<blockquote><p>quoted</p></blockquote><table><tr><th>K</th><th>V</th></tr><tr><td>1</td><td>2</td></tr></table></main>",
    );
    deepStrictEqual(out.split("\n"), [
      "## Two", "", "- a", "  - b", "- c", "", "1. x", "2. y", "", "> quoted", "", "K | V", "1 | 2",
    ]);
  });

  it("renders pre fences preserving indentation, dropping highlight spans and gutters", () => {
    const out = text(
      '<main><table class="highlighttable"><tr><td class="linenos"><pre>1\n2</pre></td><td><pre class="x"><code class="language-ts">' +
        '<span class="k">function</span> f() {\n  <span>return</span> 1;\n}\n</code></pre></td></tr></table>' +
        '<pre><span class="lineno">9</span>plain  spaced\n\n  tail</pre></main>',
    );
    ok(out.includes("```ts\nfunction f() {\n  return 1;\n}\n```"), out);
    ok(out.includes("```\nplain  spaced\n\n  tail\n```"), out);
    ok(!/^1$|^2$|^9/m.test(out), out);
  });

  it("renders inline code, br and img alt text", () => {
    strictEqual(text('<main><p>use <code>npm i</code><br>now <img alt="logo" src="x"><img src="y"></p></main>'), "use `npm i`\nnow logo");
  });

  it("resolves links against baseUrl and drops unsafe or same-page hrefs", () => {
    const base = new URL("https://docs.example.com/guide/start");
    const out = text(
      '<main><p><a href="../api">API</a> <a href="javascript:alert(1)">JS</a> <a href="data:text/html,x">D</a> ' +
        '<a href="#top">Top</a> <a href="https://x.dev/">https://x.dev/</a> <a href="mailto:a@b.c">M</a></p></main>',
      { baseUrl: base },
    );
    strictEqual(out, "API (https://docs.example.com/api) JS D Top https://x.dev/ M");
  });
});

describe("htmlToText entities, whitespace, wrap, title", () => {
  it("decodes named, numeric, hex and out-of-range entities", () => {
    strictEqual(text("<p>&amp;&lt;&gt;&quot;&hellip;&mdash;&copy; &#65;&#x42; &#1114112; &#xD800; &#0; &bogus; &amp</p>"), '&<>"…—© AB � � � &bogus; &amp');
  });

  it("collapses whitespace and caps blank lines at one", () => {
    strictEqual(text("<main><p>  a \n\n  b  </p><p></p><p></p><div></div><p>c</p></main>"), "a b\n\nc");
  });

  it("soft-wraps long lines at 120 but not pre or table rows", () => {
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
    const out = text(`<main><p>${words}</p></main>`);
    const lines = out.split("\n");
    ok(lines.length > 1);
    ok(lines.every((l) => l.length <= 120), "wrapped");
    strictEqual(lines.join(" "), words);
    const long = "z".repeat(300);
    ok(text(`<main><pre>${long}</pre><table><tr><td>${long}</td></tr></table></main>`).includes(long));
    ok(text(`<main><p>${"y".repeat(200)}</p></main>`).length === 200);
  });

  it("extracts the title from head", () => {
    const r = htmlToText("<html><head><title> My &amp; Docs\n</title></head><body><p>x</p></body></html>");
    strictEqual(r.title, "My & Docs");
    strictEqual(r.text, "x");
    strictEqual(htmlToText("<p>no title</p>").title, "");
  });
});

describe("htmlToText pathological input", () => {
  const timed = (fn: () => void): void => {
    const t0 = Date.now();
    fn();
    ok(Date.now() - t0 < 3000, "completed quickly");
  };

  it("survives 10k nested divs with bounded depth", () => {
    timed(() => {
      const r = htmlToText("<div>".repeat(10000) + "deep text" + "</div>".repeat(10000) + "<p>after</p>");
      ok(r.text.includes("deep text") && r.text.includes("after"));
    });
  });

  it("treats unterminated < as text and never hangs", () => {
    timed(() => {
      strictEqual(text("<p>a < b and c<3</p>"), "a < b and c<3");
      const r = text("<p>start</p><a href=\"x" + "<a ".repeat(50000));
      ok(r.startsWith("start"));
      ok(text("<p>x</p><div class='open").includes("x"));
      ok(text("<p>x</p><!-- never closed").includes("x"));
    });
  });

  it("caps attribute floods and keeps output bounded", () => {
    timed(() => {
      const attrs = Array.from({ length: 20000 }, (_, i) => `a${i}="v"`).join(" ");
      strictEqual(text(`<p ${attrs}>ok</p>`), "ok");
    });
  });

  it("stops at maxTokens and reports truncated", () => {
    const html = "<p>x</p>".repeat(1000);
    const r = htmlToText(html, { maxTokens: 50 });
    strictEqual(r.truncated, true);
    ok(r.text.length < 200);
    strictEqual(htmlToText("<p>x</p>").truncated, false);
  });

  it("honors a small maxDepth without crashing", () => {
    const r = htmlToText("<div><div><div><div>kept</div></div></div></div><p>tail</p>", { maxDepth: 2 });
    ok(r.text.includes("kept") && r.text.includes("tail"));
  });

  it("is deterministic", () => {
    const html = "<main><h1>T</h1><ul><li>a</li></ul><pre>x\n y</pre><p>&amp; z</p></main>";
    strictEqual(text(html), text(html));
  });
});
