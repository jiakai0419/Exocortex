// @ts-check
const STAGES = new Set(['schema_query', 'snapshot_query', 'snapshot_validate', 'sqlite_query']);
const KINDS = new Set(['dependency_unavailable', 'timeout', 'output_limit', 'spawn_error',
    'process_exit', 'process_signal', 'invalid_json', 'invalid_shape', 'unknown']);
const SIGNALS = new Set(['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV',
    'SIGBUS', 'SIGILL', 'SIGXCPU', 'SIGXFSZ']);
const SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ENOBUFS', 'E2BIG',
    'ENOMEM', 'EMFILE', 'ENFILE', 'EAGAIN', 'EIO', 'EINVAL', 'ENOEXEC', 'ECANCELED']);
const SQLITE_KINDS = new Set(['busy', 'locked', 'schema_missing', 'schema_changed', 'syntax',
    'corrupt', 'not_database', 'open_failed', 'io', 'full', 'readonly', 'interrupted',
    'memory', 'size_limit', 'unknown']);
const NUMBERS = ['status', 'elapsed_ms', 'timeout_ms', 'max_buffer_bytes', 'stdout_bytes', 'stderr_bytes'];
const KEYS = ['version', 'stage', 'kind', 'status', 'signal', 'spawn_code', 'sqlite_kind',
    'elapsed_ms', 'timeout_ms', 'max_buffer_bytes', 'stdout_bytes', 'stderr_bytes'];
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const nullableNumber = value => value === null || nonnegative(value);
/** Public diagnostics have a closed schema; never spread an error or child result.
 * @param {unknown} value @returns {Readonly<Record<string, any>> | null} */
export function copySqliteReadDiagnostic(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    try {
        const fields = Object.getOwnPropertyDescriptors(value);
        if (Object.keys(fields).length !== KEYS.length || KEYS.some(key => !fields[key] || !Object.hasOwn(fields[key], 'value')))
            return null;
        const v = Object.fromEntries(KEYS.map(key => [key, fields[key].value]));
        if (v.version !== 1 || !STAGES.has(v.stage) || !KINDS.has(v.kind) || !SQLITE_KINDS.has(v.sqlite_kind)
            || v.signal !== null && !SIGNALS.has(v.signal) || v.spawn_code !== null && !SPAWN_CODES.has(v.spawn_code)
            || NUMBERS.some(key => !nullableNumber(v[key])) || v.status !== null && v.status > 255)
            return null;
        return Object.freeze(v);
    }
    catch {
        return null;
    }
}
export function sqliteReadStage(label) {
    return label === 'read message snapshot schema' ? 'schema_query'
        : label === 'read message snapshot' ? 'snapshot_query' : 'sqlite_query';
}
/** Only a bounded first shell-error line is examined; no text is returned. */
function sqliteKind(stderr) {
    if (typeof stderr !== 'string')
        return 'unknown';
    const bounded = stderr.slice(0, 2049), newline = bounded.indexOf('\n');
    if (newline < 0 && stderr.length > 2048)
        return 'unknown';
    const line = (newline >= 0 ? bounded.slice(0, newline) : bounded).replace(/\r$/, '');
    const match = /^(?:Parse error|Runtime error)(?: near line [0-9]+)?: (.*)$/.exec(line)
        || /^Error: (?:(?:in prepare|stepping), )?(.*)$/.exec(line);
    if (!match)
        return 'unknown';
    const text = match[1];
    const suffix = / \(([0-9]+)\)$/.exec(text);
    const code = suffix ? Number(suffix[1]) : null;
    if (suffix && (suffix[1].length > 10 || !Number.isSafeInteger(code) || Number(code) < 1 || Number(code) > 2147483647))
        return 'unknown';
    for (const [pattern, kind, primary] of /** @type {[RegExp,string,number][]} */ ([
        [/^database is locked(?: \([0-9]+\))?$/, 'busy', 5],
        [/^database (?:table|schema) is locked(?:[: ].*)?$/, 'locked', 6],
        [/^no such (?:table|column|index): /, 'schema_missing', 1],
        [/^database schema has changed(?: \([0-9]+\))?$/, 'schema_changed', 17],
        [/^near .+: syntax error(?: \([0-9]+\))?$/, 'syntax', 1],
        [/^database disk image is malformed(?: \([0-9]+\))?$/, 'corrupt', 11],
        [/^file is not a database(?: \([0-9]+\))?$/, 'not_database', 26],
        [/^unable to open database(?: file| ").*/, 'open_failed', 14],
        [/^disk I\/O error(?: \([0-9]+\))?$/, 'io', 10],
        [/^database or disk is full(?: \([0-9]+\))?$/, 'full', 13],
        [/^attempt to write a readonly database(?: \([0-9]+\))?$/, 'readonly', 8],
        [/^interrupted(?: \([0-9]+\))?$/, 'interrupted', 9],
        [/^out of memory(?: \([0-9]+\))?$/, 'memory', 7],
        [/^string or blob too big(?: \([0-9]+\))?$/, 'size_limit', 18],
    ]))
        if (pattern.test(text))
            return code === null || code % 256 === primary ? kind : 'unknown';
    return 'unknown';
}
const byteLength = value => typeof value === 'string' ? Buffer.byteLength(value)
    : Buffer.isBuffer(value) ? value.length : null;
/** Evidence from one observed subprocess, without its raw diagnostic content.
 * @param {{stage:string,kind:string,result?:any,elapsedMs?:number|null,timeoutMs?:number|null,maxBufferBytes?:number|null}} input */
export function sqliteReadDiagnostic(input) {
    const result = input.result;
    const code = result?.error?.code;
    const value = {
        version: 1, stage: input.stage, kind: input.kind,
        status: nonnegative(result?.status) && result.status <= 255 ? result.status : null,
        signal: SIGNALS.has(result?.signal) ? result.signal : null,
        spawn_code: SPAWN_CODES.has(code) ? code : null,
        sqlite_kind: Number.isInteger(result?.status) && result.status > 0 && result.status <= 255
            && !result.error && !result.signal ? sqliteKind(result.stderr) : 'unknown',
        elapsed_ms: nonnegative(input.elapsedMs) ? input.elapsedMs : null,
        timeout_ms: nonnegative(input.timeoutMs) ? input.timeoutMs : null,
        max_buffer_bytes: nonnegative(input.maxBufferBytes) ? input.maxBufferBytes : null,
        stdout_bytes: result ? byteLength(result.stdout) : null,
        stderr_bytes: result ? byteLength(result.stderr) : null,
    };
    return copySqliteReadDiagnostic(value);
}
export function renderSqliteReadDiagnostic(value) {
    const diagnostic = copySqliteReadDiagnostic(value);
    return diagnostic ? `Read diagnostic: ${KEYS.filter(key => key !== 'version')
        .map(key => `${key}=${diagnostic[key] === null ? 'unknown' : diagnostic[key]}`).join(' ')}\n` : '';
}
