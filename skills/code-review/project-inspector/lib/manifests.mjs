import { posix } from "node:path";

const json = t => {
  try {
    return JSON.parse(t.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
};

const rt = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

const sections = t => {
  const out = {};
  let cur = "";
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*$/);
    if (m) {
      cur = m[1];
      out[cur] ??= [];
    } else (out[cur] ??= []).push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join("\n")]));
};

const tomlStr = (body, key) => body?.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1];

const arrayAt = (body, key) => {
  const m = body?.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[`, "m"));
  if (!m) return "";
  let i = m.index + m[0].length;
  let depth = 1;
  let q = "";
  let out = "";
  for (; i < body.length && depth; i++) {
    const c = body[i];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    if (depth) out += c;
  }
  return out;
};

const strings = b => [...(b ?? "").replace(/\{[^}]*\}/g, "").matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
const pyname = s => s.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0];
const pyspec = s => s.match(/(?:[=<>~!]=?|@)\s*([^\s;,]+)/)?.[1];

const PM = { pnpm: "pnpm", npm: "npm", yarn: "Yarn", bun: "Bun" };

const node = t => {
  const j = json(t);
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const ws = Array.isArray(j.workspaces) ? j.workspaces : j.workspaces?.packages;
  const bin = typeof j.bin === "string" ? [j.bin] : Object.values(j.bin ?? {});
  const hints = [];
  const pm = typeof j.packageManager === "string" ? PM[j.packageManager.split("@")[0]] : undefined;
  if (pm) hints.push(["pm", pm, "packageManager"]);
  if (j.eslintConfig) hints.push(["lint", "ESLint", "eslintConfig"]);
  if (j.prettier) hints.push(["lint", "Prettier", "prettier"]);
  if (j.jest) hints.push(["test", "Jest", "jest"]);
  return {
    name: j.name,
    version: j.version,
    deps: { ...j.peerDependencies, ...j.optionalDependencies, ...j.devDependencies, ...j.dependencies },
    runtime: rt({ node: j.engines?.node }),
    scripts: j.scripts,
    workspaces: ws,
    entries: [j.main, j.module, ...bin].filter(e => typeof e === "string"),
    hints,
  };
};

const PY_TOOLS = [
  [/^tool\.ruff/, "lint", "Ruff"],
  [/^tool\.black/, "lint", "Black"],
  [/^tool\.mypy/, "lint", "mypy"],
  [/^tool\.pytest/, "test", "pytest"],
  [/^tool\.poetry$/, "pm", "Poetry"],
  [/^tool\.uv/, "pm", "uv"],
];

const pyproject = t => {
  const s = sections(t);
  const meta = s.project ?? s["tool.poetry"];
  const deps = {};
  const add = str => {
    const n = pyname(str);
    if (n) deps[n] = pyspec(str) ?? "";
  };
  strings(arrayAt(s.project, "dependencies")).forEach(add);
  strings(arrayAt(s["tool.uv"], "dev-dependencies")).forEach(add);
  let python = tomlStr(s.project, "requires-python");
  for (const [k, b] of Object.entries(s)) {
    if (k === "project.optional-dependencies" || k === "dependency-groups") strings(b).forEach(add);
    else if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(k)) {
      for (const m of b.matchAll(/^\s*([A-Za-z0-9][\w.-]*)\s*=\s*(?:"([^"]*)"|\{[^}\n]*?version\s*=\s*"([^"]*)")?/gm)) {
        if (m[1] === "python") python ??= m[2];
        else deps[m[1]] = m[2] ?? m[3] ?? "";
      }
    }
  }
  const hints = [];
  for (const k of Object.keys(s)) for (const [re, kind, name] of PY_TOOLS) if (re.test(k)) hints.push([kind, name, k]);
  return { name: tomlStr(meta, "name"), version: tomlStr(meta, "version"), deps, runtime: rt({ python }), hints };
};

const requirements = t => {
  const deps = {};
  for (const l of t.split(/\r?\n/)) {
    const s = l.trim();
    if (!s || /^[#-]/.test(s) || s.includes("://")) continue;
    const n = pyname(s);
    if (n) deps[n] = pyspec(s) ?? "";
  }
  return { deps };
};

const gomod = t => {
  const deps = {};
  for (const m of t.matchAll(/^\s*(?:require\s+)?([\w.~-]+\.[\w.~/-]+)\s+(v[\w.+-]+)(?!.*=>)/gm)) deps[m[1]] = m[2];
  return { name: t.match(/^module\s+(\S+)/m)?.[1], deps, runtime: rt({ go: t.match(/^go\s+(\S+)/m)?.[1] }) };
};

const DEPS_SECTION = /^((workspace|target\..+)\.)?(dev-|build-)?dependencies$/;
const DEPS_TABLE = /^((workspace|target\..+)\.)?(dev-|build-)?dependencies\.([\w-]+)$/;

const cargo = t => {
  const s = sections(t);
  const deps = {};
  for (const [k, b] of Object.entries(s)) {
    if (DEPS_SECTION.test(k)) {
      for (const m of b.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|\{[^}\n]*?version\s*=\s*"([^"]*)")?/gm)) {
        deps[m[1]] = m[2] ?? m[3] ?? "";
      }
    } else {
      const d = k.match(DEPS_TABLE);
      if (d) deps[d[4]] = tomlStr(b, "version") ?? "";
    }
  }
  return {
    name: tomlStr(s.package, "name"),
    version: tomlStr(s.package, "version"),
    deps,
    runtime: rt({ rust: tomlStr(s.package, "rust-version") }),
    workspaces: strings(arrayAt(s.workspace, "members")),
  };
};

const pom = t => {
  const x = t.replace(/<!--[\s\S]*?-->/g, "");
  const tag = (s, n) => s.match(new RegExp(`<${n}>\\s*([^<]+?)\\s*</${n}>`))?.[1];
  const parent = x.match(/<parent>[\s\S]*?<\/parent>/)?.[0] ?? "";
  const deps = {};
  for (const d of [parent, ...(x.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [])]) {
    const g = tag(d, "groupId");
    const a = tag(d, "artifactId");
    if (g && a) deps[`${g}:${a}`] = tag(d, "version") ?? "";
  }
  const body = x.replace(parent, "");
  const java = tag(x, "java\\.version") ?? tag(x, "maven\\.compiler\\.release") ?? tag(x, "maven\\.compiler\\.source");
  return {
    name: tag(body, "artifactId"),
    version: tag(body, "version"),
    deps,
    runtime: rt({ java }),
    workspaces: [...x.matchAll(/<module>([^<]+)<\/module>/g)].map(m => m[1]),
  };
};

const gradle = t => {
  const deps = {};
  for (const m of t.matchAll(/["']([\w.-]+):([\w.-]+)(?::([\w.${}-]+))?["']/g)) deps[`${m[1]}:${m[2]}`] = m[3] ?? "";
  for (const m of t.matchAll(/\bid\s*\(?\s*["']([\w.-]+)["']/g)) deps[`plugin:${m[1]}`] = "";
  const j = t.match(/JavaLanguageVersion\.of\((\d+)\)|VERSION_(\d+)|jvmTarget\s*=\s*["'](\d+)/);
  return { deps, runtime: rt({ java: j?.[1] ?? j?.[2] ?? j?.[3] }) };
};

const csproj = (t, f) => {
  const deps = {};
  const sdk = t.match(/<Project[^>]*\bSdk="([^"]+)"/)?.[1];
  if (sdk) deps[`sdk:${sdk}`] = "";
  for (const m of t.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]*)")?/g)) deps[m[1]] = m[2] ?? "";
  return {
    name: posix.basename(f).replace(/\.csproj$/, ""),
    deps,
    runtime: rt({ dotnet: t.match(/<TargetFrameworks?>([^<]+)</)?.[1] }),
  };
};

const composer = t => {
  const j = json(t);
  if (!j || typeof j !== "object") return null;
  return { name: j.name, version: j.version, deps: { ...j["require-dev"], ...j.require }, runtime: rt({ php: j.require?.php }) };
};

const gemfile = t => {
  const deps = {};
  for (const m of t.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) deps[m[1]] = m[2] ?? "";
  return { deps };
};

export const MANIFESTS = [
  [/^package\.json$/, "node", node],
  [/^pyproject\.toml$/, "python", pyproject],
  [/^requirements[\w.-]*\.txt$/, "python", requirements],
  [/^go\.mod$/, "go", gomod],
  [/^Cargo\.toml$/, "rust", cargo],
  [/^pom\.xml$/, "java", pom],
  [/^build\.gradle(\.kts)?$/, "java", gradle],
  [/\.csproj$/, "dotnet", csproj],
  [/^composer\.json$/, "php", composer],
  [/^Gemfile$/, "ruby", gemfile],
];
