// @ts-check
import { spawnSync } from "node:child_process";

export const REMOTE_SAMPLE_TIMEOUT_MS = 60_000;
const CLEANUP_GRACE_MS = 2000;

const PRIMARY_STAGES = new Set(["guardian_setup", "child_spawn", "capture_nonblocking", "watch_create", "watch_register",
  "capture_read", "watch_poll", "wait_observe", "deadline", "parent_exit", "signal_stop", "output_limit", "child_exit", "result_publish",
  "guardian_spawn", "guardian_timeout", "guardian_output_limit", "guardian_result"]);
const CLEANUP_STAGES = new Set(["group_kill", "child_reap", "capture_drain", "watch_close"]);
function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function diagnosticEntry(value, stages) {
  if (value === null) return null;
  if (!exactKeys(value, ["stage", "errno"]) || !stages.has(value.stage) ||
    value.errno !== null && (!Number.isSafeInteger(value.errno) || value.errno < 1 || value.errno > 4095)) return undefined;
  return { stage: value.stage, errno: value.errno };
}

/** Reject the whole diagnostic on unknown fields; never normalize private error text.
 * @returns {{version:1,primary:{stage:string,errno:number|null}|null,cleanup:{stage:string,errno:number|null}|null}|null} */
export function safeGuardianDiagnostic(value) {
  if (!exactKeys(value, ["version", "primary", "cleanup"]) || value.version !== 1) return null;
  const primary = diagnosticEntry(value.primary, PRIMARY_STAGES);
  const cleanup = diagnosticEntry(value.cleanup, CLEANUP_STAGES);
  if (primary === undefined || cleanup === undefined || !primary && !cleanup) return null;
  return { version: 1, primary, cleanup };
}

function errorNumber(error) {
  const value = typeof error?.errno === "number" ? Math.abs(error.errno) : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 4095 ? value : null;
}
/** @param {ReturnType<typeof safeGuardianDiagnostic>} [previous] */
function processDiagnostic(stage, error, previous = null) {
  return safeGuardianDiagnostic({ version: 1, primary: previous?.primary || { stage, errno: errorNumber(error) }, cleanup: previous?.cleanup || null });
}

// One short-lived supervisor serves background and synchronous callers. It
// never schedules work. Capture mode drains a bounded pipe without blocking
// its deadline, and publishes output only after all descendants are killed.
export const REMOTE_SAMPLE_GUARDIAN = String.raw`
import json,os,select,signal,subprocess,sys,time
child=None
events=None
stopping=False
exited=False
overflow=False
nonblocking=False
output=bytearray()
capture=os.environ.get('EXOCORTEX_REMOTE_SAMPLE_CAPTURE')=='1'
primary=None
cleanup=None
stage='guardian_setup'
def failure(where,error=None,cleaning=False):
    global primary,cleanup
    number=getattr(error,'errno',None)
    item={'stage':where,'errno':number if type(number) is int and 1<=number<=4095 else None}
    if cleaning:
        if cleanup is None: cleanup=item
    elif primary is None: primary=item
def stop(_signal,_frame):
    global stopping
    stopping=True
def drain():
    global overflow
    if not capture or child is None or not nonblocking: return
    while len(output)<=65536:
        try: part=os.read(child.stdout.fileno(),65537-len(output))
        except BlockingIOError: break
        if not part: break
        output.extend(part)
    overflow=len(output)>65536
try:
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    parent=int(sys.argv[1])
    timeout=min(60.0,max(0.001,float(sys.argv[2])/1000.0))
    deadline=time.monotonic()+timeout
    if os.getppid()!=parent: failure('parent_exit')
    else:
        stage='child_spawn'
        child=subprocess.Popen(sys.argv[3:],stdin=sys.stdin if capture else subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        if capture:
            stage='capture_nonblocking'
            os.set_blocking(child.stdout.fileno(),False)
            nonblocking=True
        if not hasattr(os,'waitid'):
            stage='watch_create'
            events=select.kqueue()
            stage='watch_register'
            events.control([select.kevent(child.pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT)],0,0)
        while True:
            if stopping: failure('signal_stop'); break
            if os.getppid()!=parent: failure('parent_exit'); break
            if time.monotonic()>=deadline: failure('deadline'); break
            stage='capture_read'
            drain()
            if overflow: failure('output_limit'); break
            # Observe without reaping: retain our process-group identity until
            # descendants are killed, then reap the leader in finally.
            if events is not None:
                stage='watch_poll'
                exited=bool(events.control(None,1,0))
            else:
                stage='wait_observe'
                exited=os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is not None
            if exited: break
            time.sleep(min(0.05,max(0.0,deadline-time.monotonic())))
except Exception as error:
    failure(stage,error)
finally:
    if child is not None:
        may_reap=exited
        try:
            os.killpg(child.pid,signal.SIGKILL)
            may_reap=True
        except ProcessLookupError: may_reap=True
        except Exception as error: failure('group_kill',error,True)
        # A denied kill is never retried. Without observed exit, waiting could
        # hang indefinitely; even a successful kill gets only a bounded reap.
        if may_reap:
            try: child.wait(timeout=1.0)
            except Exception as error: failure('child_reap',error,True)
        if primary is None or primary['stage']!='capture_read':
            try: drain()
            except Exception as error: failure('capture_drain',error,True)
    if events is not None:
        try: events.close()
        except Exception as error: failure('watch_close',error,True)
if overflow: failure('output_limit')
if stopping: failure('signal_stop')
# Confirmed child failure is independent of cleanup; a timed-out reap is unknown.
if child is not None and child.returncode is not None and child.returncode!=0: failure('child_exit')
if primary is None and cleanup is None and (not exited or child is None or child.returncode!=0): failure('child_exit')
failed=primary is not None or cleanup is not None
if capture:
    try:
        if failed:
            sys.stdout.write(json.dumps({'outcome':'failed','reason':'sample_process_failed','next_due':None,
                'guardian_diagnostic':{'version':1,'primary':primary,'cleanup':cleanup}})+'\n')
        else: sys.stdout.buffer.write(output)
        sys.stdout.flush()
    except Exception as error:
        failure('result_publish',error)
        failed=True
        # Cleanup is complete. Bypass shutdown's implicit flush so a failed
        # output channel is not retried and no exception text is printed.
        os._exit(2)
if failed: sys.exit(2)
`;

/** Preserve synchronous JSON results while the same guardian owns group
 * cleanup. The outer timeout sends SIGTERM and leaves cleanup grace; it must
 * never SIGKILL the guardian before its finally block runs. */
export function runGuardedRemoteSampleProcess(command, args, options = {}, deps = {}) {
  const timeout = Math.min(REMOTE_SAMPLE_TIMEOUT_MS, Math.max(1, Number(deps.timeoutMs) || REMOTE_SAMPLE_TIMEOUT_MS));
  let child;
  try { child = (deps.spawnSync || spawnSync)(deps.pythonPath || "python3", ["-c", REMOTE_SAMPLE_GUARDIAN,
    String(process.pid), String(timeout), command, ...args], {
    input: options.input, encoding: "utf8", maxBuffer: 64 * 1024, detached: true,
    env: { ...(options.env || process.env), EXOCORTEX_REMOTE_SAMPLE_CAPTURE: "1", EXOCORTEX_REMOTE_SAMPLE_INPUT: "" },
    timeout: timeout + CLEANUP_GRACE_MS, killSignal: "SIGTERM",
  }); } catch (error) {
    return { status: null, signal: null, stdout: "", stderr: "", error: true,
      guardian_diagnostic: processDiagnostic("guardian_spawn", error) };
  }
  let diagnostic = null;
  let output;
  try {
    output = JSON.parse(String(child.stdout || ""));
    diagnostic = safeGuardianDiagnostic(output?.guardian_diagnostic);
  } catch { /* Only the bounded diagnostic envelope may leave this helper. */ }
  if (child.error || child.signal) {
    const stage = child.error?.code === "ETIMEDOUT" ? "guardian_timeout" : child.error?.code === "ENOBUFS" ? "guardian_output_limit" : "guardian_spawn";
    diagnostic = processDiagnostic(stage, child.error, diagnostic);
  } else if (!diagnostic && (child.status !== 0 || !output || typeof output !== "object" || Array.isArray(output) ||
    Object.hasOwn(output, "guardian_diagnostic"))) {
    diagnostic = processDiagnostic("guardian_result", null, diagnostic);
  }
  return { ...child, ...(diagnostic ? { guardian_diagnostic: diagnostic } : {}) };
}
