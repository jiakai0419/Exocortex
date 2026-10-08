// @ts-check

/** Accept only explicit, real calendar timestamps; never coerce epoch numbers.
 * Shared by worker wait acceptance and retained runtime statistics.
 * @param {unknown} value @returns {number | null} */
function parseWorkerEventTimestamp(value) {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, zone, offsetHour, offsetMinute] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    (zone !== "Z" && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))) return null;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) ? at : null;
}

export { parseWorkerEventTimestamp };
