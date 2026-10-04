import assert from "node:assert/strict";
import test from "node:test";
import { parseLaunchdState, probeService, start } from "../src/runtime/service/launchd.mjs";
import { fixture } from "./helpers/service-fixture.mjs";

// Invented hierarchy and values only; no real or sanitized launchctl output.
const root = (lines) => `gui/902/com.example.synthetic-worker = {\n${lines.join("\n")}\n}\n`;
const top = { state: "running", pid: "8241", "last exit code": "0" };
const fields = Object.entries(top).map(([key, value]) => `\t${key} = ${value}`);
const nested = ["\tbatch group = {", "\t\tstate = active", "\t\tpid = 9352", "\t\tlast exit code = 17", "\t}"];
const probe = (stdout) => probeService({ run: () => ({ status: 0, stdout, stderr: "" }) });

for (const before of [true, false]) {
  test(`only service fields count when nested fields occur ${before ? "before" : "after"} them`, () => {
    const output = root(before ? [...nested, ...fields] : [...fields, ...nested]);
    assert.deepEqual(parseLaunchdState(output), top);
    assert.deepEqual(probe(output), { status: "running", loaded: true, state: "running", pid: 8241, last_exit_code: 0, command_status: 0 });
  });
}

test("nested running evidence cannot supply missing service state or process identity", () => {
  const output = root(["\tbatch group = {", "\t\tstate = running", "\t\tpid = 9352", "\t\tlast exit code = 17", "\t}"]);
  assert.deepEqual(parseLaunchdState(output), {});
  assert.deepEqual(probe(output), { status: "loaded", loaded: true, state: null, pid: null, last_exit_code: null, command_status: 0 });
});

test("nested process evidence cannot upgrade a waiting service to running", () => {
  const output = root(["\tstate = waiting", "\tchild = {", "\t\tstate = running", "\t\tpid = 9352", "\t}"]);
  assert.deepEqual(parseLaunchdState(output), { state: "waiting" });
  assert.equal(probe(output).status, "loaded");
  assert.equal(probe(output).pid, null);
});

test("deeper groups and comments never replace direct service fields", () => {
  const output = root([...fields, "\t# state = stopped", "\t# }", "\tgroup = {", "\t\t// pid = 42", "\t\tinner = {", "\t\t\tstate = waiting", "\t\t\tpid = 9352", "\t\t}", "\t}"]);
  assert.deepEqual(parseLaunchdState(output), top);
});

for (const duplicate of ["state = waiting", "state = running", "pid = 8241", "last exit code = 1"]) {
  test(`duplicate direct service field is ambiguous: ${duplicate}`, () => {
    const output = root([...fields, `\t${duplicate}`]);
    assert.deepEqual(parseLaunchdState(output), {});
    assert.equal(probe(output).status, "loaded");
    assert.equal(probe(output).state, null);
  });
}

for (const key of Object.keys(top)) {
  for (const duplicate of [false, true]) {
    test(`empty direct ${key} is invalid, duplicate=${duplicate}`, () => {
      const output = root([...(duplicate ? fields : fields.filter((line) => !line.startsWith(`\t${key} =`))), `\t${key} =   `]);
      assert.deepEqual(parseLaunchdState(output), {});
      assert.equal(probe(output).status, "loaded");
      assert.equal(probe(output).state, null);
    });
  }
}

for (const key of Object.keys(top)) {
  for (const before of [false, true]) {
    test(`direct ${key} cannot be a block, before=${before}`, () => {
      const block = [`\t${key} = {`, "\t\tvalue = invented", "\t}"];
      const output = root(before ? [...block, ...fields] : [...fields, ...block]);
      assert.deepEqual(parseLaunchdState(output), {});
      assert.equal(probe(output).status, "loaded");
      assert.equal(probe(output).pid, null);
    });
  }
  test(`a ${key} assignment cannot masquerade as a root service block`, () => {
    const output = `${key} = {\n${fields.join("\n")}\n}\n`;
    assert.deepEqual(parseLaunchdState(output), {});
    assert.equal(probe(output).status, "loaded");
  });
}

for (const [name, output] of [
  ["missing root close", root(fields).trimEnd().slice(0, -1)],
  ["extra root close", `${root(fields)}}\n`],
  ["trailing top-level fields", `${root(fields)}state = waiting\n`],
  ["unclosed inner group", root([...fields, "\tchild = {", "\t\tvalue = synthetic"])],
  ["misindented child close", root([...fields, "\tchild = {", "\t\tvalue = synthetic", "\t\t}"])],
  ["unscoped extra indentation", root(["\tstate = running", "\t\tpid = 8241"])],
  ["flat mixed indentation", "state = running\n\tpid = 8241\n"],
  ["flat duplicate state", "state = running\npid = 8241\nstate = waiting\n"],
]) {
  test(`malformed or ambiguous structure has no positive runtime fields: ${name}`, () => {
    assert.deepEqual(parseLaunchdState(output), {});
    assert.equal(probe(output).status, "loaded");
    assert.equal(probe(output).pid, null);
  });
}

test("flat synthetic status fixtures remain supported with uniform indentation", () => {
  for (const indent of ["", "\t", "  "]) {
    assert.deepEqual(parseLaunchdState(Object.entries(top).map(([key, value]) => `${indent}${key} = ${value}`).join("\n")), top);
  }
});

test("braces inside ordinary scalar values do not change structure", () => {
  assert.deepEqual(parseLaunchdState(root([...fields, "\tpath = /synthetic/{literal}/worker", "\tenvironment = {", "\t\tVALUE = text {with braces}", "\t}"])), top);
});

test("start does not kickstart an already running service merely because a nested state differs", () => {
  const f = fixture({ loaded: true, running: true, fail: (_cmd, args) => args[0] === "print" ? { status: 0, stdout: root([...fields, ...nested]), stderr: "" } : null });
  assert.deepEqual(start(f.deps), { ok: true, action: "start", status: "already_running" });
  assert.deepEqual(f.state.calls, [["launchctl", "print", "gui/701/com.exocortex.lark-im-worker"]]);
});

for (const running of [true, false]) {
  test(`kickstart failure requires independent top-level running evidence=${running}`, () => {
    let after = false;
    const f = fixture({ loaded: true, fail: (_cmd, args) => {
      if (args[0] === "kickstart") { after = true; return { status: 5, stderr: "SYNTHETIC_PRIVATE_DIAGNOSTIC" }; }
      if (args[0] === "print" && after) return { status: 0, stdout: running ? root([...fields, ...nested]) : root(["\tstate = waiting", "\tchild = {", "\t\tstate = running", "\t\tpid = 9352", "\t}"]), stderr: "" };
      return null;
    } });
    if (running) assert.equal(start(f.deps).ok, true);
    else assert.throws(() => start(f.deps), /launchctl kickstart failed/);
  });
}
