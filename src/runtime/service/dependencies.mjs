// @ts-check

import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const SYSTEM_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export class ServiceDependencyError extends Error {}

/** Pure default for serialization; install supplies the fully selected paths.
 * @param {Record<string, any>} [deps] */
export function serviceEnvironment(deps = {}) {
  const nodePath = deps.nodePath || process.execPath;
  const larkCli = deps.larkCli || (deps.env || process.env).LARK_CLI || "/opt/homebrew/bin/lark-cli";
  const directories = [nodePath, deps.sqlitePath, deps.pythonPath, larkCli].filter(Boolean).map((path) => dirname(path));
  return { PATH: [...new Set([...directories, ...SYSTEM_PATH.split(":")])].join(":"), LARK_CLI: larkCli };
}

/** @param {string} path @param {Record<string, any>} deps */
function executable(path, deps) {
  try {
    (deps.accessSync || accessSync)(path, constants.X_OK);
    return (deps.statSync || statSync)(path).isFile();
  } catch { return false; }
}

/** Shell-free executable lookup, including relative caller PATH entries.
 * @param {string} command @param {string} path @param {string} cwd @param {Record<string, any>} deps */
function findExecutable(command, path, cwd, deps) {
  const candidates = command.includes("/") ? [resolve(cwd, command)]
    : path.split(":").map((directory) => resolve(cwd, directory || ".", command));
  return candidates.find((candidate) => executable(candidate, deps));
}

/** @param {string} name @param {string | undefined} path */
function required(name, path) {
  if (!path || !isAbsolute(path) || dirname(path).includes(":")) {
    throw new ServiceDependencyError(`service dependency ${name} is unavailable; select an executable in an absolute, PATH-compatible directory`);
  }
  return path;
}

/** Resolve the operator's choices without executing lark-cli or shell startup.
 * @param {Record<string, any>} [deps] */
export function resolveServiceDependencies(deps = {}) {
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const callerPath = env.PATH ?? SYSTEM_PATH;
  const selectedNode = deps.nodePath || process.execPath;
  const nodePath = required("node", isAbsolute(selectedNode) && executable(selectedNode, deps) ? selectedNode : undefined);
  const larkCli = required("lark-cli", findExecutable(deps.larkCli || env.LARK_CLI || "lark-cli", callerPath, cwd, deps));
  const sqlitePath = required("sqlite3", findExecutable("sqlite3", callerPath, cwd, deps));
  const pythonPath = required("python3", findExecutable("python3", callerPath, cwd, deps));
  const selected = { nodePath, larkCli, sqlitePath, pythonPath };
  const environment = serviceEnvironment(selected);
  for (const [name, path] of [["node", nodePath], ["sqlite3", sqlitePath], ["python3", pythonPath]]) {
    const resolved = findExecutable(name, environment.PATH, cwd, deps);
    let same = false;
    try { same = Boolean(resolved) && (deps.realpathSync || realpathSync)(resolved) === (deps.realpathSync || realpathSync)(path); }
    catch { /* Missing/changing executables cannot establish identity. */ }
    if (!same) throw new ServiceDependencyError(`service PATH changes the selected ${name}; use dependency directories without conflicting command names`);
  }
  return { ...selected, serviceEnvironment: environment };
}

/** @param {unknown} version @param {number[]} minimum */
function versionAtLeast(version, minimum) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const parts = version.split(".").map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}

/** Fixed local probes: output is inspected internally and never exposed.
 * @param {ReturnType<typeof resolveServiceDependencies>} selected
 * @param {Record<string, any>} [deps] */
export function verifyServiceDependencies(selected, deps = {}) {
  /** @param {string} command @param {string[]} args @param {string} requirement */
  function probe(command, args, requirement) {
    try {
      const result = (deps.dependencySpawnSync || deps.spawnSync || spawnSync)(command, args, {
        encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
        env: selected.serviceEnvironment,
      });
      if (result.status === 0 && !result.error && !result.signal) return JSON.parse(String(result.stdout));
    } catch { /* Bound all dependency failures, including malformed output. */ }
    throw new ServiceDependencyError(requirement);
  }
  const nodeRequirement = "service requires Node.js 22+ under the selected PATH and isolated initialization";
  const node = probe(selected.nodePath, ["-e", "process.stdout.write(JSON.stringify({version:process.versions.node}))"], nodeRequirement);
  if (!versionAtLeast(node?.version, [22, 0, 0])) throw new ServiceDependencyError(nodeRequirement);

  const sqliteRequirement = "service requires SQLite CLI 3.35+ with JSON, MATERIALIZED, RETURNING and readonly support under the selected PATH and isolated initialization";
  const sqlite = probe(selected.sqlitePath, ["-init", "/dev/null", "-batch", "-bail", "-json", ":memory:",
    `CREATE TABLE service_probe(value INTEGER);
WITH input AS MATERIALIZED (SELECT json_extract('{"value":1}', '$.value') AS value)
INSERT INTO service_probe SELECT value FROM input RETURNING value, sqlite_version() AS version;`], sqliteRequirement);
  if (!Array.isArray(sqlite) || sqlite.length !== 1 || sqlite[0]?.value !== 1 || !versionAtLeast(sqlite[0]?.version, [3, 35, 0])) {
    throw new ServiceDependencyError(sqliteRequirement);
  }
  const readonly = probe(selected.sqlitePath, ["-init", "/dev/null", "-batch", "-bail", "-readonly", "-json", ":memory:", "SELECT 1 AS ready;"], sqliteRequirement);
  if (!Array.isArray(readonly) || readonly.length !== 1 || readonly[0]?.ready !== 1) throw new ServiceDependencyError(sqliteRequirement);

  const pythonRequirement = "service requires Python 3.9+ with fcntl, nonblocking descriptors and SQLite JSON/schema support under the selected PATH and isolated initialization";
  const python = probe(selected.pythonPath, ["-I", "-S", "-c", `import fcntl, json, os, sqlite3, sys
assert callable(fcntl.flock)
r, w = os.pipe()
try:
    os.set_blocking(r, False)
    assert not os.get_blocking(r)
finally:
    os.close(r)
    os.close(w)
with sqlite3.connect(":memory:") as connection:
    assert connection.execute("SELECT json_extract('{\\"ready\\":1}', '$.ready')").fetchone() == (1,)
    assert connection.execute("SELECT count(*) FROM sqlite_schema").fetchone() == (0,)
print(json.dumps({"ready": 1, "version": ".".join(map(str, sys.version_info[:3]))}))`], pythonRequirement);
  if (python?.ready !== 1 || !versionAtLeast(python?.version, [3, 9, 0])) throw new ServiceDependencyError(pythonRequirement);
}
