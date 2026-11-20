import { posix } from "node:path";
import { readText, safeRel, pool } from "./fsx.mjs";
import { langOf } from "./rules.mjs";

const all = (t, re) => [...t.matchAll(re)].map(m => m.slice(1).find(Boolean)).filter(Boolean);
const names = s => s.split(",").map(x => x.trim().split(/\s+as\s+/).pop()).filter(Boolean);

const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];

const ANALYZERS = [
  [/\.(?:[cm]?[jt]sx?|vue|svelte)$/, "js", t => ({
    imports: all(t, /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|(?:import|require)\(\s*["']([^"']+)["']\s*\)/g),
    exports: [
      ...all(t, /export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([\w$]+)/g),
      ...(/export\s+default\b/.test(t) ? ["default"] : []),
      ...all(t, /export\s*\{([^}]+)\}/g).flatMap(names),
    ],
  })],
  [/\.py$/, "py", t => ({
    imports: all(t, /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm),
    exports: all(t, /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm),
  })],
  [/\.go$/, "go", t => ({
    imports: [...all(t, /^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm), ...[...t.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)].flatMap(m => all(m[1], /"([^"]+)"/g))],
    exports: [...all(t, /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm), ...all(t, /^type\s+([A-Z]\w*)/gm)],
  })],
  [/\.rs$/, "rs", t => ({
    imports: all(t, /^\s*use\s+([\w:]+)/gm),
    exports: all(t, /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod)\s+(\w+)/gm),
  })],
  [/\.(?:java|kt|cs)$/, "jvm", t => ({
    imports: all(t, /^\s*(?:import|using)\s+(?:static\s+)?([\w.]+)/gm),
    exports: all(t, /^\s*(?:public\s+|internal\s+|open\s+|final\s+|abstract\s+|static\s+|sealed\s+|data\s+)*(?:class|interface|enum|record|object)\s+(\w+)/gm),
  })],
];

const analyzer = f => ANALYZERS.find(([re]) => re.test(f));

const pkgName = s => {
  const p = s.replace(/^node:/, "").split("/");
  return s.startsWith("@") ? p.slice(0, 2).join("/") : p[0];
};

const resolveJs = (from, spec, set) => {
  if (!spec.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  for (const b of new Set([base, base.replace(/\.[cm]?jsx?$/, "")])) {
    const hit = [b, ...JS_EXT.map(e => b + e), ...JS_EXT.map(e => `${b}/index${e}`)].find(c => set.has(c));
    if (hit) return hit;
  }
  return null;
};

const resolvePy = (from, spec, set) => {
  const dots = spec.match(/^\.+/)?.[0].length ?? 0;
  if (!dots) return null;
  let dir = posix.dirname(from);
  for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
  const p = posix.join(dir, spec.slice(dots).replaceAll(".", "/"));
  return [`${p}.py`, `${p}/__init__.py`].find(c => set.has(c)) ?? null;
};

export async function inspectPaths(root, files, paths, { refs = true, maxFiles = 200 } = {}) {
  const warnings = [];
  const targets = [];
  for (const p of paths) {
    const rel = safeRel(root, p);
    if (rel === null) warnings.push(`outside root, skipped: ${p}`);
    else targets.push(rel);
  }
  let sel = files.filter(f => targets.some(t => t === "." || f === t || f.startsWith(`${t}/`)));
  if (!sel.length) warnings.push("no tracked files matched the given paths");
  if (sel.length > maxFiles) {
    warnings.push(`selection truncated at ${maxFiles} of ${sel.length} files`);
    sel = sel.slice(0, maxFiles);
  }
  const all_ = new Set(files);
  const tset = new Set(sel);

  const infos = await pool(sel, 16, async f => {
    const info = { path: f, language: langOf(f) };
    const t = await readText(root, f, 524288);
    if (t === null) return { ...info, skipped: true };
    info.lines = t.split("\n").length;
    const a = analyzer(f);
    if (!a) return info;
    const { imports, exports } = a[2](t);
    const local = new Set();
    const external = new Set();
    for (const s of imports) {
      if (a[1] === "js") {
        if (s.startsWith(".")) local.add(resolveJs(f, s, all_) ?? s);
        else if (/^(@\/|~\/|#)/.test(s)) local.add(s);
        else external.add(pkgName(s));
      } else if (a[1] === "py" && s.startsWith(".")) local.add(resolvePy(f, s, all_) ?? s);
      else external.add(s);
    }
    info.exports = [...new Set(exports)].slice(0, 60);
    info.local = [...local].slice(0, 60);
    info.external = [...external].sort().slice(0, 40);
    return info;
  });

  if (refs && sel.length) {
    const by = {};
    const pyMods = new Map();
    const goDirs = new Map();
    for (const t of sel) {
      if (t.endsWith(".py")) pyMods.set(t.replace(/\.py$/, "").replace(/\/__init__$/, "").replace(/^src\//, "").replaceAll("/", "."), t);
      if (t.endsWith(".go")) goDirs.set(posix.dirname(t), [...(goDirs.get(posix.dirname(t)) ?? []), t]);
    }
    const src = files.filter(analyzer).slice(0, 8000);
    if (files.filter(analyzer).length > 8000) warnings.push("reference scan limited to the first 8000 source files");
    await pool(src, 16, async f => {
      const t = await readText(root, f, 524288);
      const a = t && analyzer(f);
      if (!a) return;
      for (const s of a[2](t).imports) {
        let hits = [];
        if (a[1] === "js") hits = [resolveJs(f, s, tset)];
        else if (a[1] === "py") {
          hits = s.startsWith(".") ? [resolvePy(f, s, tset)] : [...pyMods].filter(([m]) => s === m || s.startsWith(`${m}.`)).map(([, p]) => p);
        } else if (a[1] === "go") {
          hits = [...goDirs].filter(([d]) => s === d || s.endsWith(`/${d}`)).flatMap(([, l]) => l);
        }
        for (const h of hits) if (h && h !== f) (by[h] ??= new Set()).add(f);
      }
    });
    for (const i of infos) {
      const s = by[i.path];
      if (s) i.importedBy = { count: s.size, files: [...s].sort().slice(0, 25) };
    }
  }

  return {
    paths: targets,
    files: infos,
    external: [...new Set(infos.flatMap(i => i.external ?? []))].sort().slice(0, 60),
    warnings,
  };
}
