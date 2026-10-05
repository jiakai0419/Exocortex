"""Pure state-machine fixture: every guardian OS/process dependency is fake.

This harness never starts a process, opens a watcher, signals a PID, or reads a
database. The normal test runner starts only this Python interpreter. Guardian
source arrives on stdin and imports only the in-memory replacement modules.
"""
import ast
import builtins
import errno
import io
import json
import sys
import types

request = json.load(sys.stdin)
scenario = request.get("scenario", {})
calls = []
state = {"elapsed": 0.0, "cleanup": False, "payload_sent": False}
handlers = {}
primary = scenario.get("primary")
cleanup = scenario.get("cleanup")
private = "SYNTHETIC_PRIVATE_PATH_BODY_TOKEN"


def visit(name, is_cleanup=False):
    calls.append(name)
    expected = cleanup if is_cleanup else primary
    if expected == name or isinstance(expected, list) and name in expected:
        raise PermissionError(errno.EPERM, private)


class FakePipe:
    def fileno(self):
        return 17


class FakeChild:
    pid = 222
    stdout = FakePipe()
    returncode = None

    def wait(self, timeout=None):
        calls.append("wait_timeout_bounded" if timeout is not None and 0 < timeout <= 1 else "wait_unbounded")
        visit("child_reap", True)
        if scenario.get("reap_timeout"):
            raise FakeTimeoutExpired()
        self.returncode = scenario.get("child_returncode", 0)
        return self.returncode


class FakeTimeoutExpired(Exception):
    pass


child = FakeChild()


def popen(*args, **kwargs):
    visit("child_spawn")
    return child


def read(_fd, count):
    visit("capture_drain" if state["cleanup"] else "capture_read", state["cleanup"])
    if state["payload_sent"]:
        return b""
    state["payload_sent"] = True
    return (b"x" * 65537 if scenario.get("overflow") else b'{"outcome":"ok","synthetic":true}')[:count]


def killpg(_pid, _signal):
    state["cleanup"] = True
    visit("group_kill", True)
    if scenario.get("already_gone"):
        raise ProcessLookupError(errno.ESRCH, private)


def set_blocking(_fd, _blocking):
    visit("capture_nonblocking")
    if scenario.get("signal_stop"):
        handlers[15](15, None)


def sleep(duration):
    calls.append("fake_sleep")
    state["elapsed"] += duration


class FakeWatch:
    def control(self, changes, *_args):
        visit("watch_register" if changes is not None else "watch_poll")
        if changes is not None or scenario.get("deadline"):
            return []
        return [object()]

    def close(self):
        visit("watch_close", True)


def kqueue():
    visit("watch_create")
    return FakeWatch()


def waitid(*_args):
    visit("wait_observe")
    return None if scenario.get("deadline") else object()


def signal_handler(number, handler):
    visit("guardian_setup")
    handlers[number] = handler


def immediate_exit(code):
    calls.append("immediate_exit")
    raise SystemExit(code)


out_bytes, err_bytes = io.BytesIO(), io.BytesIO()


class FakeOutput:
    @property
    def buffer(self):
        return self

    def write(self, value):
        visit("result_publish")
        return out_bytes.write(value.encode() if isinstance(value, str) else value)

    def flush(self):
        if scenario.get("publish_flush"):
            calls.append("publish_flush")
            raise PermissionError(errno.EPERM, private)


out = FakeOutput()
err = io.TextIOWrapper(err_bytes, encoding="utf-8", write_through=True)
fake_sys = types.SimpleNamespace(argv=["guardian", "123", "5" if scenario.get("deadline") else "5000", "synthetic"],
    stdin=io.StringIO("{}"), stdout=out, stderr=err, exit=lambda code=0: (_ for _ in ()).throw(SystemExit(code)))
fake_os = types.SimpleNamespace(environ={"EXOCORTEX_REMOTE_SAMPLE_CAPTURE": "0" if scenario.get("background") else "1"},
    getppid=lambda: 122 if scenario.get("parent_exit") else 123, read=read, killpg=killpg, set_blocking=set_blocking,
    P_PID=1, WEXITED=2, WNOHANG=4, WNOWAIT=8, _exit=immediate_exit)
if scenario.get("waitid"):
    fake_os.waitid = waitid
fake_select = types.SimpleNamespace(kqueue=kqueue, kevent=lambda *args, **kwargs: object(),
    KQ_FILTER_PROC=1, KQ_EV_ADD=2, KQ_EV_ONESHOT=4, KQ_NOTE_EXIT=8)
fake_signal = types.SimpleNamespace(SIGTERM=15, SIGINT=2, SIGKILL=9, signal=signal_handler)
fake_subprocess = types.SimpleNamespace(Popen=popen, PIPE=-1, DEVNULL=-3, TimeoutExpired=FakeTimeoutExpired)
fake_time = types.SimpleNamespace(monotonic=lambda: state["elapsed"], sleep=sleep)
replacement = {"os": fake_os, "select": fake_select, "signal": fake_signal, "subprocess": fake_subprocess,
    "sys": fake_sys, "time": fake_time}
# Reject new dependencies before executing the state machine. In particular,
# no import can fall back to a real process, signal, file, or watcher module.
allowed = {**replacement, "json": json}
tree = ast.parse(request["code"], "<mock-guardian>")
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
namespace = {"__name__": "__main__", "__builtins__": safe_builtins}
exit_code, uncaught = 0, None
try:
    exec(compile(tree, "<mock-guardian>", "exec"), namespace)
except SystemExit as error:
    exit_code = error.code
except BaseException as error:
    uncaught = type(error).__name__

print(json.dumps({"exit_code": exit_code, "uncaught": uncaught, "stdout": out_bytes.getvalue().decode(),
    "stderr": err_bytes.getvalue().decode(), "calls": calls, "fake_elapsed_ms": state["elapsed"] * 1000,
    "primary": namespace.get("primary"), "cleanup": namespace.get("cleanup")}))
