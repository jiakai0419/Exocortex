import { spawn } from 'node:child_process';

// Lifecycle tests own only this direct ChildProcess handle and, when explicitly
// detached, its newly created group. Observed fixture PIDs never reach signalOnce.
export function startOwnedProcess(command, args, options) {
  const deadline = options.deadline;
  if (!Number.isFinite(deadline)) throw new Error('owned_process_deadline_required');
  const cleanupGrace = Math.min(2000, Math.max(0, (deadline - performance.now()) / 2));
  const detached = options.detached ?? true;
  const child = spawn(command, args, { cwd: options.cwd, env: options.env,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'], detached });
  let done = false, exited = false, code = null, signal = null;
  let failure = null, signalAttempted = false, signalError = null, size = 0;
  let resolveResult, softTimer, hardTimer;
  const stdout = [], stderr = [];
  const result = new Promise(resolve => { resolveResult = resolve; });
  const settle = () => {
    if (done) return;
    done = true;
    clearTimeout(softTimer); clearTimeout(hardTimer);
    child.removeListener('error', error); child.removeListener('exit', exit); child.removeListener('close', close);
    child.stdout?.removeListener('data', out); child.stderr?.removeListener('data', err);
    child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    resolveResult({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
      failure, signalAttempted, signalError });
  };
  const signalOnce = (requested, { group = false } = {}) => {
    if (done || exited || child.exitCode != null || child.signalCode != null || signalAttempted) return false;
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || group && !detached) {
      failure ||= 'owned_process_identity_unavailable'; settle(); return false;
    }
    signalAttempted = true;
    try {
      if (group) process.kill(-child.pid, requested);
      else if (!child.kill(requested)) signalError = 'signal_not_delivered';
    } catch (cause) { signalError = String(cause?.code || 'signal_failed'); }
    if (signalError) { failure ||= 'owned_signal_failed'; settle(); return false; }
    return true;
  };
  const stop = reason => { failure ||= reason; signalOnce('SIGKILL'); };
  const error = cause => {
    if (signalAttempted) signalError ||= String(cause?.code || 'signal_failed');
    stop(`owned_process_${String(cause?.code || 'error')}`);
    settle();
  };
  const exit = (value, exitSignal) => { exited = true; code = value; signal = exitSignal; };
  const close = (value, exitSignal) => { exited = true; code = value; signal = exitSignal; settle(); };
  const collect = (target, chunk) => {
    if (done) return;
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > (options.maxBytes ?? 1024 * 1024)) { stop('owned_output_limit'); return; }
    target.push(bytes);
  };
  const out = chunk => collect(stdout, chunk), err = chunk => collect(stderr, chunk);
  child.on('error', error); child.on('exit', exit); child.on('close', close);
  child.stdout?.on('data', out); child.stderr?.on('data', err);
  softTimer = setTimeout(() => stop(exited ? 'owned_stream_close_timeout' : 'owned_case_watchdog'),
    Math.max(0, deadline - cleanupGrace - performance.now()));
  hardTimer = setTimeout(() => { stop('owned_case_deadline'); settle(); }, Math.max(0, deadline - performance.now()));
  return { child, result, signalOnce, stop };
}

export async function waitUntil(predicate, deadline, label = 'synthetic_observation') {
  while (true) {
    if (performance.now() >= deadline) throw new Error(`${label}_deadline`);
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(15, Math.max(0, deadline - performance.now()))));
  }
}

export async function waitForPidsToExit(pids, deadline) {
  const observed = [...new Set(pids)];
  if (!observed.length || observed.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('invalid_synthetic_pid');
  await waitUntil(() => observed.every(pid => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }), deadline, 'synthetic_process_exit');
}
