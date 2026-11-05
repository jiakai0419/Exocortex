import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { WORKER_STEP_ANCHOR } from '../../src/runtime/worker/remote-sample-anchor.mjs';

const phases = {
  guardian: ['imports_done', 'deadline_created', 'anchor_spawn_begin', 'anchor_spawn_returned',
    'ready_received', 'go_written', 'first_stdout', 'first_stderr', 'cleanup_entered',
    'group_kill_returned', 'anchor_reap_returned', 'cleanup_finished', 'envelope_write_begin', 'deadline_observed'],
  anchor: ['imports_done', 'setup_done', 'ready_written', 'go_received',
    'worker_spawn_begin', 'worker_spawn_returned', 'worker_exit_observed', 'deadline_observed'],
  worker: ['entry', 'output_returned', 'tail_returned'],
};
const digest = source => createHash('sha256').update(source).digest('hex');

export function assertResourceTailPrerequisites(tailExists, stdout) {
  assert.equal(tailExists, true, 'synthetic child entered its local tail');
  assert.deepEqual(JSON.parse(stdout), { ok: true, profile: 'known_record_resources/v1' },
    'the child really emitted success JSON before the deadline');
}

// Called only after runStep returns. Archival failure is a separate test gate,
// never an exception that the production wrapper can mistake for spawn failure.
export function archiveResourceGuardianEvidence(files, write) {
  try {
    for (const [name, value] of Object.entries(files)) write(name, value);
    return { state: 'written' };
  } catch { return { state: 'write_failed' }; }
}

// Authored test files only. Recording cannot escape into the product's result
// protocol or alter cleanup. A recording error disables further observations;
// an incomplete ledger is unknown, never evidence of the missing operation.
function recorder(role, directory) {
  return `
_phase_seen=set()
_phase_failed=False
def _phase(name,**fields):
    global _phase_failed
    if _phase_failed or name in _phase_seen: return
    try:
        if name not in ${JSON.stringify(phases[role])} or len(_phase_seen)>=32:
            _phase_failed=True
            return
        _phase_seen.add(name)
        record={'version':1,'role':${JSON.stringify(role)},'phase':name,
            'monotonic_us':time.monotonic_ns()//1000,'cpu_us':time.process_time_ns()//1000,**fields}
        data=(json.dumps(record,separators=(',',':'))+'\\n').encode('ascii')
        if len(data)>512:
            _phase_failed=True
            return
        fd=os.open(${JSON.stringify(join(directory, role + '.jsonl'))},os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600)
        try:
            if os.write(fd,data)!=len(data): _phase_failed=True
        finally: os.close(fd)
    except Exception:
        _phase_failed=True
_phase('imports_done')
`;
}

function editor(original) {
  let source = original;
  const edits = [];
  return {
    replace(before, after) {
      assert.equal(source.split(before).length, 2, `unique instrumentation anchor: ${before}`);
      source = source.replace(before, after);
      edits.push({ before, after });
    },
    finish() {
      let restored = source;
      for (const { before, after } of [...edits].reverse()) {
        assert.equal(restored.split(after).length, 2, 'unique reverse instrumentation anchor');
        restored = restored.replace(after, before);
      }
      assert.equal(restored, original, 'removing declared instrumentation exactly restores source');
      return { source, original_sha256: digest(original), instrumented_sha256: digest(source),
        injection_count: edits.length, reversible: true };
    },
  };
}

export function instrumentResourceGuardian(original, directory, { delayBeforeWorker = false } = {}) {
  const a = editor(WORKER_STEP_ANCHOR);
  const ai = 'import json,os,subprocess,sys,time\n';
  a.replace(ai, ai + recorder('anchor', directory));
  a.replace('    if active():\n', "    _phase('setup_done')\n    if active():\n");
  a.replace("        send({'version':1,'type':'ready'})\n", "        send({'version':1,'type':'ready'})\n        _phase('ready_written')\n");
  a.replace('                    go=True\n', "                    go=True\n                    _phase('go_received')\n");
  a.replace("            stage='anchor_worker_spawn'\n", "            stage='anchor_worker_spawn'\n            _phase('worker_spawn_begin')\n" +
    (delayBeforeWorker ? '            time.sleep(0.4) # explicitly labelled test intervention\n' : ''));
  a.replace('                start_new_session=False,close_fds=True,pass_fds=worker_fds)\n',
    "                start_new_session=False,close_fds=True,pass_fds=worker_fds)\n            _phase('worker_spawn_returned')\n");
  a.replace('                if code is not None:\n', "                if code is not None:\n                    _phase('worker_exit_observed',code=code)\n");
  a.replace("        failure('anchor_deadline')\n", "        _phase('deadline_observed',current_stage=stage)\n        failure('anchor_deadline')\n");
  const anchor = a.finish();

  const g = editor(original);
  const gi = 'import base64,json,os,signal,subprocess,sys,time\n';
  g.replace(gi, gi + recorder('guardian', directory));
  g.replace('ANCHOR_CODE=' + JSON.stringify(WORKER_STEP_ANCHOR), 'ANCHOR_CODE=' + JSON.stringify(anchor.source));
  g.replace('    deadline=time.monotonic()+timeout\n', "    deadline=time.monotonic()+timeout\n    _phase('deadline_created',deadline=deadline,grant_ms=timeout*1000)\n");
  g.replace("        stage='child_spawn'\n", "        stage='child_spawn'\n        _phase('anchor_spawn_begin')\n");
  g.replace('            start_new_session=True,close_fds=True,pass_fds=(control_read,status_write))\n',
    "            start_new_session=True,close_fds=True,pass_fds=(control_read,status_write))\n        _phase('anchor_spawn_returned')\n");
  g.replace('                    ready=True\n', "                    ready=True\n                    _phase('ready_received')\n");
  g.replace('                    go_sent=True\n', "                    go_sent=True\n                    _phase('go_written')\n");
  g.replace('            output[index].extend(part)\n', "            output[index].extend(part)\n            _phase('first_stdout' if index==0 else 'first_stderr')\n");
  g.replace('finally:\n    if child is not None:\n', "finally:\n    _phase('cleanup_entered',child_present=child is not None,ready=ready,go_sent=go_sent)\n    if child is not None:\n");
  g.replace('            killed=True\n', "            killed=True\n            _phase('group_kill_returned')\n");
  g.replace('                reaped=True\n', "                reaped=True\n                _phase('anchor_reap_returned',sigkill=child.returncode==-signal.SIGKILL)\n");
  g.replace('    for fd in list(handles): close_control(fd)\n', "    for fd in list(handles): close_control(fd)\n    _phase('cleanup_finished',killed=killed,reaped=reaped,cleanup_error=cleanup is not None)\n");
  g.replace("    sys.stdout.write(json.dumps(envelope,separators=(',',':'))+'\\n')\n",
    "    _phase('envelope_write_begin')\n    sys.stdout.write(json.dumps(envelope,separators=(',',':'))+'\\n')\n");
  g.replace("    elif time.monotonic()>=deadline: failure('deadline')\n",
    "    elif time.monotonic()>=deadline:\n        _phase('deadline_observed',current_stage=stage,ready=ready,go_sent=go_sent)\n        failure('deadline')\n");
  const guardian = g.finish();
  return { source: guardian.source, anchorSource: anchor.source, binding: { guardian: { ...guardian, source: undefined },
    anchor: { ...anchor, source: undefined }, intervention: delayBeforeWorker ? 'before_worker_spawn_400ms' : 'none' } };
}

// No external program or invented timestamp is used for shell observations.
export function shellPhase(phase) {
  assert(phases.worker.includes(phase));
  return phase === 'entry'
    ? `printf '%s\\n' '{"version":1,"role":"worker","phase":"entry"}' >> "$3"\n`
    : `phase_return_code=$?\nprintf '%s%s%s\\n' '{"version":1,"role":"worker","phase":"${phase}","return_code":' "$phase_return_code" '}' >> "$3"\n`;
}

const prerequisite = {
  guardian: { deadline_created: 'imports_done', anchor_spawn_begin: 'deadline_created',
    anchor_spawn_returned: 'anchor_spawn_begin', ready_received: 'anchor_spawn_returned', go_written: 'ready_received',
    first_stdout: 'anchor_spawn_returned', first_stderr: 'anchor_spawn_returned',
    cleanup_entered: 'imports_done', group_kill_returned: 'cleanup_entered',
    anchor_reap_returned: 'group_kill_returned', cleanup_finished: 'cleanup_entered',
    envelope_write_begin: 'cleanup_finished', deadline_observed: 'deadline_created' },
  anchor: { setup_done: 'imports_done', ready_written: 'setup_done', go_received: 'ready_written',
    worker_spawn_begin: 'go_received', worker_spawn_returned: 'worker_spawn_begin',
    worker_exit_observed: 'worker_spawn_returned', deadline_observed: 'setup_done' },
};

const phaseFields = {
  guardian: { deadline_created: ['deadline','grant_ms'], cleanup_entered: ['child_present','ready','go_sent'],
    anchor_reap_returned: ['sigkill'], cleanup_finished: ['killed','reaped','cleanup_error'],
    deadline_observed: ['current_stage','ready','go_sent'] },
  anchor: { worker_exit_observed: ['code'], deadline_observed: ['current_stage'] },
};

export function parseResourcePhaseBytes(bytes, role) {
  if (!phases[role] || bytes.length > 16 * 1024) return { state: 'invalid', reason: 'size_or_role', events: [] };
  if (!bytes.length) return { state: 'missing', events: [] };
  try {
    assert(bytes[bytes.length - 1] === 10);
    const lines = bytes.toString('utf8').trimEnd().split('\n');
    assert(lines.length <= 32);
    const events = [], seen = new Set();
    let monotonic = -1, cpu = -1;
    for (const line of lines) {
      assert(Buffer.byteLength(line) <= 511);
      const e = JSON.parse(line);
      assert(e && e.version === 1 && e.role === role && phases[role].includes(e.phase) && !seen.has(e.phase));
      if (role === 'worker') {
        assert.deepEqual(Object.keys(e).sort(), e.phase === 'entry' ? ['phase','role','version'] : ['phase','return_code','role','version']);
        assert.equal(e.phase, phases.worker[events.length]);
        if (e.phase !== 'entry') assert(Number.isInteger(e.return_code) && e.return_code >= 0 && e.return_code <= 255);
      } else {
        assert.deepEqual(Object.keys(e).sort(), ['version','role','phase','monotonic_us','cpu_us',
          ...(phaseFields[role][e.phase] || [])].sort());
        const required = prerequisite[role][e.phase];
        if (required) assert(seen.has(required));
        assert(Number.isSafeInteger(e.monotonic_us) && e.monotonic_us >= monotonic);
        assert(Number.isSafeInteger(e.cpu_us) && e.cpu_us >= cpu);
        monotonic = e.monotonic_us; cpu = e.cpu_us;
      }
      for (const k of ['child_present','ready','go_sent','sigkill','killed','reaped','cleanup_error'])
        if (k in e) assert.equal(typeof e[k], 'boolean');
      if ('current_stage' in e) assert(/^[a-z_]{1,32}$/.test(e.current_stage));
      for (const k of ['deadline','grant_ms','code']) if (k in e) assert(Number.isFinite(e[k]));
      if (e.phase === 'cleanup_finished') {
        if (e.killed) assert(seen.has('group_kill_returned'));
        if (e.reaped) assert(seen.has('anchor_reap_returned'));
      }
      seen.add(e.phase);
      events.push(e);
    }
    return { state: 'valid', events }; // valid means parseable observations, not complete execution
  } catch { return { state: 'invalid', reason: 'record_contract', events: [] }; }
}

export function readResourceGuardianPhases(directory) {
  const result = { schema: 'synthetic_resource_guardian_phases/v1' };
  for (const role of Object.keys(phases)) {
    try {
      const path = join(directory, role + '.jsonl');
      const st = lstatSync(path);
      assert(st.isFile() && !st.isSymbolicLink() && st.size <= 16 * 1024);
      result[role] = parseResourcePhaseBytes(readFileSync(path), role);
    } catch (error) { result[role] = { state: error?.code === 'ENOENT' ? 'missing' : 'invalid', events: [] }; }
  }
  return result;
}
