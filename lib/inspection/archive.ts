import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

// The whole repo at one commit, read from GitHub's archive download (codeload.github.com, not the API, so it doesn't
// count against API limits). Streamed and unpacked in memory; nothing touches disk and nothing is kept after the
// report is made. Only text files are kept, and only up to a size: the setup checks need source and config, not
// images, builds or other people's code in node_modules.

export type Skipped = { reason: string; count: number; examples: string[] };
export type Snapshot = {
  files: Record<string, string>; // path → text, for the files kept
  paths: string[]; // every file in the archive, kept or not
  bytes: number; // text kept
  skipped: Skipped[];
};

export const LIMITS = {
  download: 250 * 1024 * 1024, // compressed bytes read before giving up
  repoKb: 3 * 1024 * 1024, // GitHub's repo size (all history, so much more than one commit) above which it isn't tried
  file: 512 * 1024, // one text file
  total: 60 * 1024 * 1024, // all text kept
  paths: 60_000,
  ms: 30_000,
};

// Folders that hold other people's code or build output: listed in `paths`, never read.
const VENDORED = /(^|\/)(node_modules|vendor|bower_components|\.git|dist|build|out|target|\.next|\.nuxt|\.svelte-kit|\.venv|venv|__pycache__|\.tox|Pods|DerivedData|coverage|\.yarn\/(cache|releases)|third_party|external)\//;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|svgz|mp[34]|m4a|wav|ogg|flac|webm|mov|avi|mkv|pdf|zip|gz|tgz|bz2|xz|7z|rar|zst|jar|war|class|exe|dll|so|dylib|a|o|obj|lib|bin|dat|db|sqlite3?|wasm|pyc|pyd|whl|egg|ttf|otf|woff2?|eot|onnx|pt|pth|safetensors|gguf|ckpt|h5|pb|tflite|npy|npz|parquet|feather|arrow|deb|rpm|dmg|msi|apk|ipa|aab|iso|img)$/i;
// Kept as names only: lock files are large and the dependency check reads them through GitHub's dependency graph.
const LOCKS = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|packages\.lock\.json|gradle\.lockfile|mix\.lock|pubspec\.lock|Podfile\.lock)$/;
const MINIFIED = /\.min\.(js|css)$|\.(map|snap)$/i;

function octal(b: Buffer, start: number, len: number): number {
  // Sizes over 8 GB use base-256 (high bit set); nothing that big is read, so it's just "too large".
  if (b[start] & 0x80) return Number.MAX_SAFE_INTEGER;
  const s = b.toString("latin1", start, start + len).replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}
const cstr = (b: Buffer, start: number, len: number) => {
  const end = b.indexOf(0, start);
  return b.toString("utf8", start, end === -1 || end > start + len ? start + len : end);
};
function pax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(body.toString("latin1", i, sp), 10);
    if (!len) break;
    const rec = body.toString("utf8", sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// Unpacks a tar stream (already gunzipped). GitHub's archives put everything under one "owner-repo-sha/" folder,
// which is dropped so paths match the repo's own.
export async function untar(chunks: AsyncIterable<Buffer>, opts: { stripFirst?: boolean } = {}): Promise<Snapshot> {
  const snap: Snapshot = { files: {}, paths: [], bytes: 0, skipped: [] };
  const skip = new Map<string, Skipped>();
  const skipped = (reason: string, path: string) => {
    const s = skip.get(reason) ?? { reason, count: 0, examples: [] };
    s.count++;
    if (s.examples.length < 3) s.examples.push(path);
    skip.set(reason, s);
  };
  const header = Buffer.alloc(512);
  let filled = 0;
  type Body = { remaining: number; pad: number; parts: Buffer[] | null; path: string; type: string };
  let body = null as Body | null; // set inside start(), so not narrowed
  let padLeft = 0;
  let nextPath: string | null = null; // from a pax or GNU long-name entry
  let zeros = 0;

  const finish = (b: Body) => {
    const data = b.parts ? Buffer.concat(b.parts) : null;
    if (b.type === "x" && data) nextPath = pax(data).path ?? null;
    else if (b.type === "L" && data) nextPath = data.toString("utf8").replace(/\0+$/, "");
    else if (data) {
      // Text only: a NUL byte near the start means binary.
      if (data.subarray(0, 4096).includes(0)) skipped("binary files", b.path);
      else {
        snap.files[b.path] = data.toString("utf8");
        snap.bytes += data.length;
      }
    }
  };

  const start = (h: Buffer) => {
    const type = String.fromCharCode(h[156] || 0x30);
    const size = octal(h, 124, 12);
    let path = nextPath ?? (h.toString("latin1", 257, 262) === "ustar" && h[345] ? `${cstr(h, 345, 155)}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    if (type !== "x" && type !== "L") nextPath = null;
    if (opts.stripFirst) path = path.replace(/^[^/]*\/?/, "");
    let keep = false;
    if (type === "x" || type === "L") keep = size < 64 * 1024;
    else if ((type === "0" || type === "\0" || type === "7") && path) {
      if (snap.paths.length < LIMITS.paths) snap.paths.push(path);
      if (VENDORED.test(path)) skipped("vendored or built folders", path);
      else if (BINARY.test(path)) skipped("images, media and other binary files", path);
      else if (LOCKS.test(path)) skipped("lock files (names only)", path);
      else if (MINIFIED.test(path)) skipped("minified and generated files", path);
      else if (size > LIMITS.file) skipped(`files over ${LIMITS.file / 1024} KB`, path);
      else if (snap.bytes + size > LIMITS.total) skipped("files past the size limit", path);
      else keep = true;
    }
    body = { remaining: size, pad: (512 - (size % 512)) % 512, parts: keep ? [] : null, path, type };
    if (!size) {
      finish(body);
      padLeft = 0;
      body = null;
    }
  };

  for await (const chunk of chunks) {
    let off = 0;
    while (off < chunk.length) {
      if (body) {
        const n = Math.min(body.remaining, chunk.length - off);
        if (body.parts) body.parts.push(Buffer.from(chunk.subarray(off, off + n)));
        body.remaining -= n;
        off += n;
        if (!body.remaining) {
          padLeft = body.pad;
          finish(body);
          body = null;
        }
      } else if (padLeft) {
        const n = Math.min(padLeft, chunk.length - off);
        padLeft -= n;
        off += n;
      } else {
        const n = Math.min(512 - filled, chunk.length - off);
        chunk.copy(header, filled, off, off + n);
        filled += n;
        off += n;
        if (filled < 512) continue;
        filled = 0;
        if (header.every((x) => x === 0)) {
          if (++zeros >= 2) break;
          continue;
        }
        zeros = 0;
        start(header);
      }
    }
    if (zeros >= 2) break;
  }
  snap.skipped = [...skip.values()].sort((a, b) => b.count - a.count);
  return snap;
}

// The repo at `sha`, or null when it's too big or GitHub doesn't answer in time.
export async function download(fullName: string, sha: string, sizeKb: number): Promise<Snapshot | null> {
  if (sizeKb > LIMITS.repoKb) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMITS.ms);
  try {
    const res = await fetch(`https://codeload.github.com/${fullName}/tar.gz/${sha}`, {
      headers: { "User-Agent": "gitmanual (https://gitmanual.com)" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) return null;
    let read = 0;
    let cut = false;
    const counted = Readable.fromWeb(res.body as never).on("data", (c: Buffer) => {
      read += c.length;
      if (read > LIMITS.download) {
        cut = true;
        ctrl.abort();
      }
    });
    const gunzip = counted.pipe(createGunzip());
    counted.on("error", (e) => gunzip.destroy(e));
    const snap = await untar(gunzip, { stripFirst: true });
    // A partial archive would make files look missing: it's all or nothing.
    return cut || !snap.paths.length || snap.paths.length >= LIMITS.paths ? null : snap;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
