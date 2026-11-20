export interface Finding {
  name: string;
  version?: string;
  confidence: number;
  evidence: string[];
  packages?: string[];
}

export interface Pattern {
  name: string;
  confidence: number;
  evidence: string[];
}

export interface PackageInfo {
  path: string;
  ecosystem: string;
  name?: string;
  version?: string;
  manifests?: string[];
  dependencyCount?: number;
  frameworks?: string[];
  tools?: string[];
  aux?: boolean;
}

export interface GitInfo {
  available: boolean;
  root?: string;
  branch?: string;
  head?: string;
  base?: string | null;
  mergeBase?: string;
  recentCommits?: { hash: string; author: string; date: string; subject: string }[];
  changedFiles: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  numstat: Record<string, [number, number]>;
  stats: { files: number; additions: number; deletions: number };
  affectedPackages?: string[];
  truncated?: boolean;
}

export interface ProjectProfile {
  schemaVersion: string;
  project: {
    name: string;
    root: string;
    isMonorepo: boolean;
    layout: "single" | "workspace" | "multi-package";
    workspace: string[];
    ecosystems: string[];
  };
  languages?: { name: string; files: number; confidence: number; evidence: string[] }[];
  packages?: PackageInfo[];
  frameworks?: Finding[];
  toolchain?: {
    packageManagers: Finding[];
    runtimes: Record<string, string>;
    buildTools: Finding[];
    testTools: Finding[];
    lintTools: Finding[];
  };
  architecture?: { patterns: Pattern[]; modules: string[]; entrypoints: string[] };
  infrastructure?: { databases: Finding[]; containers: Finding[]; ci: Finding[]; deployment: Finding[] };
  git?: GitInfo;
  deep?: Record<string, unknown>;
  scan: {
    depth: "quick" | "deep";
    profile: string;
    scope?: string[];
    completed: boolean;
    files: number;
    excludedCount: number;
    warnings: string[];
    durationMs: number;
  };
}

export interface FileInfo {
  path: string;
  language?: string;
  lines?: number;
  skipped?: boolean;
  exports?: string[];
  local?: string[];
  external?: string[];
  importedBy?: { count: number; files: string[] };
}

export interface InspectResult {
  schemaVersion: string;
  root: string;
  paths: string[];
  files: FileInfo[];
  external: string[];
  warnings: string[];
}

export type ProfileName = "default" | "code-review" | "bug-fixing" | "refactor" | "test-generation" | "documentation";

export interface ScanOptions {
  root?: string;
  depth?: "quick" | "deep";
  profile?: ProfileName;
  sections?: string[];
  scope?: string[];
  base?: string;
  git?: boolean;
  maxFiles?: number;
}

export interface InspectOptions {
  root?: string;
  paths: string[];
  refs?: boolean;
  limit?: number;
  maxFiles?: number;
}

export const SCHEMA_VERSION: string;
export const PROFILES: Record<ProfileName, { depth: "quick" | "deep"; git: boolean; sections: string[] | null }>;
export function scan(options?: ScanOptions): Promise<ProjectProfile>;
export function inspect(options: InspectOptions): Promise<InspectResult>;
export function git(options?: { root?: string; base?: string }): Promise<GitInfo>;
export function render(kind: "scan" | "inspect" | "git", data: unknown): string;
