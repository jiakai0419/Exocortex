// @ts-check

/** @typedef {Record<string, any>} JsonObject */

/** @param {unknown} ms */
function durationText(ms) {
  if (ms === null || ms === undefined) return "unknown";
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** Local wall time with the UTC offset at that instant, including DST changes.
 * @param {unknown} value
 */
function localTimestamp(value) {
  if (!value) return "unknown";
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "unknown";
  const pad = (part) => String(part).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offset = `${offsetMinutes >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${offset}`;
}

/** @param {Date} date */
function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** @param {Date} date */
function ambiguousLocalTime(date) {
  const offset = date.getTimezoneOffset();
  return [-86400000, 86400000].some((delta) => {
    const otherOffset = new Date(date.getTime() + delta).getTimezoneOffset();
    if (otherOffset === offset) return false;
    const other = new Date(date.getTime() + (otherOffset - offset) * 60000);
    return localDay(other) === localDay(date) && other.getHours() === date.getHours() && other.getMinutes() === date.getMinutes();
  });
}

/** @param {Date} date @param {boolean} seconds @param {boolean} offset */
function serviceClock(date, seconds, offset) {
  const parts = localTimestamp(date.toISOString()).split(" ");
  return `${seconds ? parts[1] : parts[1].slice(0, 5)}${offset ? ` ${parts[2]}` : ""}`;
}

/** Local timestamp for status; the renderer declares the IANA zone once.
 * @param {unknown} value @param {number} [referenceMs]
 */
function serviceTimestamp(value, referenceMs = Date.now()) {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) return "unknown";
  const day = localDay(date) === localDay(new Date(referenceMs)) ? "Today" : localDay(date);
  return `${day} ${serviceClock(date, true, ambiguousLocalTime(date))}`;
}

/** @param {unknown} from @param {unknown} to @param {number} referenceMs @param {boolean} [seconds] */
function serviceTimeRange(from, to, referenceMs, seconds = false) {
  const start = new Date(String(from || ""));
  const end = new Date(String(to || ""));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return "unknown";
  const offsetsDiffer = start.getTimezoneOffset() !== end.getTimezoneOffset();
  const firstClock = serviceClock(start, seconds, offsetsDiffer || ambiguousLocalTime(start));
  const lastClock = serviceClock(end, seconds, offsetsDiffer || ambiguousLocalTime(end));
  if (localDay(start) === localDay(end)) {
    const day = localDay(start) === localDay(new Date(referenceMs)) ? "Today" : localDay(start);
    return `${day} ${firstClock}–${lastClock}`;
  }
  return `${localDay(start)} ${firstClock}–${localDay(end)} ${lastClock}`;
}

/** @param {JsonObject | null | undefined} stability */
function formatStabilityInterval(stability) {
  if (!stability) return "unknown";
  if (Number(stability.cycles?.ok || 0) < 2) return "unavailable (need 2 successes)";
  const interval = stability.longest_between_successes_ms;
  // Round measured intervals independently of ages, which still round down.
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0) return "unknown";
  let seconds = Math.round(interval / 1000);
  if (!Number.isSafeInteger(seconds)) return "unknown";
  /** @type {Array<[number, string]>} */
  const units = [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]];
  const parts = [];
  for (const [size, label] of units) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count}${label}`);
    seconds %= size;
  }
  return parts.join("") || "0s";
}

/** @param {JsonObject | null | undefined} leases */
function formatLeaseIssues(leases) {
  const labels = {
    invalid_timestamp: "invalid timestamps",
    invalid_interval: "invalid lease interval",
    future_start: "future start time",
    hard_limit_exceeded: "hard lease limit exceeded",
    expired: "expired",
  };
  const reasons = Array.isArray(leases?.reasons) ? leases.reasons : [];
  const parts = Object.entries(labels).flatMap(([reason, label]) => {
    const count = reasons.filter((item) => item?.reason === reason && Number.isSafeInteger(item.count) && item.count > 0)
      .reduce((sum, item) => sum + item.count, 0);
    return count > 0 ? [`${label} x${count}`] : [];
  });
  return parts.join(", ") || "lease state needs inspection";
}

export { durationText, serviceTimestamp, serviceTimeRange, formatStabilityInterval, formatLeaseIssues };
