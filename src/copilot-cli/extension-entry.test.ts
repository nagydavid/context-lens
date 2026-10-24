import { ok, rejects, strictEqual, throws } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { FakeSubagentRunner } from "../core/fake-runner.js";
import { buildE2eFixture, buildViewInput } from "./probe-fixture.js";
import { buildExtensionShim, defaultEntryUrl, registerParaDoc } from "./extension-entry.js";
import type { JoinSession } from "./types.js";

const answer = {
  excerpts: [{ startLine: 232, endLine: 238, reason: "checksum implementation" }],
  summary: "The checksum implementation normalizes its input.",
  confidence: 4,
};

let tmp: string;
let fixturePath: string;
before(() => {
  tmp = mkdtempSync(join(process.cwd(), "paradoc-extension-entry-"));
  fixturePath = join(tmp, "fixture.ts");
  writeFileSync(fixturePath, buildE2eFixture());
});
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("Copilot extension entry", () => {
  it("registers hooks and condenses an eligible native view", async () => {
    const logs: string[] = [];
    let captured: Parameters<JoinSession>[0] | undefined;
    const fakeJoin: JoinSession = async (config) => {
      captured = config;
      return { log: (message) => logs.push(message) };
    };
    const { hooks } = await registerParaDoc(fakeJoin, {
      runner: new FakeSubagentRunner({ structured: answer }),
      env: {},
      configOptions: { homeDir: tmp, env: {}, projectRoot: tmp },
      logSink: () => undefined,
    });

    ok(captured);
    strictEqual(typeof captured.hooks.onPostToolUse, "function");
    strictEqual(typeof captured.hooks.onUserPromptSubmitted, "function");
    const result = await hooks.onPostToolUse(buildViewInput({
      path: fixturePath,
      workingDirectory: tmp,
      text: "original native view",
    }));
    ok(result?.modifiedResult?.textResultForLlm.includes("[paradoc]"));
    ok(result?.modifiedResult?.textResultForLlm.includes("Confidence:"));
    ok(logs.some((line) => line.includes("intercepted")));
  });

  it("registers a /paradoc command that persists and reports controls", async () => {
    const logs: string[] = [];
    let captured: Parameters<JoinSession>[0] | undefined;
    const projectRoot = join(tmp, "command-project");
    mkdirSync(projectRoot, { recursive: true });
    const fakeJoin: JoinSession = async (config) => {
      captured = config;
      return { log: (message) => logs.push(message) };
    };

    await registerParaDoc(fakeJoin, {
      env: {},
      configOptions: { homeDir: tmp, env: {}, projectRoot: tmp },
      logSink: () => undefined,
    });

    ok(captured?.commands);
    const command = captured.commands.find(({ name }) => name === "paradoc");
    ok(command);
    strictEqual(command.description, "Show or change ParaDoc settings: status | set <key> <value> | reset [key] [--global]");
    await captured.hooks.onUserPromptSubmitted?.({ sessionId: "command", prompt: "hi", workingDirectory: projectRoot });
    await command.handler({ sessionId: "command", command: "/paradoc", commandName: "paradoc", args: "set thresholdLines 500" });
    const config = readFileSync(join(projectRoot, ".paradoc", "config.json"), "utf8");
    ok(config.includes('"thresholdLines": 500'));
    ok(logs.some((line) => line.includes("wrote") && line.includes("restart the host")));

    await command.handler({ sessionId: "command", command: "/paradoc", commandName: "paradoc", args: "status" });
    ok(/thresholdLines\s+500\s+project/.test(logs.at(-1) ?? ""));
    await rejects(
      async () => { await command.handler({ sessionId: "command", command: "/paradoc", commandName: "paradoc", args: "set noSuchKey 1" }); },
      /keys: .*thresholdLines/,
    );
    await rejects(
      async () => { await command.handler({ sessionId: "command", command: "/paradoc", commandName: "paradoc", args: "set thresholdLines bad" }); },
      /keys: .*thresholdLines/,
    );
  });

  it("builds an SDK-free shim that imports the compiled entry", async () => {
    const shim = buildExtensionShim(pathToFileURL(fixturePath).href);
    ok(shim.includes('import { joinSession } from "@github/copilot-sdk/extension";'));
    ok(shim.includes(pathToFileURL(fixturePath).href));
    ok(!shim.includes("console.log"));
    throws(() => buildExtensionShim("relative/entry.js"), /file:\/\/ URL or absolute path/);

    const shimDirectory = mkdtempSync(join(tmp, "shim-"));
    try {
      const packageDirectory = join(shimDirectory, "node_modules", "@github", "copilot-sdk");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
        name: "@github/copilot-sdk",
        type: "module",
        exports: { "./extension": "./extension.js" },
      }));
      writeFileSync(join(packageDirectory, "extension.js"), [
        "export async function joinSession(config) {",
        "  globalThis.paraDocShimHooks = config.hooks;",
        "  return { log() {} };",
        "}",
        "",
      ].join("\n"));
      const shimPath = join(shimDirectory, "extension.mjs");
      writeFileSync(shimPath, buildExtensionShim(defaultEntryUrl()));
      await import(`${pathToFileURL(shimPath).href}?test=${Date.now()}`);
      const registered = (globalThis as typeof globalThis & {
        paraDocShimHooks?: Record<string, unknown>;
      }).paraDocShimHooks;
      ok(registered);
      strictEqual(typeof registered.onPostToolUse, "function");
      strictEqual(typeof registered.onUserPromptSubmitted, "function");
    } finally {
      delete (globalThis as typeof globalThis & { paraDocShimHooks?: unknown }).paraDocShimHooks;
      rmSync(shimDirectory, { recursive: true, force: true });
    }
  });
});
