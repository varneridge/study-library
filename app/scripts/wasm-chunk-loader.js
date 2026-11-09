/*
 * Runtime half of scripts/chunk-wasm-assets.mjs. It is injected as a classic,
 * non-module script, which means it executes during HTML parsing and therefore
 * before Trunk's deferred module script calls the wasm-bindgen init() function.
 *
 * Every chunk starts downloading immediately, which replaces the preload link that
 * the build step removed. window.fetch is wrapped so that a request for the original
 * *_bg.wasm URL resolves to a synthetic application/wasm Response whose body streams
 * the chunks in order, through DecompressionStream when they are gzip encoded. The
 * correct MIME type keeps wasm-bindgen on WebAssembly.instantiateStreaming, so the
 * module compiles while it downloads instead of after a full concatenation.
 *
 * For pages that call init() explicitly, window.__chunkedWasm.response() returns the
 * same Response, which can be passed as init({ module_or_path: ... }).
 */
(function (manifest) {
  'use strict';

  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  // If the page includes the loader twice, the first instance keeps ownership of fetch.
  if (window.__chunkedWasm) return;

  const nativeFetch = window.fetch.bind(window);
  const current = document.currentScript;
  const baseUrl = current && current.src ? current.src : new URL(manifest.base, location.href).href;
  const byName = new Map(manifest.assets.map((asset) => [asset.name, asset]));
  const pending = new Map();

  function startDownload(asset) {
    const existing = pending.get(asset.name);
    if (existing) return existing;

    const parts = asset.chunks.map((chunk) =>
      nativeFetch(new URL(chunk.file, baseUrl).href, { credentials: 'same-origin' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status} while fetching wasm chunk ${chunk.file}`);
          return res.arrayBuffer();
        })
        .then((buffer) => {
          if (buffer.byteLength !== chunk.size) {
            throw new Error(
              `wasm chunk ${chunk.file} is ${buffer.byteLength} bytes but ${chunk.size} were expected, ` +
              'so a stale cache or an intermediary has altered it',
            );
          }
          return new Uint8Array(buffer);
        }));

    pending.set(asset.name, parts);
    // A failed download is forgotten so that a later init() attempt starts afresh, and
    // attaching this handler also prevents the eager prefetch from being reported as an
    // unhandled rejection before anything has consumed it.
    Promise.all(parts).catch(() => {
      if (pending.get(asset.name) === parts) pending.delete(asset.name);
    });
    return parts;
  }

  function bodyFor(asset) {
    const parts = startDownload(asset);
    let index = 0;
    let stream = new ReadableStream({
      async pull(controller) {
        if (index >= parts.length) {
          // Once every chunk has been streamed the compressed bytes are no longer needed,
          // so they are released rather than pinned for the lifetime of the page.
          if (pending.get(asset.name) === parts) pending.delete(asset.name);
          controller.close();
          return;
        }
        controller.enqueue(await parts[index]);
        index += 1;
      },
    });

    if (asset.encoding === 'gzip') {
      if (typeof DecompressionStream !== 'function') {
        throw new Error(
          'This browser lacks DecompressionStream, which is needed to decode the gzip wasm chunks; ' +
          'rebuild with --encoding identity if such browsers must be supported',
        );
      }
      stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    return stream;
  }

  function response(name) {
    const asset = name
      ? byName.get(name)
      : manifest.assets.length === 1 ? manifest.assets[0] : undefined;
    if (!asset) throw new Error(`No chunked wasm asset named ${name || '(default)'}`);
    return new Response(bodyFor(asset), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/wasm' },
    });
  }

  function assetForRequest(input, init) {
    try {
      const isRequest = typeof Request !== 'undefined' && input instanceof Request;
      const method = (init && init.method) || (isRequest ? input.method : 'GET');
      if (String(method).toUpperCase() !== 'GET') return undefined;
      const url = isRequest ? new URL(input.url) : new URL(String(input), document.baseURI);
      if (url.origin !== location.origin) return undefined;
      const file = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
      return byName.get(file);
    } catch (_) {
      return undefined;
    }
  }

  window.fetch = function chunkedWasmFetch(input, init) {
    const asset = assetForRequest(input, init);
    if (!asset) return nativeFetch(input, init);
    try {
      return Promise.resolve(response(asset.name));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  window.__chunkedWasm = {
    manifest,
    response,
    async bytes(name) {
      return new Uint8Array(await response(name).arrayBuffer());
    },
  };

  manifest.assets.forEach(startDownload);
})(__WASM_CHUNK_MANIFEST__);
