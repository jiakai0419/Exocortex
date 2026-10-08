import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { resolveServiceDependencies, verifyServiceDependencies } from "../src/runtime/service/dependencies.mjs";
import { install, servicePlist } from "../src/runtime/service/launchd.mjs";
import { fixture } from "./helpers/service-fixture.mjs";

const ok = (value) => ({ status: 0, stdout: JSON.stringify(value) });
const noMutations = (f) => {
  assert.equal(f.state.calls.some((call) => ["write", "rename", "chmod", "mkdir", "remove"].includes(call[0])), false);
  assert.equal(f.state.calls.some((call) => call[0] === "launchctl" && call[1] !== "print"), false);
  assert.equal(f.state.files.get(f.path), "SYNTHETIC_OLD_PLIST");
};

test("unchanged configuration remains a no-op, without claiming a fresh capability check", () => {
  for (const loaded of [false, true]) {
    const f = fixture({ loaded });
    f.deps.dependencySpawnSync = () => { throw new Error("unchanged must not probe"); };
    assert.equal(install(f.config, f.deps).status, "unchanged");
    noMutations(f);
  }
});

test("final PATH preserves caller dependency order and passes only the declared service environment", () => {
  const f = fixture({ alter: { KeepAlive: false } });
  f.deps.env = { PATH: "/synthetic/sql:/synthetic/py:/synthetic/bin", LARK_CLI: "/synthetic/bin/lark-cli", NODE_OPTIONS: "PRIVATE_INIT", PYTHONPATH: "PRIVATE_INIT", TOKEN: "PRIVATE_TOKEN" };
  f.state.executables.add("/synthetic/sql/sqlite3");
  f.state.executables.add("/synthetic/py/python3");
  f.state.executables.delete("/synthetic/bin/sqlite3");
  f.state.executables.delete("/synthetic/bin/python3");
  const selected = resolveServiceDependencies(f.deps);
  assert.equal(selected.sqlitePath, "/synthetic/sql/sqlite3");
  assert.equal(selected.pythonPath, "/synthetic/py/python3");
  assert.equal(selected.serviceEnvironment.PATH.split(":").slice(0, 3).join(":"), "/synthetic/bin:/synthetic/sql:/synthetic/py");
  const probes = [];
  const run = f.deps.dependencySpawnSync;
  f.deps.dependencySpawnSync = (command, args, options) => {
    probes.push({ command, args, options });
    assert.deepEqual(options.env, selected.serviceEnvironment);
    assert.deepEqual(Object.keys(options.env).sort(), ["LARK_CLI", "PATH"]);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxBuffer, 64 * 1024);
    assert.equal(options.killSignal, "SIGKILL");
    return run(command, args, options);
  };
  assert.equal(install(f.config, f.deps).status, "installed");
  assert.deepEqual(probes.map((probe) => probe.command), [selected.nodePath, selected.sqlitePath, selected.sqlitePath, selected.pythonPath]);
  assert.equal(probes.some((probe) => probe.command === selected.larkCli), false);
  assert.equal(probes.some((probe) => probe.args.includes(f.config.db)), false);
  for (const probe of probes.filter((probe) => probe.command === selected.sqlitePath)) {
    assert.ok(probe.args.includes(":memory:"));
    assert.deepEqual(probe.args.slice(0, 2), ["-init", "/dev/null"]);
  }
  assert.deepEqual(probes[3].args.slice(0, 3), ["-I", "-S", "-c"]);
  assert.doesNotMatch(f.state.files.get(f.path), /PRIVATE_INIT|PRIVATE_TOKEN/);
});

for (const command of ["node", "sqlite3", "python3"]) {
  test(`PATH shadowing of selected ${command} fails before configuration mutation`, () => {
    const f = fixture({ alter: { KeepAlive: false } });
    if (command === "node") {
      f.deps.nodePath = "/synthetic/bin/node22";
      f.state.executables.add(f.deps.nodePath);
    } else {
      f.deps.env.PATH = "/synthetic/chosen:/synthetic/bin";
      f.state.executables.add(`/synthetic/chosen/${command}`);
    }
    assert.throws(() => install(f.config, f.deps), new RegExp(`PATH changes the selected ${command}`));
    noMutations(f);
    assert.equal(f.state.calls.some((call) => call[0] === "dependency-probe"), false);
  });
}

test("equivalent symlinks preserve selected executable identity", () => {
  const f = fixture();
  f.deps.nodePath = "/synthetic/bin/node22";
  f.state.executables.add(f.deps.nodePath);
  f.deps.realpathSync = (file) => file === "/synthetic/bin/node" ? f.deps.nodePath : file;
  assert.equal(resolveServiceDependencies(f.deps).nodePath, f.deps.nodePath);
});

test("relative caller PATH and explicit lark path become absolute without invoking a shell", () => {
  const f = fixture();
  f.deps.cwd = "/synthetic";
  f.deps.env.PATH = "bin";
  f.deps.larkCli = "./bin/lark-cli";
  assert.equal(resolveServiceDependencies(f.deps).larkCli, "/synthetic/bin/lark-cli");
  f.deps.larkCli = "lark-cli";
  assert.equal(resolveServiceDependencies(f.deps).larkCli, "/synthetic/bin/lark-cli");
  assert.deepEqual(f.state.calls, []);
});

for (const command of ["node", "lark-cli", "sqlite3", "python3"]) {
  test(`missing ${command} fails closed before even staging a configuration`, () => {
    const f = fixture({ alter: { KeepAlive: false } });
    f.state.executables.delete(`/synthetic/bin/${command}`);
    assert.throws(() => install(f.config, f.deps), new RegExp(`${command} is unavailable`));
    noMutations(f);
  });
}

test("executable directories and PATH-inexpressible dependency directories are rejected", () => {
  const f = fixture();
  const stat = f.deps.statSync;
  f.deps.statSync = (file) => file.endsWith("/python3") ? { isFile: () => false } : stat(file);
  assert.throws(() => resolveServiceDependencies(f.deps), /python3 is unavailable/);
  f.deps.statSync = stat;
  f.deps.larkCli = "/synthetic/colon:dir/lark-cli";
  f.state.executables.add(f.deps.larkCli);
  assert.throws(() => resolveServiceDependencies(f.deps), /PATH-compatible directory/);
});

const failures = [
  ["node", "old version", ok({ version: "21.9.9" })],
  ["node", "malformed version", ok({ version: "22.invalid" })],
  ["node", "invalid JSON", { status: 0, stdout: "PRIVATE_PROBE_SENTINEL" }],
  ["node", "spawn exception", new Error("PRIVATE_PROBE_SENTINEL")],
  ["node", "timeout", { status: null, signal: "SIGKILL", error: new Error("PRIVATE_PROBE_SENTINEL") }],
  ["sqlite3", "old version", ok([{ value: 1, version: "3.34.9" }])],
  ["sqlite3", "missing JSON/materialized/returning", { status: 1, stderr: "PRIVATE_PROBE_SENTINEL" }],
  ["sqlite3", "wrong query result", ok([{ value: 0, version: "3.35.0" }])],
  ["readonly", "missing readonly argument", { status: 1, stderr: "PRIVATE_PROBE_SENTINEL" }],
  ["readonly", "wrong readonly result", ok([])],
  ["python3", "old version", ok({ ready: 1, version: "3.8.9" })],
  ["python3", "missing fcntl/nonblocking/SQLite JSON/schema", { status: 1, stderr: "PRIVATE_PROBE_SENTINEL" }],
  ["python3", "incomplete capability result", ok({ version: "3.9.0" })],
];
for (const [command, condition, result] of failures) {
  test(`failed ${command} capability (${condition}) preserves prior config without private diagnostics`, () => {
    const f = fixture({ alter: { KeepAlive: false } });
    const run = f.deps.dependencySpawnSync;
    f.deps.dependencySpawnSync = (executable, args, options) => {
      if (command === "readonly" ? args.includes("-readonly") : executable.endsWith(`/${command}`)) {
        if (result instanceof Error) throw result;
        return result;
      }
      return run(executable, args, options);
    };
    assert.throws(() => install(f.config, f.deps), (error) => {
      assert.match(error.message, /service requires (?:Node.js|SQLite CLI|Python)/);
      assert.doesNotMatch(error.message, /PRIVATE_PROBE_SENTINEL|synthetic/);
      return true;
    });
    noMutations(f);
  });
}

test("synthetic env-node wrappers work with selected custom dependencies and fail under the old PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-service-dependencies-"));
  try {
    const bin = join(dir, "custom tools");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    const marker = join(dir, "lark-was-executed");
    const script = (name, code) => writeFileSync(join(bin, name), `#!/usr/bin/env node\n${code}\n`, { mode: 0o700 });
    script("lark-cli", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'synthetic only'); process.stdout.write('synthetic-wrapper-ready');`);
    script("sqlite3", `const args = process.argv.slice(2); if (!args.includes(':memory:') || args[0] !== '-init') process.exit(1); process.stdout.write(JSON.stringify(args.includes('-readonly') ? [{ready:1}] : [{value:1,version:'3.35.0'}]));`);
    script("python3", `if (process.argv[2] !== '-I' || process.argv[3] !== '-S') process.exit(1); process.stdout.write(JSON.stringify({ready:1,version:'3.9.0'}));`);
    const selected = resolveServiceDependencies({ nodePath: join(bin, "node"), env: { PATH: bin } });
    verifyServiceDependencies(selected);
    assert.throws(() => accessSync(marker));
    const result = spawnSync(selected.larkCli, [], { encoding: "utf8", env: selected.serviceEnvironment });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "synthetic-wrapper-ready");
    assert.equal(readFileSync(marker, "utf8"), "synthetic only");
    // A deterministic reproduction of the old omission: no selected Node in PATH.
    const old = spawnSync(selected.larkCli, [], { encoding: "utf8", env: { PATH: join(dir, "old-service-bin") } });
    assert.notEqual(old.status, 0);
    // Actual filesystem checks distinguish a runnable file from a directory.
    const f = fixture({ installed: false });
    rmSync(marker);
    Object.assign(f.deps, { nodePath: selected.nodePath, larkCli: selected.larkCli, env: { PATH: bin },
      accessSync, statSync, realpathSync, dependencySpawnSync: spawnSync });
    assert.equal(install(f.config, f.deps).status, "installed");
    assert.throws(() => accessSync(marker));
    assert.ok(f.state.files.get(f.path).includes(selected.serviceEnvironment.PATH));
    assert.equal(servicePlist(f.config, { ...f.deps, ...selected }).EnvironmentVariables.LARK_CLI, selected.larkCli);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real local Node, SQLite and Python execute the capability probes using only synthetic inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-service-capabilities-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const lookup = (command) => {
      const path = (process.env.PATH || "").split(delimiter).map((entry) => resolve(entry, command)).find((candidate) => {
        try { accessSync(candidate, 1); return statSync(candidate).isFile(); } catch { return false; }
      });
      assert.ok(path, `${command} is required by the documented local test environment`);
      return path;
    };
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(lookup("sqlite3"), join(bin, "sqlite3"));
    symlinkSync(process.env.EXOCORTEX_SYNTHETIC_PYTHON || lookup("python3"), join(bin, "python3"));
    const marker = join(dir, "unexpected-lark-execution");
    writeFileSync(join(bin, "lark-cli"), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must not run'); process.exit(1);\n`, { mode: 0o700 });
    const selected = resolveServiceDependencies({ nodePath: join(bin, "node"), env: { PATH: bin } });
    assert.doesNotThrow(() => verifyServiceDependencies(selected));
    assert.throws(() => accessSync(marker));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
