// @ts-check
// Internal bounded child; stdout contains only public diagnostic evidence.
import { fstatSync, lstatSync, readFileSync } from "node:fs";
import { executeRemoteSampleAttempt } from "./remote-sample-scheduler.mjs";
import { collectRemoteSample } from "../../diagnostics/remote-sample.mjs";
import { publicRemoteReport } from "../../diagnostics/remote-sample-cache.mjs";

try {
  const input = process.env.EXOCORTEX_REMOTE_SAMPLE_INPUT || readFileSync(0, "utf8");
  delete process.env.EXOCORTEX_REMOTE_SAMPLE_INPUT;
  if (input.length > 16 * 1024) throw new Error("scheduler input too large");
  const options = JSON.parse(input);
  if (typeof options?.db !== "string") throw new Error("invalid scheduler input");
  if (options.mode === "read_only") {
    const sampled = collectRemoteSample(options.db, options.options || {});
    process.stdout.write(`${JSON.stringify({ outcome: sampled.outcome, report: publicRemoteReport(sampled.report) })}\n`);
  } else {
    const fd = Number(process.env.EXOCORTEX_REMOTE_SAMPLE_LOCK_FD);
    const lock = Number.isSafeInteger(fd) && fd >= 200 ? fstatSync(fd) : null;
    if (!lock?.isFile() || (lock.mode & 0o077) !== 0 || lock.nlink !== 1 || process.getuid && lock.uid !== process.getuid()) throw new Error("scheduler lock unavailable");
    if (typeof options?.logDir !== "string") throw new Error("invalid scheduler input");
    const publication = JSON.parse(process.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION || "null");
    if (!publication || JSON.stringify(options.publication) !== JSON.stringify(publication)) throw new Error("cache publication unavailable");
    const namedLock = lstatSync(publication.lockPath);
    if (!namedLock.isFile() || namedLock.isSymbolicLink() || namedLock.dev !== lock.dev || namedLock.ino !== lock.ino ||
      namedLock.mode !== lock.mode || namedLock.uid !== lock.uid || namedLock.nlink !== 1) throw new Error("scheduler lock changed");
    const result = await executeRemoteSampleAttempt(options, { cooldownsByOperation: options.cooldownsByOperation,
      collectorOptions: options.collectorOptions, returnReport: options.returnReport === true });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.cachePrepared === true ? 0 : ["busy", "not_due"].includes(result.outcome) ? 3 : 2;
  }
} catch {
  process.stdout.write('{"outcome":"failed","reason":"scheduler_unavailable","next_due":null}\n');
  process.exitCode = 2;
}
