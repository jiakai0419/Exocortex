// @ts-check
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { WORKER_DEFAULTS } from "./options.mjs";
/**
 * @typedef {Record<string, any>} JsonObject
 * @typedef {object} WriteLogDeps
 * @property {{write(chunk: string): void}=} stdout
 * @property {(path: string, options?: {recursive?: boolean,mode?:number}) => void=} mkdirSync
 * @property {(path: string, data: string, options?: JsonObject) => void=} appendFileSync
 * @property {(path: string) => boolean=} existsSync
 * @property {(path: string) => {size: number}=} statSync
 * @property {(oldPath: string, newPath: string) => void=} renameSync
 * @property {(path: string, options?: JsonObject) => void=} rmSync
 * @property {(path: string, mode: number) => void=} chmodSync
 * @property {(path: string, ...paths: string[]) => string=} resolvePath
 */
/**
 * @param {string} path
 * @param {number} incomingBytes
 * @param {number} maxBytes
 * @param {number} keepFiles
 * @param {WriteLogDeps} deps
 */
function rotateLogIfNeeded(path, incomingBytes, maxBytes, keepFiles, deps) {
  const exists = deps.existsSync || existsSync;
  const stat = deps.statSync || statSync;
  if (!exists(path) || Number(stat(path).size || 0) + incomingBytes <= maxBytes) return;
  const rename = deps.renameSync || renameSync;
  const remove = deps.rmSync || rmSync;
  for (let index = keepFiles; index >= 1; index -= 1) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const destination = `${path}.${index}`;
    if (!exists(source)) continue;
    if (exists(destination)) remove(destination, { force: true });
    rename(source, destination);
  }
}

/**
 * @param {{logDir?: string, logMaxBytes?: number, logKeepFiles?: number}} opts
 * @param {JsonObject} payload
 * @param {WriteLogDeps} [deps]
 */
function writeLog(opts, payload, deps = {}) {
  const line = `${JSON.stringify(payload)}\n`;
  const stdout = deps.stdout || process.stdout;
  stdout.write(line);
  if (opts.logDir) {
    const resolvePath = deps.resolvePath || resolve;
    const makeDir = deps.mkdirSync || mkdirSync;
    const append = deps.appendFileSync || appendFileSync;
    const chmod = deps.chmodSync || (deps.mkdirSync || deps.appendFileSync ? () => {} : chmodSync);
    const logDir = resolvePath(opts.logDir);
    makeDir(logDir, { recursive: true, mode: 0o700 });
    chmod(logDir, 0o700);
    const logPath = resolvePath(logDir, "worker.jsonl");
    rotateLogIfNeeded(
      logPath,
      Buffer.byteLength(line),
      Number(opts.logMaxBytes || WORKER_DEFAULTS.logMaxBytes),
      Number(opts.logKeepFiles || WORKER_DEFAULTS.logKeepFiles),
      deps,
    );
    append(logPath, line, { encoding: "utf8", mode: 0o600 });
    chmod(logPath, 0o600);
  }
}

export { writeLog, rotateLogIfNeeded };
