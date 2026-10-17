#!/usr/bin/env node
import { install, type InstallTarget } from "./install.js";

const USAGE = "usage: paradoc install [opencode|copilot|all] [--project]\n";

const [command, ...rest] = process.argv.slice(2);
const flags = rest.filter((arg) => arg.startsWith("--"));
const names = rest.filter((arg) => !arg.startsWith("--"));
const unknownFlag = flags.find((flag) => flag !== "--project");
const name = names[0] ?? "all";

if (command !== "install" || unknownFlag || names.length > 1 || !["opencode", "copilot", "all"].includes(name)) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const targets: InstallTarget[] = name === "all" ? ["opencode", "copilot"] : [name as InstallTarget];
try {
  for (const line of install({ targets, project: flags.includes("--project") })) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write("Restart opencode / copilot to load ParaDoc.\n");
} catch (error) {
  process.stderr.write(`paradoc: install failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
