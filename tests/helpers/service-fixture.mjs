import { WORKER_DEFAULTS } from "../../src/runtime/worker/options.mjs";
import { LABEL, servicePlist } from "../../src/runtime/service/launchd.mjs";

const absent = () => ({ status: 113, stdout: "", stderr: `Could not find service "${LABEL}" in domain for user gui: 701` });
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
export function fixture({ loaded = false, running = false, installed = true, alter = {}, fail = null } = {}) {
  const config = { ...WORKER_DEFAULTS, db: "/synthetic/install/data/test.sqlite", logDir: "/synthetic/install/logs/lark-im" };
  const path = `/synthetic/home/Library/LaunchAgents/${LABEL}.plist`;
  const files = new Map(installed ? [[path, "SYNTHETIC_OLD_PLIST"]] : []);
  const modes = new Map([[path, 0o640]]);
  const calls = [];
  const state = { loaded, running, pid: running ? 7011 : null, config, files, modes, calls, failed: false };
  const deps = {
    root: "/synthetic/install", nodePath: "/synthetic/bin/node", workerPath: "/synthetic/install/src/runtime/worker/main.mjs", larkCli: "/synthetic/bin/lark-cli",
    homedir: () => "/synthetic/home", uid: () => 701,
    existsSync: (file) => files.has(file),
    readFileSync: (file) => { if (!files.has(file)) throw new Error("synthetic missing file"); return files.get(file); },
    statSync: (file) => ({ mode: modes.get(file) ?? 0o600 }),
    mkdirSync: (file) => calls.push(["mkdir", file]),
    writeFileSync: (file, value) => { calls.push(["write", file]); files.set(file, value); },
    renameSync: (from, to) => { calls.push(["rename", from, to]); files.set(to, files.get(from)); files.delete(from); modes.set(to, modes.get(from) ?? 0o600); },
    rmSync: (file) => { calls.push(["remove", file]); files.delete(file); },
    chmodSync: (file, mode) => { calls.push(["chmod", file, mode]); modes.set(file, mode); },
    run: (cmd, args, options) => {
      calls.push([cmd, ...args]);
      const rejected = fail?.(cmd, args, options, state);
      if (rejected) return rejected;
      if (cmd === "plutil") {
        if (args[0] === "-lint") return ok();
        return ok(JSON.stringify({ ...servicePlist(config, deps), ...alter }));
      }
      if (args[0] === "print") return state.loaded ? ok(`state = ${state.running ? "running" : "waiting"}\n${state.pid ? `pid = ${state.pid}\n` : ""}`) : absent();
      if (args[0] === "bootout") { state.loaded = false; state.running = false; state.pid = null; }
      if (args[0] === "bootstrap") { state.loaded = true; }
      if (args[0] === "kickstart") { state.running = true; state.pid = (state.pid || 7011) + 1; }
      return ok();
    },
  };
  return { config, path, state, deps };
}
