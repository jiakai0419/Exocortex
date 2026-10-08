import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { LABEL, plistXml, readInstalledServiceConfig } from "../src/runtime/service/launchd.mjs";
import { WORKER_DEFAULTS } from "../src/runtime/worker/options.mjs";

// See docs/service-plist-testing.md. Only the actual system XML parser runs;
// the subprocess boundary rejects launchctl and every other command.
function fixture(t, escaped = false) {
  const home = mkdtempSync(join(tmpdir(), "exo-synthetic-plist-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, escaped ? "install & <quoted> \"' 合成" : "install");
  const config = { ...WORKER_DEFAULTS, db: join(root, "data", "invented.sqlite"), logDir: join(root, "logs"),
    ...(escaped ? { chatTypes: "group & <quoted> \"' 合成", intervalSeconds: 20, receivedScopesPerCycle: 17,
      adaptiveFair: true, adaptiveFairMin: 4, adaptiveFairMax: 19, adaptiveTargetCycleSeconds: 35 } : {}) };
  const deps = { root, homedir: () => home, nodePath: join(root, "bin", "node"),
    workerPath: join(root, "src", "runtime", "worker", "main.mjs"), larkCli: join(root, "bin", "lark-cli"),
    env: { PATH: "/usr/bin:/bin", HOME: home, LANG: "C", LC_ALL: "C" } };
  const file = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const xml = plistXml({ ...config, once: true, maxCycles: 1 }, deps);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, xml, { mode: 0o600 });
  let parses = 0;
  const read = () => readInstalledServiceConfig({ ...deps, spawnSync(command, args, options) {
    assert.ok(command === "plutil" || command === "/usr/bin/plutil", `unexpected command: ${command}`);
    assert.deepEqual(args, ["-convert", "json", "-o", "-", "--", "-"]);
    assert.equal(options.input, readFileSync(file, "utf8"));
    parses++;
    return spawnSync("/usr/bin/plutil", args, options);
  } });
  return { config, deps, file, xml, read, parses: () => parses };
}

for (const escaped of [false, true]) {
  test(`system plutil preserves ${escaped ? "XML metacharacters and Unicode" : "ordinary service settings"}`, t => {
    const f = fixture(t, escaped);
    const installed = f.read();
    assert.equal(f.parses(), 1);
    assert.equal(installed.status, "installed", "the real system plutil conversion must succeed");
    assert.equal(installed.plist.RunAtLoad, true);
    assert.equal(installed.plist.KeepAlive, true);
    assert.equal(installed.plist.Umask, 63);
    assert.equal(installed.plist.Label, LABEL);
    assert.equal(installed.root, f.deps.root);
    assert.deepEqual(installed.plist.ProgramArguments.slice(0, 2), [f.deps.nodePath, f.deps.workerPath]);
    assert.equal(installed.plist.ProgramArguments.includes("--once"), false);
    assert.equal(installed.plist.ProgramArguments.includes("--max-cycles"), false);
    assert.equal(installed.plist.EnvironmentVariables.LARK_CLI, f.deps.larkCli);
    assert.equal(installed.plist.StandardOutPath, "/dev/null");
    assert.equal(installed.plist.StandardErrorPath, join(f.config.logDir, "launchd.err.log"));
    assert.deepEqual(installed.config, f.config);
    assert.equal(installed.xml, f.xml);
    assert.equal(readFileSync(f.file, "utf8"), f.xml, "reading must preserve the synthetic plist bytes");
  });
}

test("the real system parser rejects malformed synthetic service XML", t => {
  const f = fixture(t);
  const malformed = "<plist><dict><key>RunAtLoad</key><true/></plist>";
  writeFileSync(f.file, malformed, { mode: 0o600 });
  assert.deepEqual(f.read(), { status: "unknown" });
  assert.equal(f.parses(), 1);
  assert.equal(readFileSync(f.file, "utf8"), malformed);
});
