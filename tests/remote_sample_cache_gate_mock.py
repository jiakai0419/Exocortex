"""Pure OS substitute for the publication helper; never operates on host files."""
import builtins
import json
import posixpath
import re
import stat
import sys
from types import SimpleNamespace

payload = json.load(sys.stdin)
scenario = payload.get('scenario', {})
contract = payload['contract']
calls = []
files = {}
descriptors = {200: 'lock'}
next_fd = 10

def info(mode, inode, size=100, links=1, uid=123):
    return SimpleNamespace(st_mode=mode, st_ino=inode, st_dev=1, st_uid=uid,
        st_nlink=links, st_size=size, st_mtime_ns=1, st_ctime_ns=1)

files['directory'] = info(stat.S_IFDIR | 0o700, 1, links=2)
files['lock'] = info(stat.S_IFREG | 0o600, 2, size=0)
files['stage'] = info(stat.S_IFREG | 0o600, 3)
files['target'] = info(stat.S_IFREG | 0o600, 4)
if scenario.get('old_positive'): files['target'].st_ino = 3
if scenario.get('unsafe') == 'link': files['stage'].st_mode = stat.S_IFLNK | 0o600
if scenario.get('unsafe') == 'fifo': files['stage'].st_mode = stat.S_IFIFO | 0o600
if scenario.get('unsafe') == 'hardlink': files['stage'].st_nlink = 2
if scenario.get('unsafe') == 'public': files['stage'].st_mode = stat.S_IFREG | 0o644
if scenario.get('unsafe') == 'owner': files['stage'].st_uid = 456
if scenario.get('unsafe') == 'oversized': files['stage'].st_size = 65537
if scenario.get('unsafe') == 'directory': files['directory'].st_mode = stat.S_IFDIR | 0o755
if scenario.get('missing'): del files['stage']
stage_name = posixpath.basename(contract['stagePath'])
marker_name = '.live-probe.' + contract['attemptId'] + '.attempting'
paths = {posixpath.dirname(contract['cachePath']): 'directory', contract['lockPath']: 'lock',
    stage_name: 'stage', marker_name: 'marker', 'live-probe.json': 'target'}

def record(name):
    calls.append(name)
    if scenario.get('fail') == name: raise PermissionError(1, 'invented denial')

def open_file(path, flags, mode=None, **options):
    global next_fd
    key = paths[path]
    record('open_' + key)
    if not flags & 4 or not flags & 8: raise AssertionError('no-follow/nonblock missing')
    if key == 'marker':
        if not flags & 32 or not flags & 64 or mode != 0o600: raise AssertionError('nonexclusive marker')
        files[key] = info(stat.S_IFREG | 0o600, 5, size=0)
    if key not in files: raise FileNotFoundError()
    next_fd += 1
    descriptors[next_fd] = key
    return next_fd

def fstat_file(fd):
    key = descriptors[fd]
    record('fstat_' + key)
    return SimpleNamespace(**vars(files[key]))

def stat_file(path, **options):
    key = paths[path]
    record('stat_' + key)
    if options.get('follow_symlinks') is not False: raise AssertionError('followed name')
    value = SimpleNamespace(**vars(files[key]))
    if scenario.get('changed') == key: value.st_ino += 100
    return value

def fsync_file(fd): record('fsync_' + descriptors[fd])
def write_file(fd, data):
    record('write_' + descriptors[fd])
    files[descriptors[fd]].st_size += len(data)
    return len(data)
def close_file(fd):
    record('close_' + descriptors[fd])
    del descriptors[fd]
def rename_file(source, target, **options):
    record('rename')
    if source not in (stage_name, marker_name) or target != 'live-probe.json' or options != {'src_dir_fd': 11, 'dst_dir_fd': 11}:
        raise AssertionError('rename escaped its directory')
    files['target'] = files.pop(paths[source])
def unlink_file(path, **options):
    record('unlink')
    if path != stage_name: raise AssertionError('removed another attempt')
    files.pop('stage', None)

environment = {'EXOCORTEX_REMOTE_SAMPLE_PUBLICATION': json.dumps(contract), 'EXOCORTEX_REMOTE_SAMPLE_LOCK_FD': '200'}
if scenario.get('no_contract'): environment = {}
if 'lock_fd' in scenario: environment['EXOCORTEX_REMOTE_SAMPLE_LOCK_FD'] = scenario['lock_fd']
fake_path = SimpleNamespace(dirname=posixpath.dirname, basename=posixpath.basename, join=posixpath.join,
    abspath=lambda value: posixpath.normpath(value if value.startswith('/') else posixpath.join('/synthetic/cwd', value)))
fake_os = SimpleNamespace(environ=environment, path=fake_path, getuid=lambda: 123,
    O_RDONLY=0, O_DIRECTORY=2, O_NOFOLLOW=4, O_NONBLOCK=8, O_WRONLY=16, O_CREAT=32, O_EXCL=64, open=open_file, fstat=fstat_file,
    stat=stat_file, fsync=fsync_file, close=close_file, rename=rename_file, unlink=unlink_file, write=write_file)
modules = {'json': json, 'os': fake_os, 're': re, 'stat': stat}
def restricted_import(name, *unused):
    if name not in modules: raise AssertionError('unmocked import: ' + name)
    return modules[name]
safe_builtins = dict(vars(builtins), __import__=restricted_import)
for name in ('open', 'input', 'breakpoint', 'eval', 'exec', 'compile'):
    safe_builtins.pop(name, None)
namespace = {'__builtins__': safe_builtins}
exec(compile(payload['code'], '<cache-gate-mock>', 'exec'), namespace)
error = None
def allow_commit():
    record('allow_commit')
    return not scenario.get('cancel')
try:
    action = payload.get('action', 'publish_remote_sample_cache')
    if action == 'publish_remote_sample_cache': namespace[action](allow_commit)
    else: namespace[action]()
except Exception as caught: error = type(caught).__name__
print(json.dumps({'calls': calls, 'error': error, 'positive': files['target'].st_ino == 3,
    'stage': 'stage' in files, 'inherited_lock_open': 200 in descriptors}))
