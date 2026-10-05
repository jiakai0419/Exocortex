"""Acquire a nonblocking kernel lease on the caller's inherited descriptor.

The Node caller retains its copy; exiting this helper does not release the
shared open-file description. Never unlock, reopen, or unlink the lock here.
"""
import fcntl
import os
import stat
import sys

try:
    info = os.fstat(3)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        sys.exit(74)
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(75)
except OSError:
    sys.exit(74)
