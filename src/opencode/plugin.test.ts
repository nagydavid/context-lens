import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { after, before, describe, it } from "node:test";
import * as mod from "./plugin.js";
import { ParaDocPlugin } from "./plugin.js";

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "paradoc-plugin-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const client = {
  session: {
    create: async () => ({}),
    prompt: async () => ({}),
    delete: async () => ({}),
  },
};

describe("ParaDocPlugin", () => {
  it("(a) exports exactly one function: ParaDocPlugin", () => {
    const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
    deepStrictEqual(fns.map(([k]) => k), ["ParaDocPlugin"]);
    strictEqual(Object.keys(mod).length, 1);
  });

  it("(b) resolves to hooks with tool.execute.after and chat.message", async () => {
    const hooks = await ParaDocPlugin({ client, directory: tmp });
    strictEqual(typeof hooks["tool.execute.after"], "function");
    strictEqual(typeof hooks["chat.message"], "function");
  });

  it("(c) leaves small-file output unchanged without client.app", async () => {
    const file = join(tmp, "small.ts");
    writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
    const hooks = await ParaDocPlugin({ client, directory: tmp });
    const output = { title: file, output: "orig output", metadata: { a: 1 } };
    await hooks["tool.execute.after"](
      { tool: "read", sessionID: "s1", callID: "c1", args: { filePath: file } },
      output
    );
    deepStrictEqual(output, { title: file, output: "orig output", metadata: { a: 1 } });
  });
});
