# Message resource acquisition

Native image messages contain a resource key, not image bytes. Exocortex's
JSON ingestion does not automatically download those bytes. An explicit
`maintenance enrich --target resources` operation bridges this gap for exact
existing record IDs; its default preview is local and read-only. `--apply`
fetches resources using the existing user profile, and writes only a private
sidecar store. It never modifies message rows or the SQLite schema.

Before any download, verify the current user against each selected source
record's account proof. Use the generic CLI `api GET` resource endpoint with
`type=image`, a private relative output filename, no outer retry and a bounded
deadline. Do not use the installed resource shortcut: version 1.0.56 retries
errors including permission denial. Stop the operation on its first remote
failure. Preserve a finite outcome and never switch identity or alter scopes.
Only the resource whose request failed receives that remote failure reason.
Unrequested resources report `batch_stopped`; downloaded resources that have
not passed the closing account/source fences report `publication_not_attempted`.
An individual unsupported image format or invalid image byte stream is a local
content failure: record it on that item and continue independent selected
images within the unchanged budget. Path, file-permission, link, response,
account and database-identity safety failures still stop the batch. No remaining item
inherits another resource's permission denial or format failure.
The existing shared API lease, cooldown and request budgets apply. The CLI
may retry a connection failure internally; this is not a claim of one HTTP
attempt. No automatic background retry or new scheduler is introduced.

The downloader uses a separate private staging directory and limits the
child's output file to 16 MiB. The CLI buffers a remote response in memory;
the file limit does not establish a streaming or memory limit. Read staged
files with no-follow, same-owner, single-link, regular-file and stable-descriptor
checks. Require exact output-path, byte-count and image MIME agreement.
The controlled temporary parent is resolved before creating staging, so an
absolute CLI `saved_path` agrees with its child working directory on systems
where `/var` aliases `/private/var`. The response still must name the exact
requested target; arbitrary response aliases and symlink output files are not
accepted. The official generic file response uses top-level metadata, so no
success-envelope unwrapping or permissive response-path resolution is added.
Verify the image container and dimensions before publication, then verify the current
user again and re-read the downloaded source rows under the shared local commit
lease. A changed message source blocks that row; independent unchanged rows may
still publish. Publish only unchanged rows into the database/account/message/version/
resource binding described in [the store contract](media-resource-store.md).
Clean up the download staging directory after success or failure. Exact local
admission stops may retain already validated bytes in the separate bounded
[pending namespace](media-resource-pending.md). A missing original closing
account observation remains quarantine and requires a fresh download; only an
originally closed operation may later resume publication without fetching again.
Neither state is available to `messages` before its normal publication fences.

`messages` checks that same binding and the actual local file on every read.
Only a verified available resource can make an image's content complete. JSON
exposes its local path, MIME, size, hash and observation time; terminal text
shows the verified resource path. Neither output invents OCR, a caption or
source prose; the saved body, source payload, identity, time and ordering stay
unchanged. Missing, altered, mismatched or invalid files remain incomplete.
PNG/GIF use the store's complete pixel-stream checks. JPEG additionally requires
the installed [strict native validator](strict-jpeg-resource-validation.md),
including full decoding, zero warnings, complete consumption and scan coverage.
Missing dependency, invalid data, unsupported encoding and budget exhaustion
remain distinct incomplete outcomes. WebP remains unsupported. Local reads do
not create decoder files; JPEG bytes travel over stdin to the bounded helper.
`--resource-dir` selects an explicit private store for acquisition and reading;
the default is `<absolute database path>.resources`.

The Feishu message resource API explicitly excludes stickers. A sticker keeps
its faithful type and source key with an explicit unsupported-capability
diagnosis. No speculative sticker request or permission change is attempted.
Native audio/video/file/post-image support remains outside this image change.

References: [CLI v1.0.56 generic response handling](https://github.com/larksuite/cli/blob/v1.0.56/internal/client/response.go),
[shortcut retry behavior](https://github.com/larksuite/cli/blob/v1.0.56/shortcuts/im/im_messages_resources_download.go),
[Feishu resource endpoint](https://open.feishu.cn/document/server-docs/im-v1/message/get-2?lang=zh-CN).
