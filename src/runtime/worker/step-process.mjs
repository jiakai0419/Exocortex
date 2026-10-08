// @ts-check
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { WORKER_STEP_ANCHOR } from "./remote-sample-anchor.mjs";
import { safeGuardianDiagnostic } from "./remote-sample-process.mjs";

export const STEP_MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const CLEANUP_GRACE_MS = 2000;

// The unreaped, living anchor pins the group's identity through its one kill.
// The private status pipe reports the step's exit, never the anchor's exit.
// Neither normal completion nor inherited output pipes may bypass cleanup.
export const WORKER_STEP_GUARDIAN = String.raw`
import base64,json,os,signal,subprocess,sys,time
ANCHOR_CODE=${JSON.stringify(WORKER_STEP_ANCHOR)}
ANCHOR_STAGES={'anchor_setup','anchor_control_read','anchor_control_write','anchor_worker_spawn','anchor_worker_poll','anchor_protocol','anchor_deadline','anchor_parent_exit'}
child=None
handles=[]
streams=[]
output=[bytearray(),bytearray()]
control_buffer=bytearray()
stopping=False
ready=False
go_sent=False
worker_code=None
killed=False
reaped=False
primary=None
cleanup=None
stage='guardian_setup'
parent=None
deadline=None
limit=0
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
def active():
    if stopping: failure('signal_stop')
    elif os.getppid()!=parent: failure('parent_exit')
    elif time.monotonic()>=deadline: failure('deadline')
    return primary is None and cleanup is None
def close_control(fd):
    if fd not in handles: return
    handles.remove(fd)
    try: os.close(fd)
    except Exception as error: failure('control_close',error,True)
def drain():
    # One chunk per stream per turn. A continuously writing descendant cannot
    # starve the deadline, parent check or the other stream.
    progress=False
    for index,stream in streams:
        available=limit+1-sum(map(len,output))
        if available<=0: failure('output_limit'); break
        try: part=os.read(stream.fileno(),min(65536,available))
        except BlockingIOError: continue
        if part:
            output[index].extend(part)
            progress=True
    if sum(map(len,output))>limit: failure('output_limit')
    return progress
def read_frame(fd):
    global stage
    # Reads are also bounded; malformed or continuous control cannot occupy
    # this loop indefinitely.
    while b'\n' not in control_buffer:
        stage='control_read'
        try: part=os.read(fd,257-len(control_buffer))
        except BlockingIOError: return None
        if part==b'': failure('anchor_lost'); return None
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
try:
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    parent=int(sys.argv[1])
    timeout=float(sys.argv[2])/1000.0
    limit=int(sys.argv[3])
    if timeout<=0 or limit<1: raise ValueError('guardian bounds')
    deadline=time.monotonic()+timeout
    if active():
        stage='control_create'
        control_read,control_write=os.pipe()
        handles.extend([control_read,control_write])
        status_read,status_write=os.pipe()
        handles.extend([status_read,status_write])
        stage='control_nonblocking'
        os.set_blocking(control_write,False)
        os.set_blocking(status_read,False)
        stage='child_spawn'
        child=subprocess.Popen([sys.executable,'-c',ANCHOR_CODE,str(os.getpid()),str(deadline),str(control_read),str(status_write),*sys.argv[4:]],
            stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            start_new_session=True,close_fds=True,pass_fds=(control_read,status_write))
        close_control(control_read)
        close_control(status_write)
        stage='capture_nonblocking'
        for index,stream in enumerate([child.stdout,child.stderr]):
            os.set_blocking(stream.fileno(),False)
            streams.append((index,stream))
        while active():
            stage='capture_read'
            progress=drain()
            if primary is not None: break
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
                    if not active(): break
                    stage='control_write'
                    go=b'{"version":1,"type":"go"}\n'
                    if os.write(control_write,go)!=len(go): raise ValueError('control write')
                    go_sent=True
                elif kind=='done' and go_sent and set(frame)=={'version','type','code'} and type(frame['code']) is int and -255<=frame['code']<=255 and not control_buffer:
                    worker_code=frame['code']
                    break
                else: raise ValueError('control protocol')
            if not progress: time.sleep(min(0.01,max(0.0,deadline-time.monotonic())))
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
        # Do not poll/reap the anchor before group termination. In particular,
        # EPERM is one failed attempt, never a signal retry or another target.
        if may_reap:
            try:
                child.wait(timeout=1.0)
                reaped=True
                if child.returncode is None: failure('child_reap',cleaning=True)
                elif child.returncode!=-signal.SIGKILL: failure('anchor_lost')
            except Exception as error: failure('child_reap',error,True)
        if primary is None or primary['stage']!='capture_read':
            try:
                # Cleanup drain is independently bounded, including a writer
                # that escaped the owned group. Never wait for pipe EOF.
                drain_until=time.monotonic()+0.1
                draining=False
                while time.monotonic()<drain_until:
                    draining=drain()
                    if not draining: break
                    if primary is not None and primary['stage']=='output_limit': break
                if draining and time.monotonic()>=drain_until: failure('capture_drain',cleaning=True)
            except Exception as error: failure('capture_drain',error,True)
        for stream in [child.stdout,child.stderr]:
            try: stream.close()
            except Exception as error: failure('capture_close',error,True)
        if killed and reaped and primary is None and cleanup is None:
            try:
                if control_buffer or os.read(status_read,257)!=b'': failure('control_protocol')
            except Exception as error: failure('control_read',error)
    for fd in list(handles): close_control(fd)
if primary is None and cleanup is None and (not ready or not go_sent or worker_code is None or not killed or not reaped or child is None or child.returncode!=-signal.SIGKILL):
    failure('anchor_lost')
try:
    # A late parent loss, signal or deadline cannot publish a positive result.
    if parent is not None and deadline is not None: active()
    diagnostic={'version':1,'primary':primary,'cleanup':cleanup} if primary is not None or cleanup is not None else None
    envelope={'version':1,'code':worker_code,'stdout':base64.b64encode(output[0]).decode('ascii'),
        'stderr':base64.b64encode(output[1]).decode('ascii'),'diagnostic':diagnostic}
    sys.stdout.write(json.dumps(envelope,separators=(',',':'))+'\n')
    sys.stdout.flush()
except Exception:
    # Group cleanup is complete. Never retry a failed output channel or expose
    # Python exception text/private paths during interpreter shutdown.
    os._exit(2)
os._exit(0)
`;

/** @param {unknown} error
 * @param {ReturnType<typeof safeGuardianDiagnostic>} previous */
function failure(stage, error = null, previous = null) {
  const number = error && typeof error === "object" && "errno" in error && typeof error.errno === "number" ? Math.abs(error.errno) : null;
  return /** @type {NonNullable<ReturnType<typeof safeGuardianDiagnostic>>} */ (safeGuardianDiagnostic({ version: 1, primary: previous?.primary || {
    stage, errno: typeof number === "number" && Number.isSafeInteger(number) && number >= 1 && number <= 4095 ? number : null,
  }, cleanup: previous?.cleanup || null }));
}

function exactEnvelope(value) {
  return value && typeof value === "object" && !Array.isArray(value) && value.version === 1 &&
    Object.keys(value).sort().join(",") === "code,diagnostic,stderr,stdout,version" &&
    (value.code === null || Number.isSafeInteger(value.code) && value.code >= -255 && value.code <= 255) &&
    [value.stdout, value.stderr].every(text => typeof text === "string" && text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text));
}

/** Synchronous worker protocol around a detached, bounded group guardian.
 * Injection replaces this OS spawn, never the guardian's result contract.
 * @returns {{status:number|null,signal:string|null,stdout:string,stderr:string,error?:Error,
 * guardian_diagnostic?:NonNullable<ReturnType<typeof safeGuardianDiagnostic>>}} */
export function runGuardedWorkerStep(command, args, options, deps = {}) {
  const timeout = Number(options.timeout);
  const limit = Number(options.maxBuffer ?? STEP_MAX_OUTPUT_BYTES);
  let child;
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > STEP_MAX_OUTPUT_BYTES) {
    return { status: null, signal: null, stdout: "", stderr: "", guardian_diagnostic: failure("guardian_setup") };
  }
  try {
    child = (deps.spawnSync || spawnSync)(deps.pythonPath || "python3", ["-c", WORKER_STEP_GUARDIAN,
      String(process.pid), String(timeout), String(limit), command, ...args], {
      encoding: "utf8", env: options.env || process.env, detached: true,
      // Base64 can grow the original bounded byte streams by 4/3. The private
      // envelope must fit without triggering an early outer termination.
      maxBuffer: Math.ceil((limit + 1) / 3) * 4 + 16 * 1024,
      timeout: timeout + CLEANUP_GRACE_MS, killSignal: "SIGTERM",
    });
  } catch (error) {
    return { status: null, signal: null, stdout: "", stderr: "", guardian_diagnostic: failure("guardian_spawn", error) };
  }
  let value;
  try { value = JSON.parse(String(child.stdout || "")); } catch { /* Fail closed below. */ }
  const valid = exactEnvelope(value);
  let diagnostic = valid && value.diagnostic !== null ? safeGuardianDiagnostic(value.diagnostic) : null;
  if (child.error || child.signal) diagnostic = failure(child.error?.code === "ETIMEDOUT" ? "guardian_timeout"
    : child.error?.code === "ENOBUFS" ? "guardian_output_limit" : "guardian_spawn", child.error, diagnostic);
  else if (child.status !== 0 || !valid || value.diagnostic !== null && !diagnostic || value.code === null && !diagnostic) {
    diagnostic = failure("guardian_result", null, diagnostic);
  }
  const stdout = valid ? Buffer.from(value.stdout, "base64") : Buffer.alloc(0);
  const stderr = valid ? Buffer.from(value.stderr, "base64") : Buffer.alloc(0);
  if (stdout.length + stderr.length > limit) diagnostic = failure("output_limit", null, diagnostic);
  const code = valid ? value.code : null;
  const signal = typeof code === "number" && code < 0
    ? Object.keys(constants.signals).find(name => constants.signals[name] === -code) || "SIGUNKNOWN" : null;
  return { status: diagnostic || signal ? null : code, signal,
    stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"),
    ...(diagnostic ? { guardian_diagnostic: diagnostic } : {}) };
}
