import { execFileSync } from "node:child_process";

/** Prepare only a newly written, test-owned sidecar before publishing it to a reader.
 * Darwin can assign UF_TRACKED later, changing ctime without changing its bytes.
 * Complete that metadata transition during setup; never weaken the real reader's
 * ctime check, retry the command, or wait for an arbitrary quiet period.
 */
export function prepareSidecarFixture(path) {
  if (process.platform !== "darwin") return;
  // Isolated Python ignores PYTHONOPTIMIZE so setup checks cannot be disabled.
  execFileSync("python3", ["-I", "-c", `
import ctypes, hashlib, os, stat, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    before = os.fstat(fd)
    assert stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
    before_hash = hashlib.sha256(os.pread(fd, before.st_size, 0)).digest()
    # Darwin sys/stat.h: UF_TRACKED is used for document ID management.
    tracked = 0x40
    if not before.st_flags & tracked:
        libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        libc.fchflags.argtypes = [ctypes.c_int, ctypes.c_uint32]
        libc.fchflags.restype = ctypes.c_int
        if libc.fchflags(fd, before.st_flags | tracked) != 0:
            raise OSError(ctypes.get_errno(), 'fixture fchflags failed')
    after = os.fstat(fd)
    assert after.st_flags == before.st_flags | tracked
    for key in ['st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns']:
        assert getattr(after, key) == getattr(before, key), key
    assert hashlib.sha256(os.pread(fd, after.st_size, 0)).digest() == before_hash
finally:
    os.close(fd)
`, path], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
}
