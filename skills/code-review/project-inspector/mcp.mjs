import { createInterface } from "node:readline";
import { scan, inspect, git, render, PROFILES } from "./index.mjs";

const root = { type: "string", description: "Project root directory (default: server cwd)" };
const format = { type: "string", enum: ["json", "md"], description: "md is a compact text form that costs fewer tokens" };

const TOOLS = [
  {
    name: "project_scan",
    description: "Deterministically collect a structured project profile: languages, frameworks, toolchain, monorepo packages, architecture hints, infrastructure and git changes. Never executes project code.",
    inputSchema: {
      type: "object",
      properties: {
        root,
        depth: { type: "string", enum: ["quick", "deep"] },
        profile: { type: "string", enum: Object.keys(PROFILES) },
        base: { type: "string", description: "Git base ref for change detection" },
        git: { type: "boolean" },
        format,
      },
    },
    run: a => scan(a),
    kind: "scan",
  },
  {
    name: "project_inspect",
    description: "Targeted scan of specific files or directories: line counts, exports, local and external imports, and which files import them.",
    inputSchema: {
      type: "object",
      properties: { root, paths: { type: "array", items: { type: "string" } }, refs: { type: "boolean" }, format },
      required: ["paths"],
    },
    run: a => inspect(a),
    kind: "inspect",
  },
  {
    name: "project_git",
    description: "Git branch, base, changed/staged/unstaged/untracked files and diff statistics.",
    inputSchema: { type: "object", properties: { root, base: { type: "string" }, format } },
    run: a => git(a),
    kind: "git",
  },
];

export function serve() {
  const send = m => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  createInterface({ input: process.stdin }).on("line", async line => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = req;
    if (id === undefined) return;
    try {
      if (method === "initialize") {
        send({ id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "project-inspector", version: "1.0.0" } } });
      } else if (method === "tools/list") {
        send({ id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
      } else if (method === "tools/call") {
        const tool = TOOLS.find(t => t.name === params?.name);
        if (!tool) throw new Error(`unknown tool: ${params?.name}`);
        const args = params.arguments ?? {};
        const data = await tool.run(args);
        send({ id, result: { content: [{ type: "text", text: args.format === "md" ? render(tool.kind, data) : JSON.stringify(data) }] } });
      } else if (method === "ping") send({ id, result: {} });
      else send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    } catch (e) {
      send({ id, result: { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] } });
    }
  });
}
