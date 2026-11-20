import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scan, inspect, git, render } from "../index.mjs";

let dir;
const put = async (p, c) => {
  await mkdir(dirname(join(dir, p)), { recursive: true });
  await writeFile(join(dir, p), c);
};
const sh = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-"));
  await put("package.json", JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"], packageManager: "pnpm@9.1.0" }));
  await put("pnpm-lock.yaml", "");
  await put("turbo.json", "{}");
  await put(".nvmrc", "v20.11.0\n");
  await put("apps/web/package.json", JSON.stringify({
    name: "web",
    dependencies: { next: "^15.0.0", react: "^19.0.0" },
    devDependencies: { typescript: "^5", vitest: "^2.0.0", eslint: "^9" },
    scripts: { build: "next build", deploy: "curl -H 'token=abc123secret' https://x" },
  }));
  await put("apps/web/tsconfig.json", '{\n // c\n "compilerOptions": { "strict": true, "paths": { "@/*": ["./src/*"] }, },\n}');
  await put("apps/web/src/lib/util.ts", "export const add = (a: number, b: number) => a + b;\nexport default function f() {}\n");
  await put("apps/web/src/app/page.tsx", "import { add } from '../lib/util';\nimport React from 'react';\nexport default function P() { return add(1, 2); }\n");
  await put("apps/web/src/lib/util.test.ts", "import { add } from './util.js';\n");
  await put("apps/api/pyproject.toml", '[project]\nname = "api"\nrequires-python = ">=3.11"\ndependencies = [\n  "fastapi[standard]>=0.110",\n  "sqlalchemy==2.0.1",\n  "asyncpg",\n]\n[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\nminversion = "8"\n');
  await put("apps/api/app/main.py", "from fastapi import FastAPI\nfrom .db import engine\napp = FastAPI()\n");
  await put("apps/api/app/db.py", "engine = None\n\ndef connect():\n    pass\n");
  await put("services/worker/go.mod", "module example.com/worker\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/stretchr/testify v1.9.0\n)\n");
  await put("services/worker/main.go", 'package main\n\nimport "github.com/gin-gonic/gin"\n\nfunc Run() {}\n');
  await put("docker-compose.yml", "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n");
  await put("Dockerfile", "FROM node:20\n");
  await put(".github/workflows/ci.yml", "name: ci\n");
  await put(".env", "SECRET=1\n");
  await put(".env.example", "DATABASE_URL=\nAPI_KEY=\n");
  await put("certs/server.pem", "-----BEGIN-----");
  await put("examples/demo/package.json", JSON.stringify({ name: "demo", dependencies: { vue: "3" } }));
  await put("node_modules/react/package.json", "{}");
  sh("init", "-q", "-b", "main");
  await put(".gitignore", "node_modules\n");
  sh("add", "-A");
  sh("commit", "-qm", "init");
  sh("checkout", "-qb", "feature");
  await put("apps/web/src/lib/util.ts", "export const add = (a: number, b: number) => a + b + 0;\nexport default function f() {}\n");
  await put("apps/api/app/new.py", "x = 1\n");
});

after(() => rm(dir, { recursive: true, force: true }));

const names = a => a.map(x => x.name);

test("quick scan detects stack, workspace and toolchain", async () => {
  const p = await scan({ root: dir });
  assert.equal(p.project.layout, "workspace");
  assert.ok(p.project.isMonorepo);
  assert.deepEqual(p.project.workspace.sort(), ["node-workspaces", "turborepo"]);
  assert.ok(names(p.frameworks).includes("Next.js"));
  assert.ok(names(p.frameworks).includes("FastAPI"));
  assert.ok(names(p.frameworks).includes("Gin"));
  assert.ok(!names(p.frameworks).includes("Vue"));
  assert.ok(names(p.toolchain.testTools).includes("Vitest"));
  assert.ok(names(p.toolchain.testTools).includes("pytest"));
  assert.ok(names(p.toolchain.lintTools).includes("Ruff"));
  assert.ok(names(p.toolchain.packageManagers).includes("pnpm"));
  assert.equal(p.toolchain.runtimes.python, ">=3.11");
  assert.equal(p.toolchain.runtimes.go, "1.22");
  assert.equal(p.toolchain.runtimes.node, "20.11.0");
  assert.ok(names(p.infrastructure.ci).includes("GitHub Actions"));
  assert.ok(names(p.infrastructure.databases).includes("PostgreSQL"));
  assert.ok(p.packages.find(x => x.path === "examples/demo").aux);
  assert.ok(p.architecture.entrypoints.includes("apps/api/app/main.py"));
  assert.ok(p.architecture.entrypoints.includes("services/worker/main.go"));
  assert.equal(p.deep, undefined);
});

test("evidence and confidence accompany findings", async () => {
  const p = await scan({ root: dir });
  const next = p.frameworks.find(f => f.name === "Next.js");
  assert.equal(next.version, "15.0.0");
  assert.equal(next.confidence, 0.9);
  assert.deepEqual(next.packages, ["apps/web"]);
  assert.match(next.evidence[0], /apps\/web\/package\.json:next/);
  const ts = p.languages.find(l => l.name === "TypeScript");
  assert.ok(ts.evidence.some(e => e.includes("tsconfig.json")));
});

test("sensitive and ignored files are never listed or read", async () => {
  const p = await scan({ root: dir, depth: "deep" });
  const text = JSON.stringify(p);
  assert.ok(!text.includes("SECRET=1"));
  assert.ok(!text.includes("server.pem"));
  assert.ok(!text.includes("node_modules"));
  assert.deepEqual(p.deep.envVars[".env.example"], ["DATABASE_URL", "API_KEY"]);
  assert.ok(p.scan.excludedCount >= 2);
});

test("deep scan collects scripts (redacted), tests, tsconfig and routes", async () => {
  const p = await scan({ root: dir, depth: "deep" });
  assert.equal(p.deep.scripts["apps/web"].build, "next build");
  assert.ok(p.deep.scripts["apps/web"].deploy.includes("[REDACTED]"));
  assert.ok(!p.deep.scripts["apps/web"].deploy.includes("abc123secret"));
  assert.equal(p.deep.typescript["apps/web"].strict, true);
  assert.deepEqual(p.deep.typescript["apps/web"].paths, ["@/*"]);
  assert.ok(p.deep.tests.count >= 1);
  assert.ok(p.deep.routeFiles.files.includes("apps/web/src/app/page.tsx"));
  assert.ok(names(p.infrastructure.databases).includes("Redis"));
});

test("git collection maps changes to packages; code-review profile scopes deep scan", async () => {
  const g = await git({ root: dir });
  assert.equal(g.branch, "feature");
  assert.equal(g.base, "main");
  assert.deepEqual(g.changedFiles.sort(), ["apps/api/app/new.py", "apps/web/src/lib/util.ts"]);
  assert.deepEqual(g.untrackedFiles, ["apps/api/app/new.py"]);
  assert.deepEqual(g.unstagedFiles, ["apps/web/src/lib/util.ts"]);
  const p = await scan({ root: dir, profile: "code-review" });
  assert.deepEqual(p.git.affectedPackages, ["apps/api", "apps/web"]);
  assert.equal(p.infrastructure, undefined);
  assert.ok(p.deep.scripts);
});

test("git base ref is validated", async () => {
  await assert.rejects(() => git({ root: dir, base: "--output=/tmp/x" }), /invalid base/);
});

test("inspect reports exports, imports and importers", async () => {
  const r = await inspect({ root: dir, paths: ["apps/web/src/lib", "apps/api/app/db.py", "services/worker"] });
  const util = r.files.find(f => f.path === "apps/web/src/lib/util.ts");
  assert.deepEqual(util.exports.sort(), ["add", "default", "f"]);
  assert.deepEqual(util.importedBy.files, ["apps/web/src/app/page.tsx", "apps/web/src/lib/util.test.ts"]);
  const page = await inspect({ root: dir, paths: ["apps/web/src/app/page.tsx"] });
  assert.deepEqual(page.files[0].local, ["apps/web/src/lib/util.ts"]);
  assert.deepEqual(page.files[0].external, ["react"]);
  const db = r.files.find(f => f.path === "apps/api/app/db.py");
  assert.deepEqual(db.importedBy.files, ["apps/api/app/main.py"]);
  const go = r.files.find(f => f.path === "services/worker/main.go");
  assert.deepEqual(go.exports, ["Run"]);
  assert.deepEqual(go.external, ["github.com/gin-gonic/gin"]);
});

test("inspect refuses paths outside the root", async () => {
  const r = await inspect({ root: dir, paths: ["../etc", "/etc/passwd"] });
  assert.equal(r.files.length, 0);
  assert.equal(r.warnings.filter(w => w.startsWith("outside root")).length, 2);
});

test("symlinks are not followed when reading", async () => {
  await symlink("/etc/hostname", join(dir, "link.txt")).catch(() => {});
  const r = await inspect({ root: dir, paths: ["link.txt"] });
  assert.ok(r.files.every(f => f.skipped || f.lines === undefined));
});

test("md rendering and unknown profile", async () => {
  const p = await scan({ root: dir, depth: "deep" });
  const text = render("scan", p);
  assert.match(text, /^# mono \[workspace/);
  assert.match(text, /Next\.js 15\.0\.0/);
  await assert.rejects(() => scan({ root: dir, profile: "nope" }), /unknown profile/);
});

test("non-git directory falls back to filesystem walk", async () => {
  const d = await mkdtemp(join(tmpdir(), "pi-nogit-"));
  await mkdir(join(d, "node_modules/x"), { recursive: true });
  await writeFile(join(d, "node_modules/x/a.js"), "1");
  await writeFile(join(d, "go.mod"), "module a.b/c\n\ngo 1.21\n");
  await writeFile(join(d, "main.go"), "package main\n");
  const p = await scan({ root: d });
  assert.equal(p.git.available, false);
  assert.equal(p.scan.files, 2);
  assert.equal(p.scan.excludedCount, 1);
  assert.deepEqual(names(p.toolchain.packageManagers), ["Go modules"]);
  await rm(d, { recursive: true, force: true });
});
