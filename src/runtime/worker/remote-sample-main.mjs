// @ts-check
// Internal bounded child; stdout contains only public diagnostic evidence.
import { fstatSync, readFileSync } from "node:fs";
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
    if (!lock?.isFile() || (lock.mode & 0o077) !== 0) throw new Error("scheduler lock unavailable");
    if (typeof options?.logDir !== "string") throw new Error("invalid scheduler input");
    process.stdout.write(`${JSON.stringify(await executeRemoteSampleAttempt(options, { cooldownsByOperation: options.cooldownsByOperation,
      collectorOptions: options.collectorOptions, returnReport: options.returnReport === true }))}\n`);
  }
} catch {
  process.stdout.write('{"outcome":"failed","reason":"scheduler_unavailable","next_due":null}\n');
}
