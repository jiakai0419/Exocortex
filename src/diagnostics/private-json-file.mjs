// @ts-check
import { constants, openSync, fstatSync, lstatSync, readSync, closeSync } from 'node:fs';

const same = (a, b) => ['dev','ino','size','mtimeNs','ctimeNs','mode','uid','nlink'].every((key) => a[key] === b[key]);
const privateFile = (info) => info.isFile() && info.nlink === 1n && (info.mode & 0o077n) === 0n &&
  typeof process.getuid === 'function' && info.uid === BigInt(process.getuid());

/** Bounded, nonblocking descriptor read; a path/metadata change rejects the snapshot.
 * Missing is distinct from invalid. Never chmods, follows links, or opens a FIFO blocking.
 * @param {string} path
 * @param {{maxBytes?:number,requirePrivate?:boolean}} [options]
 * @param {{afterRead?:()=>void}} [deps]
 * @returns {{status:"ready"|"missing"|"invalid",value:any,private:boolean}}
 */
export function readStableJsonFile(path, { maxBytes = 65536, requirePrivate = true } = {}, deps = {}) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes) || requirePrivate && !privateFile(before)) throw new Error('unsafe_json_file');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    deps.afterRead?.();
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (length !== Number(before.size) || !same(before, after) || !same(after, current) || !current.isFile() || current.isSymbolicLink()) throw new Error('unstable_json_file');
    return { status: 'ready', value: JSON.parse(bytes.subarray(0, length).toString('utf8')), private: privateFile(after) };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT' && fd === undefined) return { status: 'missing', value: null, private: false };
    return { status: 'invalid', value: null, private: false };
  } finally { if (fd !== undefined) closeSync(fd); }
}
