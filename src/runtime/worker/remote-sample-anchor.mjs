// @ts-check
// The anchor keeps the process-group leader alive while the worker may exit.
// Its private control descriptors are never inherited by the actual worker.
export const REMOTE_SAMPLE_ANCHOR = String.raw`
import json,os,subprocess,sys,time
worker=None
control=None
status=None
parent=None
deadline=None
primary=None
stage='anchor_setup'
status_failed=False
terminal_sent=False
control_failed=False
control_lost=False
buffer=bytearray()
worker_fds=()
def failure(where,error=None):
    global primary
    if primary is not None: return
    number=getattr(error,'errno',None)
    primary={'stage':where,'errno':number if type(number) is int and 1<=number<=4095 else None}
def send(frame):
    global status_failed
    data=(json.dumps(frame,separators=(',',':'))+'\n').encode('ascii')
    if len(data)>256: raise ValueError('control frame')
    try:
        if os.write(status,data)!=len(data): raise ValueError('control write')
    except Exception:
        status_failed=True
        raise
def read_control():
    global control_failed
    try: return os.read(control,257-len(buffer))
    except BlockingIOError: return None
    except Exception:
        control_failed=True
        raise
def active():
    if os.getppid()!=parent:
        failure('anchor_parent_exit')
        return False
    if time.monotonic()>=deadline:
        failure('anchor_deadline')
        return False
    return True
try:
    parent=int(sys.argv[1])
    deadline=float(sys.argv[2])
    control=int(sys.argv[3])
    status=int(sys.argv[4])
    os.set_blocking(control,False)
    os.set_blocking(status,False)
    if os.environ.get('EXOCORTEX_REMOTE_SAMPLE_PUBLICATION') is not None:
        inherited=os.environ.get('EXOCORTEX_REMOTE_SAMPLE_LOCK_FD','')
        if not inherited.isascii() or not inherited.isdecimal() or int(inherited)<200:
            raise ValueError('cache lock unavailable')
        worker_fds=(int(inherited),)
    if active():
        stage='anchor_control_write'
        send({'version':1,'type':'ready'})
        go=False
        while active():
            stage='anchor_control_read'
            part=read_control()
            if part==b'':
                control_failed=True
                control_lost=True
                failure('anchor_protocol')
                break
            if part is not None:
                buffer.extend(part)
                stage='anchor_protocol'
                if len(buffer)>256: raise ValueError('control frame')
                if b'\n' in buffer:
                    line,tail=bytes(buffer).split(b'\n',1)
                    frame=json.loads(line.decode('ascii'))
                    if tail or type(frame) is not dict or set(frame)!={'version','type'} or type(frame['version']) is not int or frame['version']!=1 or frame['type']!='go':
                        raise ValueError('control protocol')
                    buffer.clear()
                    go=True
                    break
            time.sleep(min(0.05,max(0.0,deadline-time.monotonic())))
        if go and active():
            stage='anchor_worker_spawn'
            worker=subprocess.Popen(sys.argv[5:],stdin=sys.stdin,stdout=sys.stdout,stderr=subprocess.DEVNULL,
                start_new_session=False,close_fds=True,pass_fds=worker_fds)
            while active():
                stage='anchor_control_read'
                part=read_control()
                if part is not None:
                    control_failed=part==b''
                    control_lost=part==b''
                    failure('anchor_protocol')
                    break
                stage='anchor_worker_poll'
                code=worker.poll()
                if code is not None:
                    if type(code) is not int or not -255<=code<=255:
                        stage='anchor_protocol'
                        raise ValueError('worker result')
                    stage='anchor_control_write'
                    send({'version':1,'type':'done','code':code})
                    terminal_sent=True
                    break
                time.sleep(min(0.05,max(0.0,deadline-time.monotonic())))
except Exception as error:
    failure(stage,error)
if primary is not None and not terminal_sent and not status_failed and status is not None:
    try:
        send({'version':1,'type':'error',**primary})
        terminal_sent=True
    except Exception as error:
        failure('anchor_control_write',error)
if status_failed and status is not None:
    # Expose channel loss while retaining the group leader. Never retry send.
    try: os.close(status)
    except Exception: pass
# Do not exit when the worker completes or an ordinary setup/control error
# occurs. The guardian still owns one group kill. Loss of that guardian or
# the original deadline plus finite cleanup grace bounds the anchor itself;
# neither condition transfers group-kill ownership to this process.
try:
    if parent is not None and deadline is not None:
        while not control_lost and os.getppid()==parent and time.monotonic()<deadline+1.0:
            if not control_failed and control is not None:
                try:
                    part=read_control()
                    if part==b'': break
                except Exception: control_failed=True
            time.sleep(min(0.05,max(0.0,deadline+1.0-time.monotonic())))
except Exception: pass
# Avoid Popen finalizers implicitly polling again after a failed worker poll.
os._exit(2)
`;
