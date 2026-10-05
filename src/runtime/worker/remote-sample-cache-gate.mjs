// @ts-check
// A cache attempt has one private stage; status never reads this filename.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;

/** The parent alone allocates the attempt name, before starting its guardian. */
export function createRemoteSamplePublication(logDir, databaseKey, attemptId = randomUUID()) {
  if (typeof logDir !== "string" || !logDir || !HASH.test(databaseKey) || !UUID.test(attemptId)) throw new Error("invalid sample publication");
  return { version: 1, attemptId, cachePath: resolve(logDir, "live-probe.json"),
    stagePath: resolve(logDir, `.live-probe.${attemptId}.pending`),
    lockPath: resolve(logDir, "remote-sample", "live-probe.lock") };
}

/** Reject a missing contract or a caller-supplied destination outside logDir. */
export function remoteSamplePublicationStage(logDir, databaseKey, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const expected = createRemoteSamplePublication(logDir, databaseKey, value.attemptId);
    return Object.keys(value).sort().join(",") === Object.keys(expected).sort().join(",") &&
      Object.keys(expected).every(key => value[key] === expected[key]) ? expected.stagePath : null;
  } catch { return null; }
}

// Injected into the external guardian. All fallible validation and fsync work
// precedes the rename. That rename is the ephemeral cache's final commit: a
// crash may lose the new directory entry, but cleanup failure cannot publish it.
// The existing scheduler flock is held by the guardian throughout this helper.
export const REMOTE_SAMPLE_CACHE_GATE = String.raw`
import json,os,re,stat
def sample_cache_contract():
    raw=os.environ.get('EXOCORTEX_REMOTE_SAMPLE_PUBLICATION')
    if raw is None: return None
    if len(raw)>4096: raise ValueError('cache publication contract')
    value=json.loads(raw)
    if type(value) is not dict or set(value)!={'version','attemptId','stagePath','cachePath','lockPath'} or type(value['version']) is not int or value['version']!=1:
        raise ValueError('cache publication contract')
    token=value['attemptId']
    if type(token) is not str or re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',token) is None:
        raise ValueError('cache publication token')
    for key in ('stagePath','cachePath','lockPath'):
        if type(value[key]) is not str or os.path.abspath(value[key])!=value[key]: raise ValueError('cache publication path')
    directory=os.path.dirname(value['cachePath'])
    if os.path.basename(value['cachePath'])!='live-probe.json' or value['stagePath']!=os.path.join(directory,'.live-probe.'+token+'.pending'):
        raise ValueError('cache publication path')
    if value['lockPath']!=os.path.join(directory,'remote-sample','live-probe.lock'):
        raise ValueError('cache publication lock')
    return value
def sample_cache_regular(info,maximum=None):
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077 or info.st_nlink!=1:
        raise ValueError('unsafe cache file')
    if maximum is not None and not 0<info.st_size<=maximum: raise ValueError('cache file size')
def sample_cache_identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
def sample_cache_directory(info):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077: raise ValueError('unsafe cache directory')
def sample_cache_close(fd):
    if fd is not None:
        try: os.close(fd)
        except Exception: pass
def remote_sample_cache_pass_fds():
    value=sample_cache_contract()
    if value is None: return ()
    inherited=os.environ.get('EXOCORTEX_REMOTE_SAMPLE_LOCK_FD','')
    if not inherited.isascii() or not inherited.isdecimal() or int(inherited)<200: raise ValueError('cache lock unavailable')
    fd=int(inherited)
    info=os.fstat(fd)
    sample_cache_regular(info)
    if sample_cache_identity(info)!=sample_cache_identity(os.stat(value['lockPath'],follow_symlinks=False)):
        raise ValueError('cache lock changed')
    return (fd,)
def prepare_remote_sample_cache():
    value=sample_cache_contract()
    if value is None: return
    directory_fd=marker_fd=None
    try:
        remote_sample_cache_pass_fds()
        directory=os.path.dirname(value['cachePath'])
        directory_fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK)
        before=os.fstat(directory_fd)
        sample_cache_directory(before)
        try:
            target=os.stat('live-probe.json',dir_fd=directory_fd,follow_symlinks=False)
            sample_cache_regular(target,65536)
        except FileNotFoundError: pass
        name='.live-probe.'+value['attemptId']+'.attempting'
        marker_fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=directory_fd)
        # This deliberately cannot parse as positive sample evidence. No DB
        # context or credentials are needed to invalidate before child startup.
        data=b'{"kind":"lark_im_live_probe_cache/pending","status":"unavailable","ok":false,"reason":"attempting"}\n'
        while data:
            written=os.write(marker_fd,data)
            if written<=0: raise ValueError('cache marker write')
            data=data[written:]
        os.fsync(marker_fd)
        marker=os.fstat(marker_fd)
        sample_cache_regular(marker,65536)
        if sample_cache_identity(marker)!=sample_cache_identity(os.stat(name,dir_fd=directory_fd,follow_symlinks=False)):
            raise ValueError('cache marker changed')
        after=os.stat(directory,follow_symlinks=False)
        sample_cache_directory(after)
        if (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino): raise ValueError('cache directory changed')
        os.rename(name,'live-probe.json',src_dir_fd=directory_fd,dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
        # A successful setup must also close successfully. Clear ownership
        # before each close so a denied close is never retried in finally.
        finished_fd=marker_fd
        marker_fd=None
        os.close(finished_fd)
        finished_fd=directory_fd
        directory_fd=None
        os.close(finished_fd)
    finally:
        sample_cache_close(marker_fd)
        sample_cache_close(directory_fd)
def publish_remote_sample_cache(allow_commit=lambda: True):
    value=sample_cache_contract()
    if value is None: return
    directory=os.path.dirname(value['cachePath'])
    directory_fd=stage_fd=target_fd=None
    committed=False
    try:
        # The outer wrapper owns this same flock; the worker never owns its
        # lifetime. Refuse a stage if the inherited lock identity changed.
        remote_sample_cache_pass_fds()
        directory_fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK)
        before_directory=os.fstat(directory_fd)
        sample_cache_directory(before_directory)
        stage_name=os.path.basename(value['stagePath'])
        stage_fd=os.open(stage_name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory_fd)
        before=os.fstat(stage_fd)
        sample_cache_regular(before,65536)
        try:
            target_fd=os.open('live-probe.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory_fd)
            target=os.fstat(target_fd)
            sample_cache_regular(target,65536)
            if sample_cache_identity(target)!=sample_cache_identity(os.stat('live-probe.json',dir_fd=directory_fd,follow_symlinks=False)):
                raise ValueError('cache target changed')
        except FileNotFoundError: pass
        os.fsync(stage_fd)
        os.fsync(directory_fd)
        if sample_cache_identity(before)!=sample_cache_identity(os.fstat(stage_fd)) or sample_cache_identity(before)!=sample_cache_identity(os.stat(stage_name,dir_fd=directory_fd,follow_symlinks=False)):
            raise ValueError('cache stage changed')
        after_directory=os.stat(directory,follow_symlinks=False)
        sample_cache_directory(after_directory)
        if (before_directory.st_dev,before_directory.st_ino)!=(after_directory.st_dev,after_directory.st_ino): raise ValueError('cache directory changed')
        if not allow_commit(): raise ValueError('cache commit cancelled')
        # Final commit; do not add a fallible operation after this rename.
        os.rename(stage_name,'live-probe.json',src_dir_fd=directory_fd,dst_dir_fd=directory_fd)
        committed=True
    finally:
        # The guardian immediately calls os._exit(0) after commit. The kernel
        # reclaims these descriptors without any post-commit filesystem call.
        if not committed:
            sample_cache_close(target_fd)
            sample_cache_close(stage_fd)
            sample_cache_close(directory_fd)
def discard_remote_sample_stage():
    directory_fd=None
    try:
        value=sample_cache_contract()
        if value is None: return
        directory_fd=os.open(os.path.dirname(value['cachePath']),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK)
        sample_cache_directory(os.fstat(directory_fd))
        # Unlink only the unique stage belonging to this attempt. Never follow
        # it, touch the visible cache, or remove another attempt's filename.
        os.unlink(os.path.basename(value['stagePath']),dir_fd=directory_fd)
    except Exception: pass
    finally: sample_cache_close(directory_fd)
`;
