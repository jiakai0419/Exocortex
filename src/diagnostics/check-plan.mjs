// @ts-check
import { CliUsageError } from "../cli/context.mjs";

/** @typedef {Record<string, any>} JsonObject */

/** @param {unknown} value @param {string} flag */
function timestamp(value, flag) {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value) : null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  let valid = match !== null && Number.isFinite(parsed);
  if (match && valid) {
    const offsetHours = Number(match[10] || 0);
    const offsetMinutes = Number(match[11] || 0);
    const offset = (match[9] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
    // Reconstruct the requested wall clock. Date.parse alone rolls invalid
    // calendar days and 24:00 into a different explicit interval.
    const wall = new Date(parsed + offset * 60000);
    const expected = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]),
      Number(match[6] || 0), Number((match[7] || "").padEnd(3, "0"))];
    const actual = [wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(),
      wall.getUTCMinutes(), wall.getUTCSeconds(), wall.getUTCMilliseconds()];
    valid = offsetHours <= 23 && offsetMinutes <= 59 && expected.every((part, index) => part === actual[index]);
  }
  if (!valid) throw new CliUsageError(`${flag} requires a valid ISO timestamp with an explicit timezone`);
  return parsed;
}

/** Capture all time bounds once, before dependency checks or waiting.
 * @param {JsonObject} options @param {JsonObject} context
 * @returns {JsonObject}
 */
function createCheckPlan(options, context) {
  const calledAt = context.startedAtMs ?? context.now();
  const provided = context.provided || new Set();
  const live = options.live === true;
  const wait = options.wait === true;
  const backup = Boolean(options.backup || options.latestBackup);
  if (options.backup && options.latestBackup) throw new CliUsageError("--backup and --latest-backup are mutually exclusive");
  for (const flag of ["--start", "--end", "--chat-pages", "--hot-chats", "--messages-per-chat", "--unsafe-details", "--write-live-cache"]) {
    if (provided.has(flag) && !live) throw new CliUsageError(`${flag} requires --live`);
  }
  if ((options.unsafeDetails || options.writeLiveCache) && !live) throw new CliUsageError("live output and cache options require --live");
  for (const flag of ["--timeout-seconds", "--poll-seconds"]) {
    if (provided.has(flag) && !wait) throw new CliUsageError(`${flag} requires --wait`);
  }
  if (provided.has("--backup-dir") && !backup) throw new CliUsageError("--backup-dir requires a backup check");
  if (provided.has("--log-dir") && !wait && !options.writeLiveCache) throw new CliUsageError("--log-dir requires --wait or --write-live-cache");
  const start = new Date(calledAt);
  start.setHours(0, 0, 0, 0);
  const startMs = options.start === undefined ? start.getTime() : timestamp(options.start, "--start");
  const endMs = options.end === undefined ? calledAt : timestamp(options.end, "--end");
  if (live && (startMs >= endMs || endMs > calledAt)) throw new CliUsageError("live window must be nonempty and end no later than invocation");
  const throughMs = options.through === undefined ? null : timestamp(options.through, "--through");
  if (throughMs !== null && throughMs > calledAt) throw new CliUsageError("--through must not be later than invocation");
  const plan = { ...options, live, wait, calledAt, throughMs,
    chatPages: options.chatPages ?? 5, hotChats: options.hotChats ?? 5, messagesPerChat: options.messagesPerChat ?? 3,
    timeoutSeconds: options.timeoutSeconds ?? 180, pollSeconds: options.pollSeconds ?? 5,
    startMs, endMs, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
  for (const key of ["chatPages", "hotChats", "messagesPerChat", "timeoutSeconds", "pollSeconds"]) {
    if (!Number.isSafeInteger(plan[key]) || plan[key] < 1) throw new CliUsageError(`${key} must be a positive integer`);
  }
  if (plan.messagesPerChat > 50) throw new CliUsageError("--messages-per-chat must not exceed 50");
  return plan;
}

export { createCheckPlan };
