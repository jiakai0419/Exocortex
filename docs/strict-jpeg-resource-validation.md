# Strict JPEG resource validation

This isolated change restores JPEG resource support using the installed mature
libjpeg-turbo decoder, not the tolerant macOS image converter. No production
files, permissions, message data, acquisition scheduling or resource recovery
are changed here. All verification inputs are authored synthetic data.

## Proof and supported subset

An available JPEG means its exact bound bytes were fully decoded by the selected
libjpeg-turbo build without a warning or fatal error, within fixed budgets, with
all input consumed and supported scan coverage complete. It does not mean the
file is the sender's original image, that metadata is authenticated, or that any
arbitrary pixel modification can be detected. Those claims require independent
source evidence. The acquisition/account/hash/source fences remain mandatory.

The initial supported subset is 8-bit Huffman DCT JPEG: sequential encoding has
one scan covering every frame component; progressive encoding must have scanned
every coefficient of every component through final successive approximation
bit position zero. A legal intentionally reduced-precision or incomplete-band
progressive representation is outside this product subset, rather than proof of
corruption. Arithmetic, lossless, high precision and unsupported component/color
layouts do not gain availability by being openable in another decoder.

Use libjpeg's public C API. Every negative `emit_message` and every `error_exit`
immediately fails; no error recovery supplies missing pixels. Read all output
scanlines at full dimensions, consume to input completion, check scan/coefficient
coverage before `jpeg_finish_decompress` releases state, and finish successfully.
The quantization and Huffman tables actually used by each scan must be present;
libjpeg's implicit standard-Huffman-table fallback is not acceptable evidence.
A bounded in-memory source must reject physical EOF or out-of-range skips and
must not inject an EOI. The final source pointer and remaining byte count must
equal the exact submitted input end. This rejects trailing bytes and concatenated
images as well as early EOF. A forged EOI inside required entropy data is rejected
by strict decoding; a scan-boundary EOI that omits required progressive refinement
is rejected by the coverage gate. It is impossible to reject a modification that
still forms a complete supported JPEG merely because it was not the sender's
intent; no such guarantee is claimed.

Input is at most 16 MiB; width times height times four is at most 64 MiB before
decompression. The decoder's memory manager has a 64 MiB budget, at most 100 scans
are accepted, the CPU limit is four seconds and the caller's wall deadline is five.
The child process also receives a CPU limit and a wall-clock timeout. Address-space
limits are enforced where supported; Darwin returns `EINVAL` for `RLIMIT_AS`, so
this implementation does not claim an AS/RSS hard cap there. Input, output,
libjpeg memory-manager, scan, CPU and wall-clock budgets still apply. libjpeg's
`max_memory_to_use` alone is not a process RSS limit. No source bytes,
metadata strings, decoded pixels, raw decoder errors or paths appear in the
finite protocol or logs. Input travels over stdin; output is a small structured
receipt. No temporary image files or implicit network access are needed.

## Build and runtime dependency

Build a small static client with the same libjpeg-turbo prefix's headers and
`lib/libjpeg.a`; mixing different JPEG ABI headers/libraries is forbidden.
The local investigation found an already installed 3.1.4.1 distribution, so no
dependency installation is needed for this candidate. Machine-specific package
paths must not be embedded in product source or its runtime interface.

An explicit build tool accepts a libjpeg prefix and produces a local ignored
native helper plus a build receipt. Runtime uses the helper at the repository's
build location, or an explicitly configured absolute helper path. There is no
runtime compilation, download, package installation or fallback to a tolerant
decoder. Missing helper/dependency evidence fails closed. The main integrator
must carry the compiled helper or perform the documented build when preparing
the deployment and CI environment; this task does not install it into production.

With an already installed matching libjpeg-turbo distribution and a C11 compiler:

```sh
export EXOCORTEX_LIBJPEG_PREFIX=/absolute/path/to/libjpeg-turbo
npm run build:jpeg
npm run verify
```

The prefix must contain `include/{jpeglib,jconfig,jmorecfg,jerror}.h`,
`lib/libjpeg.a`, `share/doc/libjpeg-turbo/{LICENSE.md,README.ijg}`, and for the
synthetic integration controls `bin/{cjpeg,jpegtran}`. When the environment
variable is absent the build/test scripts check standard Homebrew and system
prefixes. Missing tools fail with explicit preparation guidance; tests never
skip dependency checks. The build uses an absolute static archive and records
the source, archive, headers and executable SHA-256 hashes, platform, architecture
and decoder version in `build/native/jpeg-validator.json`. This is trusted local
installation evidence, not an authenticated signature against the machine owner.

Distribute the helper, adjacent JSON receipt, corresponding C source and copied
`libjpeg-turbo-licenses/` together. The default runtime path is
`build/native/jpeg-validator`; `EXOCORTEX_JPEG_VALIDATOR` may explicitly select
another absolute installed path. Runtime checks the executable/source hashes,
receipt schema and platform, ownership, write permissions and stable file identity.
Changing C source requires rebuilding. No image or other private data enters the
build receipt. The compiler, tools and native archive are only build/test inputs;
static linking avoids a runtime dependency on that machine-specific prefix.

CI/deployment must explicitly provide this dependency and build/copy step before
verification or activation. No package manager, network installation or production
configuration change is performed by this patch.

Existing `assessMediaImageBytes`, `inspectMediaImageBytes`, publish/read binding
and manifest interfaces remain intact. PNG/GIF and WebP behavior stays with the
main resource contract. JPEG bytes are verified again on reads, including old
manifests; a previously stored availability label is not a decoder receipt.

## References and controls

[libjpeg-turbo error handling](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.1.4.1/src/jerror.c),
[input source behavior](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.1.4.1/src/jdatasrc.c),
[completion lifecycle](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.1.4.1/src/jdapimin.c),
[public API](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.1.4.1/src/jpeglib.h).

Synthetic controls must include complete grayscale/RGB/subsampled/progressive
files, missing MCUs, truncated segments and entropy, bad Huffman/restart data,
forged EOI both inside entropy and at progressive scan boundaries, trailing bytes,
missing tables, dimensions/scans/output-budget bombs, and dependency/process
failures. Tests verify the actual helper and public resource publication/read
paths. A pass certifies these stated checks, not a universal JPEG conformance or
source-authenticity theorem.
