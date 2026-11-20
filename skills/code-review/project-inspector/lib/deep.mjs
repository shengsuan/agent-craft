import { posix } from "node:path";
import { readText, pool } from "./fsx.mjs";
import { LANGS, ext } from "./rules.mjs";

const SECRET = /((?:api[_-]?key|secret|token|passw(?:or)?d|auth|credential|private[_-]?key|access[_-]?key)[\w-]*\s*[=:]\s*)(["']?)[^\s"']+\2/gi;

export const redact = s =>
  String(s)
    .replace(SECRET, "$1[REDACTED]")
    .replace(/\b(?:ghp|gho|ghs|github_pat|sk|pk|xox[abp]|AKIA)[-_A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\/\/[^\s/:@]+:[^\s/@]+@/g, "//[REDACTED]@");

export const parseJsonc = t => {
  t = t.replace(/^\uFEFF/, "");
  let o = "";
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    const n = t[i + 1];
    if (q) {
      o += c;
      if (c === "\\") o += t[++i] ?? "";
      else if (c === '"') q = false;
    } else if (c === '"') {
      q = true;
      o += c;
    } else if (c === "/" && n === "/") {
      while (i < t.length && t[i] !== "\n") i++;
      o += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) i++;
      i++;
    } else o += c;
  }
  try {
    return JSON.parse(o.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
};

const TEST = [/(^|\/)(tests?|__tests__|e2e|spec)\//, /\.(test|spec)\.[cm]?[jt]sx?$/, /_test\.(go|py|rs)$/, /(^|\/)test_[^/]+\.py$/, /Tests?\.(java|kt|cs)$/, /_spec\.rb$/];
const ROUTE = [
  /(^|\/)(routes?|controllers?|handlers?|endpoints?|api)\/[^/]+\.(?:[cm]?[jt]sx?|py|go|java|kt|cs|rb|php|rs)$/,
  /(^|\/)app\/(?:.+\/)?(page|route)\.[jt]sx?$/,
  /(^|\/)pages\/api\//,
  /(^|\/)urls\.py$/,
];
const DOCS = /^((README|CONTRIBUTING|ARCHITECTURE|AGENTS|CLAUDE|GEMINI|CHANGELOG)(\.\w+)?|\.github\/copilot-instructions\.md|docs\/[^/]+\.mdx?)$/i;
const COMPOSE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/;
const K8S = /(^|\/)(k8s|kubernetes|manifests?|deploy(ments?)?|charts?)\/.+\.ya?ml$/;
const DB_IMAGES = [
  ["PostgreSQL", /^(postgres|postgis|timescaledb)/],
  ["MySQL", /^mysql/],
  ["MariaDB", /^mariadb/],
  ["MongoDB", /^mongo/],
  ["Redis", /^(redis|valkey)/],
  ["Elasticsearch", /^(elasticsearch|opensearch)/],
  ["ClickHouse", /clickhouse/],
  ["Memcached", /^memcached/],
];

export async function deepScan({ root, files, ctx, scope }) {
  const pkgs = ctx.pkgs.filter(p => !p.aux && (!scope || scope.includes(p.path)));
  const sel = scope ? files.filter(f => scope.includes(ctx.owner(f))) : files;
  const out = {};
  const put = (k, v) => {
    if (v && (Array.isArray(v) ? v.length : typeof v === "object" ? Object.keys(v).length : true)) out[k] = v;
  };

  const scripts = {};
  const deps = {};
  for (const p of pkgs) {
    if (p.scripts && typeof p.scripts === "object") {
      scripts[p.path] = Object.fromEntries(Object.entries(p.scripts).slice(0, 40).map(([k, v]) => [k, redact(v).slice(0, 200)]));
    }
    (deps[p.path] ??= []).push(...Object.keys(p.deps).sort().slice(0, 150));
  }
  put("scripts", scripts);
  put("dependencies", deps);

  const tests = sel.filter(f => LANGS[ext(f)] && TEST.some(r => r.test(f)));
  const byDir = {};
  for (const f of tests) byDir[posix.dirname(f)] = (byDir[posix.dirname(f)] ?? 0) + 1;
  put("tests", tests.length && {
    count: tests.length,
    dirs: Object.entries(byDir).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, n]) => `${d} (${n})`),
  });

  const routes = sel.filter(f => ROUTE.some(r => r.test(f)));
  put("routeFiles", routes.length && { count: routes.length, files: routes.slice(0, 60) });

  put("docs", files.filter(f => DOCS.test(f)).slice(0, 25));

  const envs = {};
  await pool(sel.filter(f => /(^|\/)\.env\.(example|sample|template|dist)$/i.test(f)).slice(0, 8), 4, async f => {
    const t = (await readText(root, f, 65536)) ?? "";
    envs[f] = [...t.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map(m => m[1]).slice(0, 80);
  });
  put("envVars", envs);

  const ts = {};
  await pool(pkgs.filter(p => p.ecosystem === "node").slice(0, 10), 4, async p => {
    const f = p.path === "." ? "tsconfig.json" : `${p.path}/tsconfig.json`;
    if (!ctx.has(f)) return;
    const j = parseJsonc((await readText(root, f)) ?? "");
    if (!j) return;
    const o = j.compilerOptions ?? {};
    ts[p.path] = {
      extends: j.extends,
      target: o.target,
      module: o.module,
      moduleResolution: o.moduleResolution,
      jsx: o.jsx,
      strict: o.strict,
      baseUrl: o.baseUrl,
      paths: o.paths && Object.keys(o.paths),
    };
  });
  put("typescript", ts);

  await pool(sel.filter(f => COMPOSE.test(f)).slice(0, 10), 4, async f => {
    const t = (await readText(root, f)) ?? "";
    for (const [, img] of t.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) {
      const base = img.split("/").pop().split(":")[0].toLowerCase();
      for (const [name, re] of DB_IMAGES) if (re.test(base)) ctx.add("db", name, "file", `${f} image:${img}`);
    }
  });

  await pool(sel.filter(f => K8S.test(f) && !/(^|\/)Chart\.yaml$/.test(f)).slice(0, 30), 4, async f => {
    const t = (await readText(root, f, 65536)) ?? "";
    if (/^apiVersion:/m.test(t) && /^kind:\s*(Deployment|StatefulSet|DaemonSet|CronJob|Ingress|Service)\b/m.test(t) && !t.includes("{{")) {
      ctx.add("deploy", "Kubernetes", "file", f);
    }
  });

  return out;
}
