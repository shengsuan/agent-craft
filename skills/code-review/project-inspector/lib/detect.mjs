import { basename, posix } from "node:path";
import { readText, pool } from "./fsx.mjs";
import { MANIFESTS } from "./manifests.mjs";
import { FILE_RULES, LANGS, LANG_MARKERS, ext, matchDep, norm } from "./rules.mjs";

const AUX = /(^|\/)(docs?|examples?|samples?|fixtures?|benchmarks?|playground)(\/|$)/i;
const WEIGHT = { dep: 0.9, file: 0.7 };
const MAX_PACKAGES = 200;

const FRONTEND = new Set(["React", "Next.js", "Vue", "Nuxt", "Angular", "Svelte", "SvelteKit", "Remix", "Astro", "React Native"]);
const BACKEND = new Set(["Express", "NestJS", "Fastify", "Koa", "Hono", "FastAPI", "Django", "Flask", "Gin", "Fiber", "Echo", "Axum", "Actix Web", "Rocket", "Spring Boot", "ASP.NET Core", "Rails", "Laravel"]);

const LAYERS = [
  ["controllers", "controller", "handlers", "handler", "routes", "api"],
  ["services", "service", "usecases", "domain"],
  ["repositories", "repository", "repos", "dao", "entities", "models", "db"],
];
const MVC = [["models", "model"], ["views", "view", "templates"], ["controllers", "controller"]];
const MOD_ROOTS = new Set(["src", "app", "lib", "internal", "pkg", "cmd", "apps", "packages", "services"]);

const ENTRY = [
  /^(src\/)?(main|index|app|server|cli)\.[cm]?[jt]sx?$/,
  /^(src\/)?app\/(layout|page)\.[jt]sx?$/,
  /^(src\/)?pages\/(_app|index)\.[jt]sx?$/,
  /^manage\.py$/,
  /^(src\/)?(app\/)?(main|app|wsgi|asgi|__main__)\.py$/,
  /^[\w-]+\/(__main__|main)\.py$/,
  /^(cmd\/[^/]+\/)?main\.go$/,
  /^src\/(main|lib)\.rs$/,
  /^src\/bin\/[^/]+\.rs$/,
  /^src\/main\/(java|kotlin)\/.+Application\.(java|kt)$/,
  /^([^/]+\/)?Program\.cs$/,
];

const TOOL_VERSIONS = { nodejs: "node", python: "python", golang: "go", rust: "rust", java: "java", ruby: "ruby", php: "php", dotnet: "dotnet" };
const VERSION_FILES = { ".nvmrc": "node", ".node-version": "node", ".python-version": "python", ".ruby-version": "ruby" };

const clean = v => {
  const s = String(v ?? "").trim().replace(/^[\^~>=<v\s]+/, "");
  return /^\d/.test(s) ? s : undefined;
};

function collector() {
  const m = new Map();
  const add = (kind, name, src, evidence, version, pkg) => {
    const k = `${kind}\0${name}`;
    let f = m.get(k);
    if (!f) m.set(k, (f = { kind, name, src: new Set(), evidence: new Set(), packages: new Set() }));
    f.src.add(src);
    f.evidence.add(evidence);
    f.version ??= clean(version);
    if (pkg) f.packages.add(pkg);
  };
  const list = (kind, withPackages) =>
    [...m.values()]
      .filter(f => f.kind === kind)
      .map(f => {
        const w = Math.max(...[...f.src].map(s => WEIGHT[s]));
        const o = { name: f.name };
        if (f.version) o.version = f.version;
        o.confidence = Math.min(1, +(w + (f.src.size > 1 ? 0.1 : 0)).toFixed(2));
        o.evidence = [...f.evidence].slice(0, 3);
        if (withPackages && f.packages.size) o.packages = [...f.packages].slice(0, 8);
        return o;
      })
      .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  return { add, list };
}

function childMap(files) {
  const all = new Set();
  for (const f of files) {
    let p = f.slice(0, Math.max(f.lastIndexOf("/"), 0));
    while (p && !all.has(p)) {
      all.add(p);
      p = p.slice(0, Math.max(p.lastIndexOf("/"), 0));
    }
  }
  const kids = new Map();
  for (const d of all) {
    const j = d.lastIndexOf("/");
    const parent = j > 0 ? d.slice(0, j) : ".";
    const name = d.slice(j + 1);
    if (!kids.has(parent)) kids.set(parent, new Map());
    kids.get(parent).set(name.toLowerCase(), name);
  }
  return kids;
}

function architecture({ files, set, live, owner, ws, layout }) {
  const patterns = [];
  if (layout !== "single") {
    patterns.push({
      name: "monorepo",
      confidence: ws.length ? 1 : 0.7,
      evidence: ws.length ? ws : live.map(p => p.path).slice(0, 6),
    });
  }
  const fe = live.filter(p => p.frameworks.some(n => FRONTEND.has(n)));
  const be = live.filter(p => p.frameworks.some(n => BACKEND.has(n)));
  if (fe.some(a => be.some(b => b.path !== a.path))) {
    patterns.push({
      name: "frontend-backend",
      confidence: 0.8,
      evidence: [...new Set([...fe, ...be])]
        .slice(0, 6)
        .map(p => `${p.path}: ${p.frameworks.filter(n => FRONTEND.has(n) || BACKEND.has(n)).join(", ")}`),
    });
  }
  const dockerDirs = [...new Set(files.filter(f => /(^|\/)Dockerfile(\..+)?$/.test(f)).map(f => posix.dirname(f)))].filter(d => !AUX.test(d));
  if (dockerDirs.length > 1) {
    patterns.push({ name: "multi-service", confidence: 0.5, evidence: dockerDirs.slice(0, 6).map(d => `${d}/Dockerfile`) });
  }

  const kids = childMap(files);
  const find = groups => {
    for (const [parent, ns] of kids) {
      if (AUX.test(parent)) continue;
      const hit = groups.map(g => g.find(n => ns.has(n)));
      if (hit.every(Boolean)) return hit.map((n, i) => `${parent === "." ? "" : `${parent}/`}${ns.get(groups[i].find(x => x === n))}`);
    }
  };
  for (const [name, groups] of [["mvc", MVC], ["layered", LAYERS]]) {
    const evidence = find(groups);
    if (evidence) patterns.push({ name, confidence: 0.5, evidence });
  }

  let modules;
  const sub = live.filter(p => p.path !== ".");
  if (sub.length) modules = sub.map(p => p.path);
  else {
    const mods = new Map();
    for (const f of files) {
      const s = f.split("/");
      if (s.length > 2 && MOD_ROOTS.has(s[0]) && LANGS[ext(f)]) mods.set(`${s[0]}/${s[1]}`, (mods.get(`${s[0]}/${s[1]}`) ?? 0) + 1);
    }
    modules = [...mods].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([m]) => m).sort();
  }

  const entries = new Set();
  for (const p of live) {
    for (const e of p.entries) {
      const f = posix.normalize(posix.join(p.path, e));
      if (set.has(f)) entries.add(f);
    }
  }
  for (const f of files) {
    const o = owner(f);
    const rel = o === "." ? f : f.slice(o.length + 1);
    if (ENTRY.some(re => re.test(rel))) entries.add(f);
  }
  return { patterns, modules, entrypoints: [...entries].slice(0, 40) };
}

export async function analyze(root, files) {
  const warnings = [];
  const c = collector();
  const set = new Set(files);

  const manifestFiles = files.filter(f => MANIFESTS.some(([re]) => re.test(basename(f)))).slice(0, 400);
  const parsed = await pool(manifestFiles, 16, async f => {
    const text = await readText(root, f);
    if (text === null) return null;
    const [, eco, parse] = MANIFESTS.find(([re]) => re.test(basename(f)));
    const data = parse(text, f);
    return data && { f, eco, data };
  });

  const groups = new Map();
  for (const x of parsed) {
    if (!x) continue;
    const dir = posix.dirname(x.f);
    const k = `${dir}\0${x.eco}`;
    if (!groups.has(k)) {
      groups.set(k, { path: dir, ecosystem: x.eco, manifests: [], deps: {}, src: {}, runtime: {}, entries: [], hints: [], aux: dir !== "." && AUX.test(dir) });
    }
    const p = groups.get(k);
    const d = x.data;
    p.manifests.push(x.f);
    p.name ??= d.name;
    p.version ??= d.version;
    for (const [dep, ver] of Object.entries(d.deps ?? {})) {
      p.deps[dep] ??= ver;
      p.src[dep] ??= x.f;
    }
    for (const [a, b] of Object.entries(d.runtime ?? {})) p.runtime[a] ??= b;
    p.scripts ??= d.scripts;
    p.workspaces ??= d.workspaces;
    p.entries.push(...(d.entries ?? []));
    p.hints.push(...(d.hints ?? []).map(h => [...h, x.f]));
  }

  let pkgs = [...groups.values()].sort((a, b) => a.path.localeCompare(b.path) || a.ecosystem.localeCompare(b.ecosystem));
  if (pkgs.length > MAX_PACKAGES) {
    warnings.push(`packages truncated at ${MAX_PACKAGES} of ${pkgs.length}`);
    pkgs = [...pkgs.filter(p => !p.aux), ...pkgs.filter(p => p.aux)].slice(0, MAX_PACKAGES);
  }
  const live = pkgs.filter(p => !p.aux);

  for (const p of live) {
    p.frameworks = [];
    p.tools = [];
    for (const [dep, ver] of Object.entries(p.deps)) {
      for (const [kind, name] of matchDep(norm(dep))) {
        c.add(kind, name, "dep", `${p.src[dep]}:${dep}`, ver, p.path);
        if (kind === "framework") p.frameworks.push(name);
        else if (kind === "build" || kind === "test" || kind === "lint") p.tools.push(name);
      }
    }
    for (const [kind, name, detail, file] of p.hints) {
      c.add(kind, name, "file", detail ? `${file}#${detail}` : file, undefined, p.path);
      if (kind === "build" || kind === "test" || kind === "lint") p.tools.push(name);
    }
    p.frameworks = [...new Set(p.frameworks)];
    p.tools = [...new Set(p.tools)];
  }

  for (const f of files) {
    const d = posix.dirname(f);
    if (d !== "." && AUX.test(d)) continue;
    for (const [kind, name, re] of FILE_RULES) if (re.test(f)) c.add(kind, name, "file", f);
  }

  const counts = new Map();
  for (const f of files) {
    const l = LANGS[ext(f)];
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...counts]
    .map(([name, n]) => {
      const mk = LANG_MARKERS[name];
      const marker = mk && (files.find(f => mk.files.test(f)) ?? (mk.deps && live.some(p => mk.deps.some(d => d in p.deps)) ? `dependency:${mk.deps[0]}` : undefined));
      return {
        name,
        files: n,
        confidence: +Math.min(1, 0.5 + (marker ? 0.3 : 0) + Math.min(0.2, n / total)).toFixed(2),
        evidence: [`${n} files`, marker].filter(Boolean),
      };
    })
    .sort((a, b) => b.files - a.files)
    .slice(0, 12);

  const ws = [];
  for (const [file, name] of [["pnpm-workspace.yaml", "pnpm-workspace"], ["lerna.json", "lerna"], ["turbo.json", "turborepo"], ["nx.json", "nx"], ["go.work", "go-work"]]) {
    if (set.has(file)) ws.push(name);
  }
  const WS = { node: "node-workspaces", rust: "cargo-workspace", java: "maven-modules" };
  for (const p of live) if (p.path === "." && p.workspaces?.length && WS[p.ecosystem]) ws.push(WS[p.ecosystem]);
  const gs = files.find(f => /^settings\.gradle(\.kts)?$/.test(f));
  if (gs && /^\s*include\b/m.test((await readText(root, gs)) ?? "")) ws.push("gradle-multiproject");
  const dirs = new Set(live.map(p => p.path));
  const layout = ws.length ? "workspace" : dirs.size > 1 ? "multi-package" : "single";

  const runtimes = {};
  for (const p of live) for (const [k, v] of Object.entries(p.runtime)) runtimes[k] ??= v;
  for (const [file, key] of Object.entries(VERSION_FILES)) {
    if (!set.has(file)) continue;
    const t = (await readText(root, file, 1024))?.trim().replace(/^v/, "");
    if (t) runtimes[key] ??= t;
  }
  if (set.has(".tool-versions")) {
    for (const l of ((await readText(root, ".tool-versions", 4096)) ?? "").split(/\r?\n/)) {
      const [k, v] = l.trim().split(/\s+/);
      if (TOOL_VERSIONS[k] && v) runtimes[TOOL_VERSIONS[k]] ??= v;
    }
  }

  const sorted = live.map(p => p.path).filter(p => p !== ".").sort((a, b) => b.length - a.length);
  const owner = f => sorted.find(d => f === d || f.startsWith(`${d}/`)) ?? ".";

  const nz = a => (a.length ? a : undefined);
  const packages = pkgs.map(p =>
    p.aux
      ? { path: p.path, ecosystem: p.ecosystem, name: p.name, aux: true }
      : {
          path: p.path,
          ecosystem: p.ecosystem,
          name: p.name,
          version: p.version,
          manifests: p.manifests,
          dependencyCount: Object.keys(p.deps).length,
          frameworks: nz(p.frameworks),
          tools: nz(p.tools),
        },
  );

  const root0 = live.find(p => p.path === "." && p.name);
  return {
    project: { name: root0?.name ?? basename(root), root, isMonorepo: layout !== "single", layout, workspace: ws, ecosystems: [...new Set(live.map(p => p.ecosystem))] },
    languages,
    packages,
    runtimes,
    architecture: architecture({ files, set, live, owner, ws, layout }),
    warnings,
    pkgs,
    owner,
    has: f => set.has(f),
    add: c.add,
    report: () => ({
      frameworks: c.list("framework", true),
      toolchain: {
        packageManagers: c.list("pm"),
        runtimes,
        buildTools: c.list("build"),
        testTools: c.list("test"),
        lintTools: c.list("lint"),
      },
      infrastructure: {
        databases: c.list("db"),
        containers: c.list("container"),
        ci: c.list("ci"),
        deployment: c.list("deploy"),
      },
    }),
  };
}
