// @ts-check
import { spawnSync } from "node:child_process";

export const REMOTE_SAMPLE_TIMEOUT_MS = 60_000;
const CLEANUP_GRACE_MS = 2000;

// One short-lived supervisor serves background and synchronous callers. It
// never schedules work. Capture mode drains a bounded pipe without blocking
// its deadline, and publishes output only after all descendants are killed.
export const REMOTE_SAMPLE_GUARDIAN = String.raw`
import os,select,signal,subprocess,sys,time
child=None
events=None
stopping=False
exited=False
overflow=False
output=bytearray()
capture=os.environ.get('EXOCORTEX_REMOTE_SAMPLE_CAPTURE')=='1'
def stop(_signal,_frame):
    global stopping
    stopping=True
def drain():
    global overflow
    if not capture or child is None: return
    while len(output)<=65536:
        try: part=os.read(child.stdout.fileno(),65537-len(output))
        except BlockingIOError: break
        if not part: break
        output.extend(part)
    overflow=len(output)>65536
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
try:
    parent=int(sys.argv[1])
    timeout=min(60.0,max(0.001,float(sys.argv[2])/1000.0))
    deadline=time.monotonic()+timeout
    if os.getppid()!=parent: sys.exit(0)
    child=subprocess.Popen(sys.argv[3:],stdin=sys.stdin if capture else subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    if capture: os.set_blocking(child.stdout.fileno(),False)
    if not hasattr(os,'waitid'):
        events=select.kqueue()
        events.control([select.kevent(child.pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT)],0,0)
    while not stopping and os.getppid()==parent and time.monotonic()<deadline:
        drain()
        if overflow: break
        # Observe without reaping: retain our process-group identity until
        # descendants are killed, then reap the leader in finally.
        if events is not None:
            exited=bool(events.control(None,1,0))
        else:
            exited=os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is not None
        if exited: break
        time.sleep(min(0.05,max(0.0,deadline-time.monotonic())))
finally:
    if child is not None:
        try: os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        child.wait()
        drain()
    if events is not None: events.close()
if capture:
    if exited and child.returncode==0 and not stopping and not overflow:
        sys.stdout.buffer.write(output)
    else:
        sys.stdout.write('{"outcome":"failed","reason":"sample_process_failed","next_due":null}\n')
        sys.exit(2)
`;

/** Preserve synchronous JSON results while the same guardian owns group
 * cleanup. The outer timeout sends SIGTERM and leaves cleanup grace; it must
 * never SIGKILL the guardian before its finally block runs. */
export function runGuardedRemoteSampleProcess(command, args, options = {}, deps = {}) {
  const timeout = Math.min(REMOTE_SAMPLE_TIMEOUT_MS, Math.max(1, Number(deps.timeoutMs) || REMOTE_SAMPLE_TIMEOUT_MS));
  return (deps.spawnSync || spawnSync)(deps.pythonPath || "python3", ["-c", REMOTE_SAMPLE_GUARDIAN,
    String(process.pid), String(timeout), command, ...args], {
    input: options.input, encoding: "utf8", maxBuffer: 64 * 1024, detached: true,
    env: { ...(options.env || process.env), EXOCORTEX_REMOTE_SAMPLE_CAPTURE: "1", EXOCORTEX_REMOTE_SAMPLE_INPUT: "" },
    timeout: timeout + CLEANUP_GRACE_MS, killSignal: "SIGTERM",
  });
}
