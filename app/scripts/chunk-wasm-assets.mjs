#!/usr/bin/env node
/**
 * Post-build step for Cloudflare Workers Static Assets, which rejects any single
 * file larger than 25 MiB.
 *
 * For every oversized .wasm in the target directory this script gzip-compresses the
 * binary (unless --encoding identity is given), splits the result into chunks that
 * sit safely below the limit, verifies from disk that the chunks reassemble into a
 * byte-identical module, deletes the original, and injects a classic loader script
 * into each HTML page that references it. The loader serves the reassembled module
 * to the existing wasm-bindgen init() call, so neither Trunk's HTML nor the
 * generated JS glue needs hand editing.
 *
 * Usage, from the app/ directory after `vite build`:
 *   node scripts/chunk-wasm-assets.mjs [--dist dist] [--dir wordcraft]
 *     [--chunk-mib 20] [--encoding gzip|identity] [--always] [--public-base /wordcraft/]
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync, constants as zlibConstants } from 'node:zlib';

const CLOUDFLARE_ASSET_LIMIT = 25 * 1024 * 1024;
const LOADER_FILE_NAME = 'wasm-chunks.js';
const MANIFEST_FILE_NAME = 'wasm-chunks.manifest.json';
const MANIFEST_PLACEHOLDER = '__WASM_CHUNK_MANIFEST__';
const LOADER_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wasm-chunk-loader.js');

function parseArgs(argv) {
  const options = {
    dist: 'dist',
    dir: 'wordcraft',
    chunkMiB: 20,
    encoding: 'gzip',
    always: false,
    publicBase: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--dist': options.dist = next(); break;
      case '--dir': options.dir = next(); break;
      case '--chunk-mib': options.chunkMiB = Number(next()); break;
      case '--encoding': options.encoding = next(); break;
      case '--always': options.always = true; break;
      case '--public-base': options.publicBase = next(); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!['gzip', 'identity'].includes(options.encoding)) {
    throw new Error(`--encoding must be gzip or identity, received ${options.encoding}`);
  }
  if (!(options.chunkMiB > 0) || options.chunkMiB * 1024 * 1024 >= CLOUDFLARE_ASSET_LIMIT) {
    throw new Error('--chunk-mib must be greater than 0 and below 25 so every chunk fits the limit');
  }
  return options;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Windows path separators must never leak into URLs written to the HTML or manifest.
const toUrlPath = (p) => p.split(path.sep).join('/');

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function chunkAsset(wasmPath, options) {
  const name = path.basename(wasmPath);
  const dir = path.dirname(wasmPath);
  const original = await fs.readFile(wasmPath);
  const payload = options.encoding === 'gzip'
    ? gzipSync(original, { level: zlibConstants.Z_BEST_COMPRESSION, memLevel: 9 })
    : original;

  const chunkSize = Math.floor(options.chunkMiB * 1024 * 1024);
  const chunks = [];
  for (let offset = 0, index = 0; offset < payload.length; offset += chunkSize, index += 1) {
    const part = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
    // The content hash in the name keeps chunks from different builds distinct in caches,
    // and the .bin extension stops any server from inferring a Content-Encoding for them.
    const file = `${name}.${sha256(part).slice(0, 12)}.${String(index).padStart(3, '0')}.bin`;
    await fs.writeFile(path.join(dir, file), part);
    chunks.push({ file, size: part.length });
  }

  // Re-read the chunks from disk and prove they decode to the exact original bytes
  // before anything is deleted, so a faulty run can never leave a broken deployment.
  const reread = Buffer.concat(await Promise.all(chunks.map((c) => fs.readFile(path.join(dir, c.file)))));
  const decoded = options.encoding === 'gzip' ? gunzipSync(reread) : reread;
  const originalHash = sha256(original);
  if (decoded.length !== original.length || sha256(decoded) !== originalHash) {
    throw new Error(`Reassembly check failed for ${name}; the original file has been left in place`);
  }

  await fs.unlink(wasmPath);
  console.log(
    `[chunk-wasm] ${name}: ${mib(original.length)} -> ${mib(payload.length)} ${options.encoding} ` +
    `in ${chunks.length} chunk(s), verified sha256 ${originalHash.slice(0, 16)}`,
  );
  return { name, encoding: options.encoding, size: original.length, sha256: originalHash, chunks };
}

async function patchHtml(targetDir, assets, loaderSrc) {
  const tag = `<script data-wasm-chunks src="${loaderSrc}"></script>`;
  let patchedCount = 0;
  for await (const file of walk(targetDir)) {
    if (!/\.html?$/i.test(file)) continue;
    const before = await fs.readFile(file, 'utf8');
    if (!assets.some((asset) => before.includes(asset.name))) continue;

    let html = before;
    for (const asset of assets) {
      // Only <link> tags (Trunk's preload) are removed, because the init() call itself
      // keeps its original URL and is answered by the loader's fetch wrapper.
      const linkPattern = new RegExp(
        `[ \\t]*<link\\b[^>]*\\bhref\\s*=\\s*["'][^"']*${escapeRegExp(asset.name)}[^"']*["'][^>]*>[ \\t]*\\r?\\n?`,
        'gi',
      );
      html = html.replace(linkPattern, '');
    }
    if (!html.includes('data-wasm-chunks')) {
      const head = /<head\b[^>]*>/i;
      html = head.test(html) ? html.replace(head, (match) => `${match}\n    ${tag}`) : `${tag}\n${html}`;
    }
    if (html !== before) {
      await fs.writeFile(file, html);
      patchedCount += 1;
      console.log(`[chunk-wasm] patched ${toUrlPath(path.relative(process.cwd(), file))}`);
    }
  }
  return patchedCount;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const distRoot = path.resolve(options.dist);
  const targetDir = path.resolve(distRoot, options.dir);

  if (await exists(targetDir)) {
    const manifestPath = path.join(targetDir, MANIFEST_FILE_NAME);
    let assets = (await exists(manifestPath))
      ? JSON.parse(await fs.readFile(manifestPath, 'utf8')).assets ?? []
      : [];

    for (const entry of await fs.readdir(targetDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.wasm')) continue;
      const full = path.join(targetDir, entry.name);
      const { size } = await fs.stat(full);
      if (!options.always && size <= CLOUDFLARE_ASSET_LIMIT) continue;
      const asset = await chunkAsset(full, options);
      assets = assets.filter((existing) => existing.name !== asset.name).concat(asset);
    }

    if (assets.length > 0) {
      const relative = toUrlPath(path.relative(distRoot, targetDir));
      let base = options.publicBase ?? (relative ? `/${relative}/` : '/');
      if (!base.endsWith('/')) base += '/';
      const manifest = { base, assets };

      const template = await fs.readFile(LOADER_TEMPLATE, 'utf8');
      if (!template.includes(MANIFEST_PLACEHOLDER)) {
        throw new Error(`${LOADER_TEMPLATE} does not contain the manifest placeholder`);
      }
      // A replacer function is used so that "$" sequences in the JSON are never
      // interpreted as String.prototype.replace substitution patterns.
      const loader = template.replace(MANIFEST_PLACEHOLDER, () => JSON.stringify(manifest));
      await fs.writeFile(path.join(targetDir, LOADER_FILE_NAME), loader);
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const patched = await patchHtml(targetDir, assets, `${base}${LOADER_FILE_NAME}`);
      if (patched === 0 && !(await exists(path.join(targetDir, 'index.html')))) {
        console.warn(
          `[chunk-wasm] no HTML in ${options.dir} references the wasm, so add ` +
          `<script src="${base}${LOADER_FILE_NAME}"></script> to the page before init() runs`,
        );
      }
    } else {
      console.log(`[chunk-wasm] no .wasm in ${options.dir} exceeds ${mib(CLOUDFLARE_ASSET_LIMIT)}, nothing to do`);
    }
  } else {
    console.warn(`[chunk-wasm] ${targetDir} does not exist, skipping chunking but still checking sizes`);
  }

  // Guard the whole output directory so that any other oversized file fails the build
  // here, with a clear message, instead of failing later inside wrangler.
  const oversized = [];
  if (await exists(distRoot)) {
    for await (const file of walk(distRoot)) {
      const { size } = await fs.stat(file);
      if (size > CLOUDFLARE_ASSET_LIMIT) oversized.push(`${toUrlPath(path.relative(distRoot, file))} (${mib(size)})`);
    }
  }
  if (oversized.length > 0) {
    throw new Error(`files still exceed the Cloudflare 25 MiB asset limit:\n  ${oversized.join('\n  ')}`);
  }
}

main().catch((error) => {
  console.error(`[chunk-wasm] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
