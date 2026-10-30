import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { resourceStorePath } from '../src/adapters/lark-im/media-resource-store.mjs';

const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
const files = value => value.split('\0').filter(Boolean).sort();

function fixture(t, { installIgnore = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-resource-git-privacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), template = join(root, 'empty-template');
  mkdirSync(repo); mkdirSync(template);
  // Do not inherit another checkout/index or personal Git configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  function git(args, { status = 0, input } = {}) {
    const result = spawnSync('git', ['-c', 'core.excludesFile=/dev/null',
      '-c', 'core.attributesFile=/dev/null', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: repo, env, encoding: 'utf8', input, timeout: 10000 });
    assert.equal(result.error, undefined, `synthetic Git command failed: ${args[0]}`);
    assert.equal(result.status, status, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  }
  function write(path, content = 'synthetic resource fixture only\n') {
    const target = join(repo, path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content); return path;
  }
  git(['init', '--quiet', `--template=${template}`]);
  if (installIgnore) write('.gitignore', ignore);
  return { repo, git, write };
}

const resourceFiles = [
  'synthetic.blob', 'synthetic-manifest.json', '.publish-synthetic.tmp',
  'pending-v1/slot-0/claim.json', 'pending-v1/slot-0/manifest.json',
  'pending-v1/slot-0/payload.blob', 'pending-v1/.mutation.lock',
  'quarantine/synthetic/manifest.json', 'quarantine/synthetic/payload.blob',
  'future-subdirectory/unknown-file',
];

for (const suffix of ['.sqlite', '.sqlite3', '.db', '']) {
  test(`default resource directory stays in place and is ignored for ${suffix || 'no extension'}`, t => {
    const f = fixture(t), paths = [];
    for (const parent of ['', 'nested directory/data']) {
      const db = join(f.repo, parent, `synthetic-database${suffix}`);
      const store = resourceStorePath(db);
      assert.equal(store, `${resolve(db)}.resources`, 'ignore protection must not relocate existing resources');
      for (const name of resourceFiles) paths.push(f.write(relative(f.repo, join(store, name))));
    }
    assert.deepEqual(files(f.git(['check-ignore', '-z', '--stdin'], { input: paths.join('\0') + '\0' })), paths.sort());
    assert.match(f.git(['check-ignore', '--verbose', '--', paths[0]]), /:\d+:\*\.resources\/\t/);
    f.write('synthetic-source.txt');
    const before = f.git(['ls-files', '--stage', '-z']);
    const preview = f.git(['add', '--dry-run', '--all']);
    assert.match(preview, /synthetic-source\.txt/);
    assert.doesNotMatch(preview, /\.resources/);
    assert.equal(f.git(['ls-files', '--stage', '-z']), before, 'dry-run must not change the index');
    f.git(['add', '--all']);
    assert.deepEqual(files(f.git(['ls-files', '--cached', '-z'])), ['.gitignore', 'synthetic-source.txt']);
    assert.deepEqual(files(f.git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])), paths.sort());
  });
}

test('ordinary explicit add refuses a private default resource; source lookalikes remain addable', t => {
  const f = fixture(t);
  const secret = f.write('nested/synthetic.db.resources/pending-v1/slot-0/manifest.json');
  f.git(['add', '--dry-run', '--', secret], { status: 1 });
  f.git(['add', '--', secret], { status: 1 });
  assert.deepEqual(files(f.git(['ls-files', '--cached', '-z'])), []);
  const publicFiles = ['src/resources.mjs', 'docs/cache.resources.md', 'fixtures/not-resources/manifest.json'];
  for (const path of publicFiles) f.write(path);
  f.git(['add', '--all']);
  assert.deepEqual(files(f.git(['ls-files', '--cached', '-z'])), ['.gitignore', ...publicFiles].sort());
});

test('legacy override remains ignored; an arbitrary override requires its own exclusion', t => {
  const f = fixture(t);
  const db = join(f.repo, 'synthetic.db');
  const legacy = resourceStorePath(db, join(f.repo, 'nested/lark-im-resources'));
  const legacyFile = f.write(relative(f.repo, join(legacy, 'synthetic-manifest.json')));
  f.git(['check-ignore', '--quiet', '--', legacyFile]);
  const custom = resourceStorePath(db, join(f.repo, 'custom-cache'));
  assert.equal(custom, join(f.repo, 'custom-cache'));
  const customFile = f.write(relative(f.repo, join(custom, 'synthetic-manifest.json')));
  f.git(['check-ignore', '--quiet', '--', customFile], { status: 1 });
  assert.match(f.git(['add', '--dry-run', '--all']), /custom-cache\/synthetic-manifest\.json/);
});

for (const committed of [false, true]) {
  test(`${committed ? 'committed' : 'already staged'} resources require an explicit tracked-file alarm`, t => {
    const f = fixture(t, { installIgnore: false });
    const privateFile = f.write('nested/synthetic.db.resources/pending-v1/slot-0/manifest.json');
    f.git(['add', '--', privateFile]);
    if (committed) f.git(['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=synthetic@example.invalid',
      '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Synthetic privacy boundary fixture']);
    f.write('.gitignore', ignore);
    f.write(privateFile, 'synthetic changed resource fixture only\n');
    // Matching an ignore pattern with --no-index does not establish index safety.
    f.git(['check-ignore', '--quiet', '--no-index', '--', privateFile]);
    f.git(['check-ignore', '--quiet', '--', privateFile], { status: 1 });
    const trackedPrivateFiles = files(f.git(['ls-files', '--cached', '--ignored', '--exclude-standard', '-z']));
    assert.deepEqual(trackedPrivateFiles, [privateFile], 'preflight must alarm on tracked private resources');
    const preview = f.git(['add', '--dry-run', '--all']);
    assert.ok(preview.includes(privateFile), 'ignores do not stop updates of tracked resources');
    f.git(['add', '--all']);
    assert.deepEqual(files(f.git(['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'])), [privateFile]);
    assert.equal(f.git(['show', `:${privateFile}`]), 'synthetic changed resource fixture only\n');
  });
}
