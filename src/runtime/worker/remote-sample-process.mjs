// @ts-check
import { spawnSync } from "node:child_process";
import { REMOTE_SAMPLE_ANCHOR } from "./remote-sample-anchor.mjs";
import { REMOTE_SAMPLE_CACHE_GATE } from "./remote-sample-cache-gate.mjs";

export const REMOTE_SAMPLE_TIMEOUT_MS = 60_000;
const CLEANUP_GRACE_MS = 2000;

const PRIMARY_STAGES = new Set(["guardian_setup", "child_spawn", "capture_nonblocking", "watch_create", "watch_register",
  "capture_read", "watch_poll", "wait_observe", "deadline", "parent_exit", "signal_stop", "output_limit", "child_exit", "result_publish",
  "control_create", "control_nonblocking", "control_write", "control_read", "control_protocol", "anchor_lost", "cache_setup", "cache_publish",
  "anchor_setup", "anchor_control_read", "anchor_control_write", "anchor_worker_spawn", "anchor_worker_poll", "anchor_protocol", "anchor_deadline", "anchor_parent_exit",
  "guardian_spawn", "guardian_timeout", "guardian_output_limit", "guardian_result"]);
const CLEANUP_STAGES = new Set(["group_kill", "child_reap", "capture_drain", "capture_close", "watch_close", "control_close"]);
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
// its deadline, and accepts success only after owned-group cleanup completes.
export const REMOTE_SAMPLE_GUARDIAN = String.raw`
import json,os,signal,subprocess,sys,time
ANCHOR_CODE=${JSON.stringify(REMOTE_SAMPLE_ANCHOR)}
${REMOTE_SAMPLE_CACHE_GATE}
ANCHOR_STAGES={'anchor_setup','anchor_control_read','anchor_control_write','anchor_worker_spawn','anchor_worker_poll','anchor_protocol','anchor_deadline','anchor_parent_exit'}
child=None
handles=[]
stopping=False
overflow=False
nonblocking=False
ready=False
go_sent=False
worker_code=None
killed=False
reaped=False
cache_enabled=False
output=bytearray()
control_buffer=bytearray()
capture=os.environ.get('EXOCORTEX_REMOTE_SAMPLE_CAPTURE')=='1'
primary=None
cleanup=None
stage='guardian_setup'
def failure(where,error=None,cleaning=False,number=None):
    global primary,cleanup
    if error is not None: number=getattr(error,'errno',None)
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
def close_control(fd):
    if fd not in handles: return
    handles.remove(fd)
    try: os.close(fd)
    except Exception as error: failure('control_close',error,True)
def read_frame(fd):
    global stage
    while b'\n' not in control_buffer:
        stage='control_read'
        try: part=os.read(fd,257-len(control_buffer))
        except BlockingIOError: return None
        if part==b'':
            failure('anchor_lost')
            return None
        control_buffer.extend(part)
        stage='control_protocol'
        if len(control_buffer)>256: raise ValueError('control frame')
    stage='control_protocol'
    line,tail=bytes(control_buffer).split(b'\n',1)
    control_buffer.clear()
    control_buffer.extend(tail)
    frame=json.loads(line.decode('ascii'))
    if type(frame) is not dict or type(frame.get('version')) is not int or frame['version']!=1:
        raise ValueError('control protocol')
    return frame
def cache_commit_allowed():
    if primary is not None or cleanup is not None: return False
    try:
        if stopping: failure('signal_stop')
        elif os.getppid()!=parent: failure('parent_exit')
        elif time.monotonic()>=deadline: failure('deadline')
    except Exception as error: failure('guardian_setup',error)
    return primary is None and cleanup is None
try:
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    parent=int(sys.argv[1])
    timeout=min(60.0,max(0.001,float(sys.argv[2])/1000.0))
    deadline=time.monotonic()+timeout
    if os.getppid()!=parent: failure('parent_exit')
    else:
        stage='cache_setup'
        cache_fds=remote_sample_cache_pass_fds()
        cache_enabled=bool(cache_fds)
        prepare_remote_sample_cache()
        stage='control_create'
        control_read,control_write=os.pipe()
        handles.extend([control_read,control_write])
        status_read,status_write=os.pipe()
        handles.extend([status_read,status_write])
        stage='control_nonblocking'
        os.set_blocking(control_write,False)
        os.set_blocking(status_read,False)
        stage='child_spawn'
        child=subprocess.Popen([sys.executable,'-c',ANCHOR_CODE,str(os.getpid()),str(deadline),str(control_read),str(status_write),*sys.argv[3:]],
            stdin=sys.stdin if capture else subprocess.DEVNULL,stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True,pass_fds=(control_read,status_write)+cache_fds)
        close_control(control_read)
        close_control(status_write)
        if capture and cleanup is None:
            stage='capture_nonblocking'
            os.set_blocking(child.stdout.fileno(),False)
            nonblocking=True
        while cleanup is None:
            if stopping: failure('signal_stop'); break
            if os.getppid()!=parent: failure('parent_exit'); break
            if time.monotonic()>=deadline: failure('deadline'); break
            stage='capture_read'
            drain()
            if overflow: failure('output_limit'); break
            frame=read_frame(status_read)
            if primary is not None: break
            if frame is not None:
                stage='control_protocol'
                kind=frame.get('type')
                if kind=='error':
                    number=frame.get('errno')
                    if set(frame)!={'version','type','stage','errno'} or frame['stage'] not in ANCHOR_STAGES or number is not None and (type(number) is not int or not 1<=number<=4095):
                        raise ValueError('control error')
                    failure(frame['stage'],number=number)
                    break
                if kind=='ready' and not ready and set(frame)=={'version','type'} and not control_buffer:
                    ready=True
                    if stopping: failure('signal_stop'); break
                    if os.getppid()!=parent: failure('parent_exit'); break
                    if time.monotonic()>=deadline: failure('deadline'); break
                    stage='control_write'
                    go=b'{"version":1,"type":"go"}\n'
                    if os.write(control_write,go)!=len(go): raise ValueError('control write')
                    go_sent=True
                elif kind=='done' and go_sent and set(frame)=={'version','type','code'} and type(frame['code']) is int and -255<=frame['code']<=255 and not control_buffer:
                    worker_code=frame['code']
                    if worker_code!=0 and not (cache_enabled and worker_code==3): failure('child_exit')
                    break
                else: raise ValueError('control protocol')
            time.sleep(min(0.05,max(0.0,deadline-time.monotonic())))
except Exception as error:
    failure(stage,error)
finally:
    if child is not None:
        may_reap=False
        try:
            os.killpg(child.pid,signal.SIGKILL)
            killed=True
            may_reap=True
        except ProcessLookupError as error:
            may_reap=True
            failure('group_kill',error,True)
        except Exception as error: failure('group_kill',error,True)
        # A denied kill is never retried. Without observed exit, waiting could
        # hang indefinitely; even a successful kill gets only a bounded reap.
        if may_reap:
            try:
                child.wait(timeout=1.0)
                reaped=True
            except Exception as error: failure('child_reap',error,True)
        if primary is None or primary['stage']!='capture_read':
            try: drain()
            except Exception as error: failure('capture_drain',error,True)
        if capture:
            try: child.stdout.close()
            except Exception as error: failure('capture_close',error,True)
        # The private writer is held only by the now-reaped anchor. Remaining
        # bytes or a still-open writer invalidate the terminal frame. Do not
        # repeat a read that has already failed.
        if killed and reaped and primary is None and cleanup is None:
            try:
                if control_buffer or os.read(status_read,257)!=b'': failure('control_protocol')
            except Exception as error: failure('control_read',error)
    for fd in list(handles): close_control(fd)
if overflow: failure('output_limit')
if stopping: failure('signal_stop')
# The worker completion frame is distinct from the anchor's expected SIGKILL.
# Never poll/reap the anchor before group termination or infer worker success
# from an anchor that exited independently.
if primary is None and cleanup is None and (not ready or not go_sent or worker_code not in ((0,3) if cache_enabled else (0,)) or not killed or not reaped or child is None or child.returncode!=-signal.SIGKILL):
    failure('anchor_lost')
cache_commit_allowed()
failed=primary is not None or cleanup is not None
# Publication has no effect without an explicit per-attempt contract. All
# fallible process/pipe cleanup precedes the cache's final rename commit.
if not failed and cache_enabled:
    # The synchronous caller accepts these bytes only after a zero exit code.
    # Finish output first, so no failed write/flush can follow a cache commit.
    if capture:
        try:
            sys.stdout.buffer.write(output)
            sys.stdout.flush()
        except Exception as error:
            failure('result_publish',error)
            discard_remote_sample_stage()
            os._exit(2)
    if worker_code==0:
        try: publish_remote_sample_cache(cache_commit_allowed)
        except Exception as error:
            failure('cache_publish',error)
            if primary['errno'] not in (1,13): discard_remote_sample_stage()
            # Output is already complete; never append a second JSON result.
            # The caller preserves a generic guardian_result failure instead.
            os._exit(2)
    else: discard_remote_sample_stage()
    # The final rename is the last fallible publication operation. Bypass
    # interpreter shutdown (including implicit output flushes) after commit.
    os._exit(0)
if failed and not (primary is not None and primary['stage'] in ('cache_setup','cache_publish') and primary['errno'] in (1,13)):
    discard_remote_sample_stage()
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
  try { child = (deps.spawnSync || spawnSync)(deps.pythonPath || "python3", [...(options.guardianPrefix || []), "-c", REMOTE_SAMPLE_GUARDIAN,
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
