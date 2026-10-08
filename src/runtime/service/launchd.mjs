// @ts-check

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkerProgramArguments, workerProgramArguments } from "../worker/options.mjs";
import { ServiceDependencyError, resolveServiceDependencies, serviceEnvironment, verifyServiceDependencies } from "./dependencies.mjs";

export const LABEL = "com.exocortex.lark-im-worker";
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export class ServiceOperationError extends Error {}

/** @typedef {Record<string, any>} ServiceDeps */

/** @param {ServiceDeps} [deps] */
export function domain(deps = {}) {
  const id = deps.uid ? deps.uid() : typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
  return `gui/${id}`;
}
/** @param {ServiceDeps} [deps] */
export function target(deps = {}) { return deps.target || `${domain(deps)}/${LABEL}`; }
/** @param {ServiceDeps} [deps] */
export function plistPath(deps = {}) {
  return resolve((deps.homedir || homedir)(), "Library/LaunchAgents", `${LABEL}.plist`);
}

/**
 * Process output stays internal: launchctl/plutil errors can include paths and
 * environment values. Callers receive only operation, exit code and bounded state.
 * @param {string} cmd @param {string[]} args
 * @param {{allowFailure?: boolean, input?: string}} [options]
 * @param {ServiceDeps} [deps]
 */
export function run(cmd, args, options = {}, deps = {}) {
  let result;
  try {
    result = deps.run ? deps.run(cmd, args, options) : (deps.spawnSync || spawnSync)(cmd, args, {
      encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 30_000,
      killSignal: "SIGKILL", env: deps.env || process.env,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
  } catch (error) { result = { status: null, error }; }
  const normalized = { status: Number.isSafeInteger(result.status) ? result.status : null,
    stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), error: result.error, signal: result.signal };
  if ((normalized.status !== 0 || normalized.error || normalized.signal) && !options.allowFailure) {
    throw new ServiceOperationError(`${cmd} ${args[0] || "command"} failed (exit ${normalized.status ?? "unknown"})`);
  }
  return normalized;
}

/** Read only direct service properties, never a nested group's state or PID.
 * launchctl uses whole-line `key = {` / `}` delimiters; braces in scalar
 * values are ordinary text. Flat, uniformly indented diagnostic fixtures are
 * also accepted. Ambiguous or incomplete structure supplies no runtime facts.
 * @param {string} stdout */
export function parseLaunchdState(stdout) {
  /** @type {Record<string, string>} */
  const result = {};
  const lines = stdout.split("\n").filter((line) => line.trim() && !/^\s*(?:#|\/\/)/.test(line));
  if (!lines.length) return result;
  const opens = (/** @type {string} */ line) => /^[^{}=]+\s*=\s*\{$/.test(line.trim());
  const indentation = (/** @type {string} */ line) => line.match(/^[ \t]*/)?.[0] || "";
  const property = /^(state|pid|last exit code)\s*=\s*(.*)$/;
  const wrapped = opens(lines[0]);
  if (wrapped && property.test(lines[0].trim())) return {};
  /** @type {{indent: string, childIndent: string | null}[]} */
  const scopes = wrapped ? [{ indent: indentation(lines[0]), childIndent: null }] : [];
  const flatIndent = indentation(lines[0]);
  for (const line of lines.slice(wrapped ? 1 : 0)) {
    const text = line.trim();
    const indent = indentation(line);
    if (wrapped) {
      const scope = scopes.at(-1);
      if (!scope) return {};
      if (text === "}") {
        if (indent !== scope.indent) return {};
        scopes.pop();
        continue;
      }
      if (!indent.startsWith(scope.indent) || indent.length <= scope.indent.length) return {};
      if (scope.childIndent === null) scope.childIndent = indent;
      if (indent !== scope.childIndent) return {};
      if (opens(line)) {
        if (scopes.length === 1 && property.test(text)) return {};
        scopes.push({ indent, childIndent: null });
        continue;
      }
      if (text === "{") return {};
      if (scopes.length !== 1) continue;
    } else if (indent !== flatIndent || opens(line) || text === "}" || text === "{") return {};
    const match = text.match(property);
    if (match) {
      if (!match[2] || Object.hasOwn(result, match[1])) return {};
      result[match[1]] = match[2];
    }
  }
  return scopes.length ? {} : result;
}

/** @param {{status: number | null, stdout?: string, stderr?: string, error?: unknown, signal?: unknown}} result
 * @returns {"loaded" | "absent" | "unknown"} */
export function classifyLaunchdPrint(result) {
  if (result.error || result.signal) return "unknown";
  if (result.status === 0) return "loaded";
  if (result.status === 113 && /^Could not find service "[^"\r\n]+" in domain\b/m.test(`${result.stderr || ""}\n${result.stdout || ""}`)) return "absent";
  return "unknown";
}

/** Read-only OS observation, shared by lifecycle, status and check. @param {ServiceDeps} [deps] */
export function probeService(deps = {}) {
  const result = run("launchctl", ["print", target(deps)], { allowFailure: true }, deps);
  const inspection = classifyLaunchdPrint(result);
  const state = inspection === "loaded" ? parseLaunchdState(result.stdout) : {};
  const pid = /^\d+$/.test(state.pid || "") && Number(state.pid) > 0 ? Number(state.pid) : null;
  const running = inspection === "loaded" && state.state === "running" && Number.isSafeInteger(pid);
  return { status: inspection === "loaded" ? running ? "running" : "loaded" : inspection,
    loaded: inspection === "unknown" ? null : inspection === "loaded",
    state: state.state || null, pid,
    last_exit_code: /^-?\d+$/.test(state["last exit code"] || "") ? Number(state["last exit code"]) : null,
    command_status: result.status };
}

/** @param {ServiceDeps} deps */
function confirmedProbe(deps) {
  const probe = probeService(deps);
  if (probe.status === "unknown") throw new ServiceOperationError("cannot inspect service: launchctl print failed");
  return probe;
}

/**
 * Read-only installed configuration. Unknown/malformed configuration never
 * supplies an inferred database identity to diagnostics.
 * @param {ServiceDeps} [deps]
 */
export function readInstalledServiceConfig(deps = {}) {
  const path = plistPath(deps);
  try {
    if (!(deps.existsSync || existsSync)(path)) return { status: "missing" };
    const xml = (deps.readFileSync || readFileSync)(path, "utf8");
    const parsed = run("plutil", ["-convert", "json", "-o", "-", "--", "-"], { allowFailure: true, input: xml }, deps);
    if (parsed.status !== 0 || parsed.error || parsed.signal) return { status: "unknown" };
    const plist = JSON.parse(parsed.stdout);
    if (!plist || typeof plist !== "object" || Array.isArray(plist) || plist.Label !== LABEL ||
        !isAbsolute(plist.WorkingDirectory || "") || !Array.isArray(plist.ProgramArguments) ||
        plist.ProgramArguments.length < 2 || !plist.ProgramArguments.every((arg) => typeof arg === "string")) return { status: "unknown" };
    const [nodePath, workerPath, ...argv] = plist.ProgramArguments;
    if (!isAbsolute(nodePath) || !isAbsolute(workerPath)) return { status: "unknown" };
    const config = parseWorkerProgramArguments(argv, { root: plist.WorkingDirectory, cwd: plist.WorkingDirectory, resolvePaths: true });
    return { status: "installed", config, root: plist.WorkingDirectory, nodePath, workerPath, plist, xml };
  } catch { return { status: "unknown" }; }
}

/** @param {unknown} value */
export function xmlEscape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** Pure configuration serialization; installation and start own filesystem effects.
 * @param {import("../worker/options.mjs").WorkerSettings} config @param {ServiceDeps} [deps] */
export function servicePlist(config, deps = {}) {
  const root = deps.root || PROJECT_ROOT;
  if (!isAbsolute(root) || !isAbsolute(config.db) || !isAbsolute(config.logDir)) {
    throw new ServiceOperationError("service installation requires absolute root, database and log paths");
  }
  return {
    Label: LABEL,
    WorkingDirectory: root,
    ProgramArguments: [deps.nodePath || process.execPath, deps.workerPath || resolve(root, "src/runtime/worker/main.mjs"), ...workerProgramArguments(config)],
    EnvironmentVariables: deps.serviceEnvironment || serviceEnvironment(deps),
    Umask: 63, RunAtLoad: true, KeepAlive: true,
    StandardOutPath: "/dev/null", StandardErrorPath: resolve(config.logDir, "launchd.err.log"),
  };
}

/** @param {unknown} value @returns {string} */
function xmlValue(value) {
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(xmlValue).join("")}</array>`;
  if (value && typeof value === "object") return `<dict>${Object.entries(value).map(([key, item]) => `<key>${xmlEscape(key)}</key>${xmlValue(item)}`).join("")}</dict>`;
  return `<string>${xmlEscape(value)}</string>`;
}
/** @param {import("../worker/options.mjs").WorkerSettings} config @param {ServiceDeps} [deps] */
export function plistXml(config, deps = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xmlValue(servicePlist(config, deps))}</plist>\n`;
}

/** @param {import("../worker/options.mjs").WorkerSettings} config @param {ServiceDeps} [deps] */
export function install(config, deps = {}) {
  const before = confirmedProbe(deps);
  let selected;
  try { selected = resolveServiceDependencies(deps); }
  catch (error) { throw error instanceof ServiceDependencyError ? new ServiceOperationError(error.message) : new ServiceOperationError("cannot select service dependencies"); }
  deps = { ...deps, ...selected };
  const desired = servicePlist(config, deps);
  const existing = readInstalledServiceConfig(deps);
  const unchanged = existing.status === "installed" && isDeepStrictEqual(existing.plist, desired);
  if (before.loaded) {
    if (unchanged) return { ok: true, action: "install", status: "unchanged" };
    throw new ServiceOperationError("service is loaded with a different or unknown configuration; stop it before installing");
  }
  if (unchanged) return { ok: true, action: "install", status: "unchanged" };
  try { verifyServiceDependencies(selected, deps); }
  catch (error) { throw error instanceof ServiceDependencyError ? new ServiceOperationError(error.message) : new ServiceOperationError("cannot verify service dependencies"); }
  const path = plistPath(deps);
  const temporary = `${path}.tmp-${process.pid}`;
  const write = deps.writeFileSync || writeFileSync;
  const rename = deps.renameSync || renameSync;
  const remove = deps.rmSync || rmSync;
  const chmod = deps.chmodSync || chmodSync;
  let previous = null;
  let previousMode = 0o600;
  try {
    if ((deps.existsSync || existsSync)(path)) {
      previous = (deps.readFileSync || readFileSync)(path, "utf8");
      previousMode = (deps.statSync || statSync)(path).mode & 0o777;
    }
  } catch { throw new ServiceOperationError("cannot read previous service configuration for rollback"); }
  let replaced = false;
  let failure = null;
  try {
    (deps.mkdirSync || mkdirSync)(dirname(path), { recursive: true, mode: 0o700 });
    write(temporary, plistXml(config, deps), { encoding: "utf8", mode: 0o600 });
    chmod(temporary, 0o600);
    run("plutil", ["-lint", temporary], {}, deps);
    // Inspect again before publication: a concurrent start cannot authorize
    // replacing configuration underneath a loaded worker.
    if (confirmedProbe(deps).loaded) throw new ServiceOperationError("service became loaded; stop it before installing");
    rename(temporary, path);
    replaced = true;
    chmod(path, 0o600);
  } catch (error) {
    failure = error instanceof ServiceOperationError ? error : new ServiceOperationError("service configuration write failed");
    if (replaced) {
      try {
        if (previous === null) remove(path, { force: true });
        else {
          write(temporary, previous, { encoding: "utf8", mode: previousMode });
          chmod(temporary, previousMode);
          rename(temporary, path);
        }
      } catch { failure = new ServiceOperationError(`${failure.message}; rollback incomplete: could not restore previous plist`); }
    }
  }
  try { remove(temporary, { force: true }); }
  catch { failure = new ServiceOperationError(`${failure?.message || "configuration installed"}; staging cleanup failed`); }
  if (failure) throw failure;
  return { ok: true, action: "install", status: "installed" };
}

/** @param {ServiceDeps} deps */
function prepareLogDirectory(deps) {
  const installed = readInstalledServiceConfig(deps);
  if (installed.status !== "installed") throw new ServiceOperationError("installed service configuration is unavailable");
  const dir = installed.config.logDir;
  try {
    (deps.mkdirSync || mkdirSync)(dir, { recursive: true, mode: 0o700 });
    (deps.chmodSync || chmodSync)(dir, 0o700);
    for (const name of ["worker.jsonl", "launchd.out.log", "launchd.err.log"]) {
      const path = resolve(dir, name);
      if ((deps.existsSync || existsSync)(path)) (deps.chmodSync || chmodSync)(path, 0o600);
    }
  } catch { throw new ServiceOperationError("cannot prepare service log directory"); }
}

/** Ensure-running: kickstart without -k never requests instance replacement. @param {ServiceDeps} [deps] */
export function start(deps = {}) {
  const before = confirmedProbe(deps);
  if (before.status === "running") return { ok: true, action: "start", status: "already_running" };
  if (!(deps.existsSync || existsSync)(plistPath(deps))) throw new ServiceOperationError("service configuration is not installed");
  prepareLogDirectory(deps);
  if (before.status === "absent") {
    const boot = run("launchctl", ["bootstrap", domain(deps), plistPath(deps)], { allowFailure: true }, deps);
    if (boot.status !== 0 || boot.error || boot.signal) {
      const after = confirmedProbe(deps);
      if (!after.loaded) throw new ServiceOperationError("launchctl bootstrap failed");
      if (after.status === "running") return { ok: true, action: "start", status: "already_running" };
    }
  }
  const kick = run("launchctl", ["kickstart", target(deps)], { allowFailure: true }, deps);
  if (kick.status !== 0 || kick.error || kick.signal) {
    if (confirmedProbe(deps).status !== "running") throw new ServiceOperationError("launchctl kickstart failed");
  }
  return { ok: true, action: "start", status: "start_requested" };
}

/** @param {ServiceDeps} [deps] */
export function stop(deps = {}) {
  if (!confirmedProbe(deps).loaded) return { ok: true, action: "stop", status: "stopped" };
  run("launchctl", ["bootout", target(deps)], { allowFailure: true }, deps);
  run("launchctl", ["bootout", domain(deps), plistPath(deps)], { allowFailure: true }, deps);
  if (confirmedProbe(deps).loaded) throw new ServiceOperationError("failed to stop service: job remains loaded");
  return { ok: true, action: "stop", status: "stopped" };
}
/** @param {ServiceDeps} [deps] */
export function restart(deps = {}) {
  stop(deps);
  start(deps);
  return { ok: true, action: "restart", status: "restart_requested" };
}
/** @param {ServiceDeps} [deps] */
export function uninstall(deps = {}) {
  stop(deps);
  const path = plistPath(deps);
  try { if ((deps.existsSync || existsSync)(path)) (deps.rmSync || rmSync)(path); }
  catch { throw new ServiceOperationError("cannot remove service configuration"); }
  return { ok: true, action: "uninstall", status: "uninstalled" };
}
