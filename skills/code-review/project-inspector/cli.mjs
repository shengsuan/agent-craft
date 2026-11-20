#!/usr/bin/env node
import { parseArgs } from "node:util";
import { scan, inspect, git, render, PROFILES } from "./index.mjs";

const USAGE = `project-inspector <command> [options]

commands
  scan                 project profile (default depth: quick)
  inspect <paths...>   targeted scan of files/dirs: exports, imports, importers
  git                  branch, base and change set
  mcp                  run as MCP server over stdio

options
  -r, --root <dir>       project root (default: cwd)
  -d, --depth <level>    quick | deep
  -p, --profile <name>   ${Object.keys(PROFILES).join(" | ")}
  -f, --format <fmt>     json | md
  -b, --base <ref>       git base ref
      --sections <list>  comma separated top-level sections to keep
      --scope <list>     comma separated package paths for deep scan
      --paths <path>     path for inspect (repeatable)
      --max-files <n>    file list cap (default 50000)
      --no-git           skip git collection
      --no-refs          skip importer search in inspect
      --pretty           indent JSON
  -h, --help`;

const fail = msg => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", short: "r" },
      depth: { type: "string", short: "d" },
      profile: { type: "string", short: "p" },
      format: { type: "string", short: "f", default: "json" },
      base: { type: "string", short: "b" },
      sections: { type: "string" },
      scope: { type: "string" },
      paths: { type: "string", multiple: true },
      "max-files": { type: "string" },
      "no-git": { type: "boolean" },
      "no-refs": { type: "boolean" },
      pretty: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (e) {
  fail(`${e.message}\n\n${USAGE}`);
}

const { values: v, positionals: [cmd = "scan", ...rest] } = args;
if (v.help || cmd === "help") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (v.format !== "json" && v.format !== "md") fail(`invalid format: ${v.format}`);

const list = s => s?.split(",").map(x => x.trim()).filter(Boolean);
const common = { root: v.root, base: v.base, maxFiles: v["max-files"] ? +v["max-files"] : undefined };

try {
  if (cmd === "mcp") {
    (await import("./mcp.mjs")).serve();
  } else {
    let data;
    if (cmd === "scan") {
      data = await scan({ ...common, depth: v.depth, profile: v.profile, sections: list(v.sections), scope: list(v.scope), git: v["no-git"] ? false : undefined });
    } else if (cmd === "inspect") {
      data = await inspect({ ...common, paths: [...(v.paths ?? []), ...rest], refs: !v["no-refs"] });
    } else if (cmd === "git") {
      data = await git(common);
    } else fail(`unknown command: ${cmd}\n\n${USAGE}`);
    const text = v.format === "md" ? render(cmd, data) : JSON.stringify(data, null, v.pretty || process.stdout.isTTY ? 2 : undefined);
    process.stdout.write(`${text}\n`);
  }
} catch (e) {
  fail(`error: ${e.message}`);
}
