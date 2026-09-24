import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Connect, ModuleNode, Plugin, ViteDevServer } from "vite";

const execFileAsync = promisify(execFile);

const ENDPOINT = "/__superdev/compile-check";
const DEFAULT_ENTRY = "/src/main.tsx";
const MODULE_LIMIT = 2000;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_ERRORS = 20;
// Enough to identify what went wrong; caps the response on a pathological worktree.
const DIRTY_PATH_LIMIT = 10;

interface CompileCheckRequest {
  expectedCommitSha?: string;
  changedPaths?: string[];
}

interface CompileError {
  file: string | null;
  message: string;
  line?: number;
  column?: number;
  plugin?: string;
}

interface CompileCheckResult {
  status: "clean" | "failed" | "indeterminate";
  reason?: string;
  /** Non-allowed dirty worktree paths when reason is "dirty_worktree". */
  dirtyPaths?: string[];
  errors: CompileError[];
  modulesChecked: number;
  durationMs: number;
  headSha: string | null;
}

/**
 * Dev-only compile probe for the Buildy platform.
 *
 * POST /__superdev/compile-check (loopback only — reached via the machine's
 * proxy server) compiles the app's reachable module graph through the running
 * dev server's own transform pipeline and reports any compile error exactly as
 * the browser would hit it. "clean" is only returned when the full graph
 * transformed without error AND git HEAD matched the expected commit, with a
 * clean worktree, before and after the crawl; anything ambiguous is
 * "indeterminate", never "failed".
 */
export function superdevCompileCheck(): Plugin {
  // Serialize probes — concurrent crawls would double CPU work on a small VM
  // and interleave module invalidation.
  let probeChain: Promise<unknown> = Promise.resolve();

  return {
    name: "superdev-compile-check",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(ENDPOINT, (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        if (!isLoopback(req)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        const run = async () => {
          const body = await readJsonBody(req);
          return runProbe(server, body);
        };

        const queued = probeChain.then(run, run);
        probeChain = queued.catch(() => {});

        queued
          .then((result) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(result));
          })
          .catch((err: unknown) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            const fallback: CompileCheckResult = {
              status: "indeterminate",
              reason: `probe_crashed: ${err instanceof Error ? err.message : String(err)}`,
              errors: [],
              modulesChecked: 0,
              durationMs: 0,
              headSha: null,
            };
            res.end(JSON.stringify(fallback));
          });
      });
    },
  };
}

function isLoopback(req: Connect.IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

async function readJsonBody(
  req: Connect.IncomingMessage
): Promise<CompileCheckRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function gitHeadSha(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The uncommitted worktree paths outside the platform's .tmp staging dir and
 * the exact paths the trusted caller asked this probe to validate. The latter
 * allows the first-run runtime compatibility files to be compiled before Buildy
 * pushes their commit. Empty means clean.
 *
 * Returns the paths rather than a boolean so a caller that decides to continue
 * past "dirty_worktree" can still log what was dirty — the reason alone names
 * no file, which made the first occurrence of this undiagnosable.
 */
async function gitWorktreeDirtyPaths(
  root: string,
  allowedDirtyPaths: string[] = []
): Promise<string[]> {
  const allowed = new Set(
    allowedDirtyPaths
      .map((value) => value.replace(/^\.\//, ""))
      .filter(
        (value) =>
          value.length > 0 &&
          !value.startsWith("/") &&
          !value.split("/").includes("..")
      )
  );
  try {
    // --untracked-files=all matches how the caller builds allowedDirtyPaths.
    // Without it an untracked directory collapses to "dir/", which can never
    // equal an allow-listed "dir/file.ts".
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: root, timeout: 5000 }
    );
    // Porcelain lines are "XY path"; path starts at index 3. Ignore the .tmp/
    // staging dir only — match the directory exactly or as a path prefix so a
    // real worktree file merely named ".tmp*" still counts as dirty.
    return stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3).split(" -> ").at(-1) ?? "")
      .filter(
        (p) =>
          !(
            p === ".tmp" ||
            p.startsWith(".tmp/") ||
            allowed.has(p)
          )
      )
      .slice(0, DIRTY_PATH_LIMIT);
  } catch {
    return ["<git status failed>"];
  }
}

/**
 * Transient dev-server conditions that surface as transform exceptions but
 * are not compile errors in the user's code: outdated pre-bundled deps and a
 * server mid-restart/close. These must never produce a "failed" verdict.
 */
const TRANSIENT_ERROR_REGEX =
  /outdated optimize dep|outdated dep|server is being restarted|server is closed|ERR_OUTDATED_OPTIMIZED_DEP|ERR_CLOSED_SERVER|ERR_OPTIMIZE_DEPS_PROCESSING_ERROR|ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR/i;

function isTransientViteError(err: unknown): boolean {
  const e = (err ?? {}) as { message?: string; code?: string };
  if (typeof e.code === "string" && TRANSIENT_ERROR_REGEX.test(e.code)) {
    return true;
  }
  return typeof e.message === "string" && TRANSIENT_ERROR_REGEX.test(e.message);
}

async function runProbe(
  server: ViteDevServer,
  body: CompileCheckRequest
): Promise<CompileCheckResult> {
  const startedAt = Date.now();
  const root = server.config.root;
  const headBefore = await gitHeadSha(root);
  const done = (
    status: CompileCheckResult["status"],
    extra: Partial<CompileCheckResult> = {}
  ): CompileCheckResult => ({
    status,
    errors: [],
    modulesChecked: 0,
    durationMs: Date.now() - startedAt,
    headSha: headBefore,
    ...extra,
  });
  if (body.expectedCommitSha && headBefore !== body.expectedCommitSha) {
    return done("indeterminate", { reason: "stale_head" });
  }
  const dirtyBefore = await gitWorktreeDirtyPaths(root, body.changedPaths);
  if (dirtyBefore.length > 0) {
    return done("indeterminate", {
      reason: "dirty_worktree",
      dirtyPaths: dirtyBefore,
    });
  }

  // Explicitly invalidate modules for paths the commit touched so the result
  // never depends on filesystem-watcher timing.
  for (const changed of body.changedPaths ?? []) {
    const abs = path.resolve(root, changed);
    if (!abs.startsWith(root)) continue;
    const mods = server.moduleGraph.getModulesByFile(abs);
    if (!mods) continue;
    const seen = new Set<ModuleNode>();
    for (const mod of mods) {
      server.moduleGraph.invalidateModule(mod, seen);
    }
  }

  const entry = await resolveEntryUrl(root);
  const errors: CompileError[] = [];
  const visited = new Set<string>();
  const queue: string[] = [entry];
  const deadline = startedAt + PROBE_TIMEOUT_MS;
  let timedOut = false;
  let sawTransientError = false;

  while (queue.length > 0) {
    if (visited.size >= MODULE_LIMIT) break;
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      await server.transformRequest(url);
    } catch (err) {
      if (isTransientViteError(err)) {
        sawTransientError = true;
        continue;
      }
      errors.push(normalizeError(err, root));
      if (errors.length >= MAX_ERRORS) break;
      continue;
    }

    let mod: ModuleNode | undefined;
    try {
      mod = await server.moduleGraph.getModuleByUrl(url);
    } catch {
      continue;
    }
    if (!mod) continue;
    for (const dep of mod.importedModules) {
      const depUrl = dep.url;
      if (!depUrl || visited.has(depUrl) || shouldSkipUrl(depUrl)) continue;
      queue.push(depUrl);
    }
  }

  const headAfter = await gitHeadSha(root);
  if (headBefore !== headAfter) {
    return done("indeterminate", {
      reason: "head_moved",
      modulesChecked: visited.size,
    });
  }
  // A worktree gone dirty mid-crawl invalidates everything seen — including
  // errors, which may belong to half-applied content rather than the commit.
  const dirtyAfter = await gitWorktreeDirtyPaths(root, body.changedPaths);
  if (dirtyAfter.length > 0) {
    return done("indeterminate", {
      reason: "dirty_worktree",
      dirtyPaths: dirtyAfter,
      modulesChecked: visited.size,
    });
  }

  // Real errors are trustworthy even if the crawl didn't finish; a clean
  // result from a partial crawl is not.
  if (errors.length > 0) {
    return done("failed", { errors, modulesChecked: visited.size });
  }
  if (sawTransientError) {
    return done("indeterminate", {
      reason: "vite_transient",
      modulesChecked: visited.size,
    });
  }
  if (timedOut) {
    return done("indeterminate", {
      reason: "timeout",
      modulesChecked: visited.size,
    });
  }
  if (visited.size >= MODULE_LIMIT) {
    return done("indeterminate", {
      reason: "module_limit",
      modulesChecked: visited.size,
    });
  }
  return done("clean", { modulesChecked: visited.size });
}

/** Read the entry script URL from index.html, falling back to /src/main.tsx. */
async function resolveEntryUrl(root: string): Promise<string> {
  try {
    const html = await fs.readFile(path.join(root, "index.html"), "utf-8");
    // Accept either quote style so a single-quoted entry script still resolves
    // (otherwise we'd silently probe the /src/main.tsx fallback instead).
    const match = html.match(/<script[^>]+src=(["'])(\/src\/[^"']+)\1/);
    if (match) return match[2];
  } catch {
    // fall through
  }
  return DEFAULT_ENTRY;
}

/**
 * Skip module URLs that aren't user code: pre-bundled/installed dependencies,
 * Vite-internal client modules, plugin virtual modules, and external URLs.
 * Errors in user code that *imports* these still surface when the importer is
 * transformed (unresolvable specifiers throw there).
 */
function shouldSkipUrl(url: string): boolean {
  if (url.startsWith("\0") || url.includes("\0")) return true;
  if (url.startsWith("/@")) return true; // /@vite/, /@react-refresh, /@fs/, /@id/
  if (url.includes("node_modules")) return true;
  if (/^[a-z]+:\/\//i.test(url)) return true;
  return false;
}

interface ViteErrorLike {
  message?: string;
  id?: string;
  plugin?: string;
  loc?: { file?: string; line?: number; column?: number };
}

function normalizeError(err: unknown, root: string): CompileError {
  const e = (err ?? {}) as ViteErrorLike;
  const rawFile = e.loc?.file ?? e.id ?? null;
  const file = rawFile
    ? path.isAbsolute(rawFile)
      ? path.relative(root, rawFile)
      : rawFile
    : null;
  return {
    file,
    message:
      typeof e.message === "string" && e.message.length > 0
        ? e.message
        : String(err),
    line: e.loc?.line,
    column: e.loc?.column,
    plugin: e.plugin,
  };
}
