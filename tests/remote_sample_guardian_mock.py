"""Pure state-machine fixture: all guardian/anchor OS dependencies are fake.

The normal test runner starts only this interpreter. Python source arrives on
stdin, passes an import allowlist, and runs with restricted builtins and fake
OS/process modules. No fixture operation starts a child, touches a real pipe,
waits for a real PID, or sends a signal. Both modes use only invented identities.
"""
import ast
import builtins
import errno
import io
import json
import posixpath
import re
import stat
import sys
import types

request = json.load(sys.stdin)
scenario = request.get("scenario", {})
mode = request.get("mode", "guardian")
assert mode in ("guardian", "anchor", "cache_gate"), "unknown fixture mode"
calls, operations, spawns, frames = [], [], [], []
handlers, descriptors, nonblocking = {}, {}, {}
blocking_attempts = []
state = {"elapsed": 0.0, "cleanup": False, "payload_sent": False,
         "go": False, "terminal": False, "next_fd": 40, "sleep_count": 0,
         "parent_reads": 0, "status_reads": 0, "control_reads": 0}
primary = scenario.get("primary")
cleanup = scenario.get("cleanup")
private = "SYNTHETIC_PRIVATE_PATH_BODY_TOKEN"
namespace = {}
cache_operations, cache_files, cache_handles, cache_counts, cache_positions = [], {}, {}, {}, {}
cache_result, cache_exception = None, None
cache_token = "11111111-2222-4333-8444-555555555555"
cache_contract = {"version": 1, "attemptId": cache_token,
                  "stagePath": "/synthetic/cache/.live-probe." + cache_token + ".pending",
                  "cachePath": "/synthetic/cache/live-probe.json",
                  "lockPath": "/synthetic/cache/remote-sample/live-probe.lock",
                  "statePath": "/synthetic/cache/remote-sample/" + "a" * 64 + ".json"}
cache_state = {"next_fd": 400, "committed": False, "discarded": False, "prepared": False}
CLEANUP_STAGES = {"group_kill", "child_reap", "capture_drain", "capture_close", "watch_close", "control_close"}


def cache_node(path, role, content=b"", permissions=0o600, directory=False):
    number = len(cache_files) + 10
    info = {"st_dev": 5, "st_ino": number,
            "st_mode": (stat.S_IFDIR if directory else stat.S_IFREG) | permissions,
            "st_uid": 501, "st_nlink": 1, "st_size": len(content),
            "st_mtime_ns": 100, "st_ctime_ns": 100}
    info.update(scenario.get("cache_metadata", {}).get(role, {}))
    node = {"role": role, "path": path, "content": bytearray(content), "info": info}
    cache_files[path] = node
    return node


def cache_record(op, role=None, **details):
    entry = {"op": op, "role": role, **details}
    cache_operations.append(entry)
    operations.append({"op": "cache_" + op, "role": role, **details})
    calls.append("cache_" + op)
    global_key = op
    role_key = op + ":" + str(role)
    cache_counts[global_key] = cache_counts.get(global_key, 0) + 1
    cache_counts[role_key] = cache_counts.get(role_key, 0) + 1
    event = scenario.get("cache_event", {})
    event_count = cache_counts[role_key] if "role" in event else cache_counts[global_key]
    if event.get("op") == op and ("role" not in event or event["role"] == role) and event_count == event.get("occurrence", 1):
        state["elapsed"] += event.get("advance_ms", 0) / 1000.0
        if event.get("parent_exit"):
            state["parent_gone"] = True
        if event.get("signal") and 15 in handlers:
            handlers[15](15, None)
    faults = scenario.get("cache_faults", [])
    if "cache_fault" in scenario:
        faults = [scenario["cache_fault"], *faults]
    for fault in faults:
        count = cache_counts[role_key] if "role" in fault else cache_counts[global_key]
        if fault.get("op") == op and ("role" not in fault or fault["role"] == role) and count == fault.get("occurrence", 1):
            number = fault.get("errno", errno.EPERM)
            raise OSError(number, private)
    return entry


def cache_path(path, dir_fd=None):
    if dir_fd is not None:
        path = posixpath.join(cache_handles[dir_fd]["path"], path)
    return posixpath.normpath(path)


def cache_role(path):
    if path == "/synthetic/cache": return "directory"
    if path == "/synthetic/cache/remote-sample": return "state_directory"
    if path == cache_contract["lockPath"]: return "lock"
    if re.fullmatch(r"/synthetic/cache/remote-sample/[a-f0-9]{64}\.json", path): return "state"
    if path.endswith(".pending"): return "stage"
    if path.endswith(".attempting"): return "marker"
    if path.endswith("live-probe.json"): return "target"
    return "unknown"


def cache_info(node, method):
    role = node["role"]
    candidates = scenario.get("cache_stat_mutations", [])
    if "cache_stat_mutation" in scenario:
        candidates = [scenario["cache_stat_mutation"], *candidates]
    for mutation in candidates:
        if mutation.get("role") == role and mutation.get("method") == method and cache_counts.get(method + ":" + role) == mutation.get("occurrence", 1):
            node["info"].update(mutation["fields"])
    return types.SimpleNamespace(**node["info"])


def cache_stat(path, *, dir_fd=None, follow_symlinks=True):
    path = cache_path(path, dir_fd)
    node = cache_files.get(path)
    role = node["role"] if node else cache_role(path)
    cache_record("stat", role, path=path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
    if node is None: raise FileNotFoundError(errno.ENOENT, private)
    return cache_info(node, "stat")


def cache_fstat(fd):
    node = cache_handles.get(fd)
    role = node["role"] if node else "unknown"
    cache_record("fstat", role, fd=fd)
    if node is None: raise OSError(errno.EBADF, private)
    return cache_info(node, "fstat")


def cache_open(path, flags, permissions=0o777, *, dir_fd=None):
    path = cache_path(path, dir_fd)
    node = cache_files.get(path)
    role = node["role"] if node else cache_role(path)
    cache_record("open", role, path=path, flags=flags, permissions=permissions, dir_fd=dir_fd)
    if node is not None and flags & 64 and flags & 128:
        raise FileExistsError(errno.EEXIST, private)
    if node is None:
        if not flags & 64: raise FileNotFoundError(errno.ENOENT, private)
        node = cache_node(path, role, permissions=permissions)
    if flags & 262144 and stat.S_ISLNK(node["info"]["st_mode"]):
        raise OSError(errno.ELOOP, private)
    fd = cache_state["next_fd"]
    cache_state["next_fd"] += 1
    cache_handles[fd] = node
    cache_positions[fd] = 0
    return fd


def cache_read(fd, count):
    node = cache_handles[fd]
    cache_record("read", node["role"], fd=fd, count=count)
    start = cache_positions.get(fd, 0)
    data = bytes(node["content"][start:start + count])
    cache_positions[fd] = start + len(data)
    return data


def cache_write(fd, data):
    node = cache_handles[fd]
    cache_record("write", node["role"], fd=fd, count=len(data))
    count = min(len(data), scenario.get("cache_write_chunk_bytes", len(data)))
    node["content"].extend(bytes(data)[:count])
    node["info"]["st_size"] = len(node["content"])
    return count


def cache_fsync(fd):
    node = cache_handles[fd]
    cache_record("fsync", node["role"], fd=fd)


def cache_rename(source, target, *, src_dir_fd=None, dst_dir_fd=None):
    source, target = cache_path(source, src_dir_fd), cache_path(target, dst_dir_fd)
    node = cache_files.get(source)
    role = node["role"] if node else cache_role(source)
    cache_record("rename", role, source=source, target=target, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
    if node is None: raise FileNotFoundError(errno.ENOENT, private)
    cache_files.pop(source)
    node["path"] = target
    cache_files[target] = node
    if role == "stage": cache_state["committed"] = True
    if role == "marker": cache_state["prepared"] = True


def cache_unlink(path, *, dir_fd=None):
    path = cache_path(path, dir_fd)
    node = cache_files.get(path)
    role = node["role"] if node else cache_role(path)
    cache_record("unlink", role, path=path, dir_fd=dir_fd)
    if node is None: raise FileNotFoundError(errno.ENOENT, private)
    del cache_files[path]
    if role == "stage": cache_state["discarded"] = True


def cache_allow_commit():
    cache_record("allow_commit")
    return scenario.get("allow_commit", True)


cache_node("/synthetic/cache", "directory", permissions=0o700, directory=True)
cache_node("/synthetic/cache/remote-sample", "state_directory", permissions=0o700, directory=True)
cache_handles[200] = cache_node(cache_contract["lockPath"], "lock")
if "cache_schedule" in scenario or "cache_state_raw" in scenario or scenario.get("cache_not_due"):
    now_ms = scenario.get("wall_now_ms", 1800000000000)
    schedule = scenario.get("cache_schedule", {"kind": "lark_im_remote_sample_schedule/v1", "database_key": "a" * 64,
        "account_key": None, "written_at": now_ms, "next_due": now_ms + 900000, "failures": 0, "rotation": 0,
        "observations": {}, "last_outcome": "ok", "cooldowns": {}, "blocked_reason": None})
    raw = scenario.get("cache_state_raw", json.dumps(schedule))
    cache_node("/synthetic/cache/remote-sample/" + "a" * 64 + ".json", "state", raw.encode("utf-8"))
if not scenario.get("cache_missing_stage"):
    cache_node(cache_contract["stagePath"], "stage", b'{"synthetic":true,"kind":"prepared"}\n')
if not scenario.get("cache_missing_target"):
    cache_node(cache_contract["cachePath"], "target", scenario.get("cache_target_raw", '{"synthetic":true,"kind":"old"}\n').encode("utf-8"))


def visit(name, is_cleanup=False):
    calls.append(name)
    expected = cleanup if is_cleanup else primary
    if expected == name or isinstance(expected, list) and name in expected:
        raise PermissionError(errno.EPERM, private)


def syscall(op, fallback, args=None, cleaning=None):
    # Attribute injection to the operation itself. The implementation may be
    # publishing an ERROR from outside its main try block with an older stage.
    stage = fallback
    if cleaning is None:
        cleaning = state["cleanup"] or stage in CLEANUP_STAGES
    operations.append({"op": op, "stage": stage, "args": args or []})
    visit(stage, cleaning)


def encoded_frame(value):
    if isinstance(value, str):
        return value.encode("utf-8")
    return (json.dumps(value, separators=(",", ":")) + "\n").encode("ascii")


def append_frame(fd, value):
    descriptors[fd]["buffer"].extend(encoded_frame(value))


def ready_frame():
    return scenario.get("ready_frame", {"version": 1, "type": "ready"})


def done_frame():
    if "done_frame" in scenario:
        return scenario["done_frame"]
    if scenario.get("anchor_error"):
        return {"version": 1, "type": "error", "stage": scenario.get("anchor_error_stage", "anchor_worker_spawn"),
                "errno": scenario.get("anchor_errno", 1)}
    return {"version": 1, "type": "done", "code": scenario.get("worker_returncode", scenario.get("child_returncode", 0))}


def make_pipe(role):
    read_fd, write_fd = state["next_fd"], state["next_fd"] + 1
    state["next_fd"] += 2
    buffer = bytearray()
    descriptors[read_fd] = {"role": role, "end": "read", "buffer": buffer, "closed": False, "peer": write_fd}
    descriptors[write_fd] = {"role": role, "end": "write", "buffer": buffer, "closed": False, "peer": read_fd}
    nonblocking[str(read_fd)] = False
    nonblocking[str(write_fd)] = False
    return read_fd, write_fd


def pipe():
    syscall("pipe", "control_create")
    role = "control" if not descriptors else "status"
    pair = make_pipe(role)
    operations[-1]["result"] = list(pair)
    return pair


# Anchor mode gets only the two inherited endpoints. Their paired fake ends
# exist solely in this model; no descriptor is ever opened in the host OS.
if mode == "anchor":
    control_pair = make_pipe("control")
    status_pair = make_pipe("status")
    if "control_raw" in scenario:
        descriptors[control_pair[0]]["buffer"].extend(scenario["control_raw"].encode("utf-8"))
    elif "control_frames" in scenario:
        for frame in scenario["control_frames"]:
            append_frame(control_pair[0], frame)
    elif not scenario.get("no_go") and not scenario.get("control_eof"):
        append_frame(control_pair[0], {"version": 1, "type": "go"})


class FakePipe:
    def fileno(self):
        return 17

    def close(self):
        operations.append({"op": "capture_close", "fd": 17})
        visit("capture_close", True)


class FakeTimeoutExpired(Exception):
    pass


class FakeFixtureLimit(BaseException):
    """Escape an unexpected infinite fake loop without invoking any real OS API."""


class FakeChild:
    def __init__(self, pid):
        self.pid = pid
        self.stdout = FakePipe()
        self.returncode = None

    def wait(self, timeout=None):
        bounded = timeout is not None and 0 < timeout <= 1
        calls.append("wait_timeout_bounded" if bounded else "wait_unbounded")
        operations.append({"op": "wait", "pid": self.pid, "timeout": timeout, "after_kill": state["cleanup"]})
        visit("child_reap", True)
        if scenario.get("reap_timeout"):
            raise FakeTimeoutExpired()
        self.returncode = scenario.get("anchor_returncode", -9) if mode == "guardian" else scenario.get("worker_returncode", scenario.get("child_returncode", 0))
        return self.returncode

    def poll(self):
        syscall("poll", "anchor_worker_poll", [self.pid])
        if mode == "guardian":
            calls.append("anchor_poll_forbidden")
            raise FakeFixtureLimit("guardian polled stable anchor")
        if scenario.get("worker_running") or scenario.get("deadline"):
            return None
        self.returncode = scenario.get("worker_returncode", scenario.get("child_returncode", 0))
        return self.returncode


child = FakeChild(222 if mode == "guardian" else 333)


def describe_stream(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if value is fake_sys.stdin:
        return "stdin"
    if value is fake_sys.stdout:
        return "stdout"
    return type(value).__name__


def popen(args, **kwargs):
    syscall("Popen", "child_spawn" if mode == "guardian" else "anchor_worker_spawn")
    argv = list(args)
    if "-c" in argv:
        index = argv.index("-c") + 1
        if index < len(argv):
            argv[index] = "<python-source>"
    spawns.append({"args": argv, "kwargs": {key: list(value) if isinstance(value, tuple) else describe_stream(value)
                                           for key, value in kwargs.items()}, "pid": child.pid})
    if mode == "guardian":
        status_fd = next(fd for fd, item in descriptors.items() if item["role"] == "status" and item["end"] == "read")
        if "status_raw" in scenario:
            descriptors[status_fd]["buffer"].extend(scenario["status_raw"].encode("utf-8"))
        elif "status_frames" in scenario:
            for frame in scenario["status_frames"]:
                append_frame(status_fd, frame)
        elif not scenario.get("no_ready") and not scenario.get("status_eof"):
            append_frame(status_fd, ready_frame())
            if scenario.get("duplicate_ready"):
                append_frame(status_fd, ready_frame())
    return child


def read(fd, count):
    if fd in cache_handles:
        return cache_read(fd, count)
    if fd == 17:
        stage = "capture_drain" if state["cleanup"] else "capture_read"
        operations.append({"op": "read", "stage": stage, "args": [fd, count]})
        visit(stage, state["cleanup"])
        if state["payload_sent"]:
            if scenario.get("live_descendants") and not state["cleanup"]:
                raise BlockingIOError(errno.EAGAIN, "synthetic descendant keeps stdout open")
            return b""
        if mode == "guardian" and not state["go"]:
            raise BlockingIOError(errno.EAGAIN, "synthetic unavailable")
        state["payload_sent"] = True
        return (b"x" * 65537 if scenario.get("overflow") or scenario.get("output_overflow")
                else b'{"outcome":"ok","synthetic":true}')[:count]
    item = descriptors[fd]
    role = item["role"]
    if not nonblocking.get(str(fd), False):
        calls.append("blocking_read_forbidden")
        operations.append({"op": "blocking_read_forbidden", "fd": fd, "role": role})
        raise FakeFixtureLimit("control read on blocking fixture descriptor")
    syscall("read", "control_read" if mode == "guardian" else "anchor_control_read", [fd, count])
    state[role + "_reads"] += 1
    if item["buffer"]:
        max_chunk = scenario.get(role + "_chunk_bytes", count)
        chunk = bytes(item["buffer"][:min(count, max_chunk)])
        del item["buffer"][:len(chunk)]
        if mode == "anchor" and role == "control":
            item.setdefault("observed", bytearray()).extend(chunk)
            if bytes(item["observed"]) == b'{"version":1,"type":"go"}\n':
                state["go"] = True
        return chunk
    eof = scenario.get(role + "_eof")
    if role == "status" and scenario.get("status_eof_after_go") and state["go"]:
        eof = True
    if role == "status" and state.get("killed"):
        eof = True
    if mode == "anchor" and state["terminal"] and not scenario.get("park_until_deadline"):
        eof = True
    if eof:
        return b""
    raise BlockingIOError(errno.EAGAIN, "synthetic unavailable")


def write(fd, data):
    if fd in cache_handles:
        return cache_write(fd, data)
    raw = bytes(data)
    syscall("write", "control_write" if mode == "guardian" else "anchor_control_write", [fd, len(raw)])
    if scenario.get("write_blocked"):
        raise BlockingIOError(errno.EAGAIN, "synthetic unavailable")
    count = min(len(raw), scenario.get("write_chunk_bytes", len(raw)))
    accepted = raw[:count]
    item = descriptors[fd]
    item.setdefault("written", bytearray()).extend(accepted)
    while b"\n" in item["written"]:
        line, _, rest = item["written"].partition(b"\n")
        item["written"] = bytearray(rest)
        try:
            frame = json.loads(line)
        except Exception:
            frame = {"invalid": line.decode("utf-8", errors="replace")}
        frames.append({"role": item["role"], "frame": frame})
        if mode == "guardian" and frame == {"version": 1, "type": "go"}:
            state["go"] = True
            if not scenario.get("deadline") and not scenario.get("no_done") and not scenario.get("status_eof_after_go") and not any(key in scenario for key in ("status_raw", "status_frames")):
                status_fd = next(number for number, value in descriptors.items() if value["role"] == "status" and value["end"] == "read")
                append_frame(status_fd, done_frame())
                if scenario.get("duplicate_done"):
                    append_frame(status_fd, done_frame())
        if mode == "anchor" and isinstance(frame, dict) and frame.get("type") in ("done", "error"):
            state["terminal"] = True
    return count


def close(fd):
    if fd in cache_handles:
        node = cache_handles[fd]
        cache_record("close", node["role"], fd=fd)
        del cache_handles[fd]
        cache_positions.pop(fd, None)
        return
    # close_control classifies even setup closes as independent cleanup errors.
    # Do not let these closes imply that the process group has been signalled.
    stage = "control_close"
    operations.append({"op": "close", "stage": stage, "args": [fd]})
    visit(stage, True)
    descriptors[fd]["closed"] = True


def killpg(pid, number):
    state["cleanup"] = True
    operations.append({"op": "killpg", "pid": pid, "signal": number})
    visit("group_kill", True)
    if scenario.get("already_gone"):
        raise ProcessLookupError(errno.ESRCH, private)
    state["killed"] = True


def set_blocking(fd, blocking):
    stage = "anchor_setup" if mode == "anchor" else "capture_nonblocking" if fd == 17 else "control_nonblocking"
    before = nonblocking.setdefault(str(fd), False)
    attempt = {"fd": fd, "requested_nonblocking": not blocking, "before": before, "after": before, "succeeded": False}
    blocking_attempts.append(attempt)
    try:
        syscall("set_blocking", stage, [fd, blocking], False)
        fail_fd = scenario.get("set_blocking_fail_fd")
        if fail_fd == fd or isinstance(fail_fd, list) and fd in fail_fd:
            raise OSError(scenario.get("set_blocking_fail_errno", errno.EPERM), private)
    except Exception as error:
        attempt["errno"] = getattr(error, "errno", None)
        raise
    nonblocking[str(fd)] = not blocking
    attempt.update({"after": not blocking, "succeeded": True})
    if scenario.get("signal_stop") and fd == 17 and 15 in handlers:
        handlers[15](15, None)


def set_inheritable(fd, inheritable):
    syscall("set_inheritable", "control_create", [fd, inheritable], False)
    descriptors[fd]["inheritable"] = inheritable


def getppid():
    state["parent_reads"] += 1
    expected = 123 if mode == "guardian" else 111
    gone = scenario.get("parent_exit") or state.get("parent_gone")
    if scenario.get("parent_exit_after_go") and state["go"]:
        gone = True
    if scenario.get("parent_exit_after_terminal") and state["terminal"]:
        gone = True
    if scenario.get("parent_exit_after_kill") and state.get("killed"):
        gone = True
    if "parent_exit_after_reads" in scenario and state["parent_reads"] > scenario["parent_exit_after_reads"]:
        gone = True
    return expected - 1 if gone else expected


def sleep(duration):
    calls.append("fake_sleep")
    state["elapsed"] += duration
    state["sleep_count"] += 1
    if scenario.get("signal_after_sleep") and 15 in handlers:
        handlers[15](15, None)
    if state["sleep_count"] > 5000:
        raise FakeFixtureLimit("unexpected unbounded fake loop")


def signal_handler(number, handler):
    syscall("signal", "guardian_setup" if mode == "guardian" else "anchor_setup", [number], False)
    handlers[number] = handler


def immediate_exit(code):
    calls.append("immediate_exit")
    operations.append({"op": "_exit", "code": code})
    raise SystemExit(code)


out_bytes, err_bytes = io.BytesIO(), io.BytesIO()


class FakeOutput:
    @property
    def buffer(self):
        return self

    def fileno(self):
        return 1

    def write(self, value):
        visit("result_publish")
        return out_bytes.write(value.encode() if isinstance(value, str) else value)

    def flush(self):
        if scenario.get("publish_flush"):
            calls.append("publish_flush")
            raise PermissionError(errno.EPERM, private)


out = FakeOutput()
err = io.TextIOWrapper(err_bytes, encoding="utf-8", write_through=True)
argv = ["guardian", "123", "5" if scenario.get("deadline") else "5000", "synthetic", "worker-argument"]
if mode == "anchor":
    argv = ["anchor", "111", "0.005" if scenario.get("deadline") else "5.0", str(control_pair[0]), str(status_pair[1]), "synthetic", "worker-argument"]
fake_sys = types.SimpleNamespace(argv=scenario.get("argv", argv), executable="synthetic-python",
    stdin=io.StringIO("{}"), stdout=out, stderr=err, exit=lambda code=0: (_ for _ in ()).throw(SystemExit(code)))
fake_environ = {"EXOCORTEX_REMOTE_SAMPLE_CAPTURE": "0" if scenario.get("background") else "1"}
if mode == "cache_gate" or scenario.get("cache_enabled"):
    fake_environ.update({"EXOCORTEX_REMOTE_SAMPLE_PUBLICATION": json.dumps(cache_contract), "EXOCORTEX_REMOTE_SAMPLE_LOCK_FD": "200"})
fake_environ.update(scenario.get("env", {}))
for key in list(fake_environ):
    if fake_environ[key] is None: del fake_environ[key]
fake_path = types.SimpleNamespace(dirname=posixpath.dirname, basename=posixpath.basename, join=posixpath.join,
    abspath=lambda path: posixpath.normpath(path if posixpath.isabs(path) else posixpath.join("/synthetic/cwd", path)))
fake_os = types.SimpleNamespace(environ=fake_environ,
    getpid=lambda: 111 if mode == "guardian" else 222, getppid=getppid, pipe=pipe, close=close,
    read=read, write=write, killpg=killpg, set_blocking=set_blocking, set_inheritable=set_inheritable, _exit=immediate_exit,
    getuid=lambda: 501, path=fake_path, stat=cache_stat, fstat=cache_fstat, open=cache_open,
    fsync=cache_fsync, rename=cache_rename, unlink=cache_unlink, O_RDONLY=0, O_WRONLY=1, O_CREAT=64,
    O_EXCL=128, O_NOFOLLOW=262144, O_NONBLOCK=2048, O_DIRECTORY=65536)
fake_signal = types.SimpleNamespace(SIGTERM=15, SIGINT=2, SIGKILL=9, SIG_DFL=0, SIG_IGN=1, signal=signal_handler)
fake_subprocess = types.SimpleNamespace(Popen=popen, PIPE=-1, DEVNULL=-3, TimeoutExpired=FakeTimeoutExpired)
fake_time = types.SimpleNamespace(monotonic=lambda: state["elapsed"],
    time=lambda: scenario.get("wall_now_ms", 1800000000000) / 1000.0 + state["elapsed"], sleep=sleep)
replacement = {"os": fake_os, "signal": fake_signal, "subprocess": fake_subprocess,
               "sys": fake_sys, "time": fake_time}
# Reject dependencies before execution. Even a new nested import must use a
# fake module; imports cannot fall through to real process or filesystem APIs.
allowed = {**replacement, "json": json, "re": re, "stat": stat}
tree = ast.parse(request["code"], "<mock-" + mode + ">")
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        assert all(alias.name in allowed for alias in node.names), "unmocked import"
    elif isinstance(node, ast.ImportFrom):
        assert node.level == 0 and node.module in allowed, "unmocked import"


def fake_import(name, *_args, **_kwargs):
    assert name in allowed, "unmocked import"
    return allowed[name]


safe_builtins = dict(vars(builtins))
safe_builtins["__import__"] = fake_import
for name in ["open", "input", "breakpoint", "eval", "exec", "compile"]:
    safe_builtins.pop(name, None)
namespace.update({"__name__": "__main__", "__builtins__": safe_builtins})
exit_code, uncaught = 0, None
try:
    exec(compile(tree, "<mock-" + mode + ">", "exec"), namespace)
    if mode == "cache_gate":
        action = scenario.get("cache_action", "publish")
        functions = {"publish": "publish_remote_sample_cache", "prepare": "prepare_remote_sample_cache",
                     "discard": "discard_remote_sample_stage", "pass_fds": "remote_sample_cache_pass_fds"}
        assert action in functions, "unknown cache fixture action"
        try:
            cache_result = namespace[functions[action]](cache_allow_commit) if action == "publish" else namespace[functions[action]]()
        except Exception as error:
            cache_exception = {"name": type(error).__name__, "errno": getattr(error, "errno", None)}
except SystemExit as error:
    exit_code = error.code
except BaseException as error:
    uncaught = type(error).__name__

print(json.dumps({"exit_code": exit_code, "uncaught": uncaught, "stdout": out_bytes.getvalue().decode(),
    "stderr": err_bytes.getvalue().decode(), "calls": calls, "operations": operations, "spawns": spawns,
    "frames": frames, "nonblocking": nonblocking, "blocking_attempts": blocking_attempts, "fake_elapsed_ms": state["elapsed"] * 1000,
    "pipe_closed": {str(fd): item["closed"] for fd, item in descriptors.items()},
    "go_sent": state["go"], "killed": state.get("killed", False),
    "cache_result": cache_result, "cache_exception": cache_exception, "cache_operations": cache_operations,
    "cache_files": {path: {"role": node["role"], "size": node["info"]["st_size"],
                           "content": bytes(node["content"]).decode("utf-8", errors="replace")} for path, node in cache_files.items()},
    "cache_committed": cache_state["committed"], "cache_discarded": cache_state["discarded"], "cache_prepared": cache_state["prepared"],
    "primary": namespace.get("primary"), "cleanup": namespace.get("cleanup")}))
