# project-inspector

Zero-dependency Node.js (>=18.3) analyzer. A deterministic tool collects project facts; the LLM plans and decides what to read next.

```
deterministic facts (this tool)  ->  LLM plan  ->  targeted analysis (inspect)
```

## Use

```bash
node cli.mjs scan                        # quick profile, JSON
node cli.mjs scan -d deep -f md          # deep, compact text
node cli.mjs scan -p code-review         # deep + git, scoped to changed packages
node cli.mjs inspect src/auth src/api    # targeted: exports / imports / importers
node cli.mjs git -b origin/main          # change set against a base
node cli.mjs mcp                         # MCP server on stdio
```

As a library:

```js
import { scan, inspect, git } from "project-inspector";
const profile = await scan({ root, profile: "code-review" });
const detail = await inspect({ root, paths: ["src/auth"] });
```

As a skill: this copy is vendored in `skills/code-review/project-inspector/` and used by the `code-review` skill. Usage notes are in `GUIDE.md`.
As an MCP server: `{ "command": "node", "args": ["/path/cli.mjs", "mcp"] }`.

## Depth

| Level | Command | Reads |
|---|---|---|
| Quick | `scan` | file list (via `git ls-files`, falls back to a filesystem walk), manifests, git state |
| Deep | `scan -d deep` | scripts, tsconfig, test layout, route files, env var names, docs, compose images, k8s manifests, dependency names |
| Targeted | `inspect <paths>` | per-file exports and imports, reverse importers |

## Profiles

`default`, `code-review`, `bug-fixing`, `refactor`, `test-generation`, `documentation`. Each sets the depth, whether git is collected, and which sections are returned. Override with `--sections languages,toolchain`.

## Output

`ProjectProfile` (see `index.d.ts`, `schemaVersion` 2.0). Detections are `{ name, version?, confidence, evidence[] }`. Confidence: dependency 0.9, config file 0.7, both 1.0. Architecture patterns carry their own confidence and evidence.

## Differences from the original proposal

- File listing uses `git ls-files`, so `.gitignore` is honored and large repos scan in milliseconds; no cache is needed.
- Manifests are parsed for dependencies (package.json, pyproject, requirements, go.mod, Cargo, pom, gradle, csproj, composer, Gemfile) and matched with one data table (`lib/rules.mjs`); adding a technology is one line.
- Monorepo handling is per package: each manifest becomes a package with its own frameworks and tools. Examples, docs and fixtures are marked `aux` and excluded from aggregate detection.
- The git section resolves a base branch and merge-base, reports numstat, and maps changed files to affected packages.
- `inspect` adds reverse-import lookup, so impact analysis does not need grep.
- Ships an MCP server and a usage guide (`GUIDE.md`).

## Safety

No project code, package manager or shell script is executed. `.env*`, keys, certificates and credential files are never read. Symlinks are not followed. Paths passed to `inspect` must stay inside the root. Git runs read-only with `core.fsmonitor=false`, and base refs are validated.

## Limits

- Import resolution covers relative JS/TS, Python and Go package imports; tsconfig path aliases (`@/...`) are reported but not resolved.
- Import and export extraction is regex based, not a full AST.
- Python, Cargo and Gradle parsers read the common forms, not every TOML or DSL variation.

## Tests

`npm test` (Node built-in runner, builds a temporary monorepo with git).
