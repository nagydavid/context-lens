import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { pipeline, Readable } from "node:stream";
import { TextDecoder } from "node:util";
import zlib from "node:zlib";
import type { FallbackReason } from "./models.js";
import { isBlockedAddress, parseWebUrl } from "./url-guard.js";

export const DEFAULT_WEB_TIMEOUT_MS = 15000;
export const DEFAULT_WEB_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_WEB_MAX_REDIRECTS = 5;

const BINARY_SNIFF_BYTES = 8192;
const META_SNIFF_BYTES = 1024;
const ALLOWED_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/x-markdown"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const UNSAFE_ADDRESS_CODE = "EPARADOC_UNSAFE_ADDRESS";

/** Resolves a hostname to the addresses a connection may use; rejects when any is unsafe. */
export type LookupFn = (hostname: string) => Promise<string[]>;

export interface WebTransportRequest {
  url: URL;
  signal: AbortSignal;
  headers: Record<string, string>;
  lookup?: LookupFn;
}

export interface WebTransportResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  /** Releases the underlying connection without reading the rest of the body. */
  close?: () => void;
}

export type WebTransport = (req: WebTransportRequest) => Promise<WebTransportResponse>;

export interface WebFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolveHost?: (hostname: string) => Promise<string[]>;
  transport?: WebTransport;
  /** Test-only: permits loopback/private hosts and IP literals. */
  allowPrivateNetwork?: boolean;
}

export type WebFetchResult =
  | { ok: true; finalUrl: URL; contentType: string; mediaType: string; text: string; bytes: number; redirects: number }
  | { ok: false; reason: FallbackReason; error: string; detail: string };

type Failure = Extract<WebFetchResult, { ok: false }>;

class DeadlineError extends Error {}

class UnsafeAddressError extends Error {
  readonly code = UNSAFE_ADDRESS_CODE;
  constructor(hostname: string) {
    super(`host ${hostname} resolves to a private or reserved address range`);
  }
}

function failure(reason: FallbackReason, error: string, detail: string): Failure {
  return { ok: false, reason, error, detail };
}

const defaultResolveHost = async (hostname: string): Promise<string[]> =>
  (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeadlineError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeadlineError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export const defaultWebTransport: WebTransport = (req) =>
  new Promise<WebTransportResponse>((resolve, reject) => {
    const lookupFn = req.lookup;
    const lookup = lookupFn
      ? ((hostname: string, options: { all?: boolean } | undefined, cb: (...args: unknown[]) => void) => {
          lookupFn(hostname).then(
            (addresses) => {
              if (addresses.length === 0) return cb(new Error(`no addresses for ${hostname}`));
              const entries = addresses.map((address) => ({ address, family: isIP(address) }));
              if (options && options.all) cb(null, entries);
              else cb(null, entries[0].address, entries[0].family);
            },
            (err) => cb(err),
          );
        })
      : undefined;
    const mod = req.url.protocol === "https:" ? https : http;
    const request = mod.request(
      req.url,
      { method: "GET", headers: req.headers, agent: false, signal: req.signal, lookup } as http.RequestOptions,
      (res) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        }
        resolve({ status: res.statusCode ?? 0, headers, body: res, close: () => res.destroy() });
      },
    );
    request.on("error", reject);
    request.end();
  });

function parseContentType(header: string | undefined): { mediaType: string; charset?: string } {
  if (!header) return { mediaType: "" };
  const [type, ...params] = header.split(";");
  let charset: string | undefined;
  for (const param of params) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(param);
    if (match) charset = match[1];
  }
  return { mediaType: type.trim().toLowerCase(), charset };
}

function decodeText(buf: Buffer, headerCharset: string | undefined): string {
  let label = headerCharset;
  if (!label) {
    const head = buf.subarray(0, META_SNIFF_BYTES).toString("latin1");
    const meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head);
    label = meta?.[1];
  }
  let decoder: InstanceType<typeof TextDecoder>;
  try {
    decoder = new TextDecoder(label ?? "utf-8", { fatal: false });
  } catch {
    decoder = new TextDecoder("utf-8", { fatal: false });
  }
  return decoder.decode(buf);
}

function decompressor(encoding: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | undefined {
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip();
  if (encoding === "deflate") return zlib.createInflate();
  if (encoding === "br") return zlib.createBrotliDecompress();
  return undefined;
}

async function readBody(resp: WebTransportResponse, signal: AbortSignal, maxBytes: number): Promise<Buffer | Failure> {
  const encoding = (resp.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  let source: AsyncIterable<Uint8Array> = resp.body;
  let decoder: ReturnType<typeof decompressor>;
  if (encoding !== "identity" && encoding !== "") {
    decoder = decompressor(encoding);
    if (!decoder) return failure("fetch-failed", "Unsupported content encoding", `content-encoding ${encoding}`);
    const target = decoder;
    pipeline(Readable.from(resp.body), target, () => undefined);
    source = target;
  }
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await raceAbort(iterator.next(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        return failure("content-too-large", "Document is too large", `body exceeded ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength));
    }
  } finally {
    decoder?.destroy();
    try {
      void iterator.return?.();
    } catch {
      // best effort
    }
    resp.close?.();
  }
  return Buffer.concat(chunks, total);
}

export async function fetchWebDocument(url: URL, opts: WebFetchOptions = {}): Promise<WebFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_WEB_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_WEB_MAX_REDIRECTS;
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const transport = opts.transport ?? defaultWebTransport;
  const allowPrivateNetwork = opts.allowPrivateNetwork === true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;

  const guardedLookup: LookupFn = async (hostname) => {
    const addresses = await resolveHost(hostname);
    if (addresses.length === 0) throw new Error(`no addresses for ${hostname}`);
    if (!allowPrivateNetwork && addresses.some(isBlockedAddress)) throw new UnsafeAddressError(hostname);
    return addresses;
  };

  try {
    let current = url;
    let redirects = 0;
    for (;;) {
      const parsed = parseWebUrl(current.href, { allowPrivateNetwork });
      if (!parsed.ok) return failure(parsed.reason, parsed.error, parsed.detail);
      current = parsed.url;

      try {
        await raceAbort(guardedLookup(current.hostname.replace(/^\[|\]$/g, "")), signal);
      } catch (err) {
        if (err instanceof DeadlineError) throw err;
        if (err instanceof UnsafeAddressError) return failure("unsafe-url", "URL resolves to a blocked address", err.message);
        return failure("fetch-failed", "Host could not be resolved", err instanceof Error ? err.message : String(err));
      }

      let resp: WebTransportResponse;
      try {
        resp = await raceAbort(
          transport({
            url: current,
            signal,
            lookup: guardedLookup,
            headers: {
              Accept: "text/html, application/xhtml+xml, text/markdown, text/plain;q=0.9",
              "Accept-Encoding": "identity",
              "User-Agent": "paradoc-web-read/0.1",
            },
          }),
          signal,
        );
      } catch (err) {
        if (err instanceof DeadlineError || signal.aborted) throw new DeadlineError();
        const code = (err as { code?: string } | undefined)?.code;
        const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
        if (code === UNSAFE_ADDRESS_CODE || cause?.code === UNSAFE_ADDRESS_CODE) {
          return failure("unsafe-url", "URL resolves to a blocked address", (err as Error).message);
        }
        return failure("fetch-failed", "Request failed", err instanceof Error ? err.message : String(err));
      }

      if (REDIRECT_STATUSES.has(resp.status) && resp.headers["location"]) {
        resp.close?.();
        if (redirects >= maxRedirects) {
          return failure("too-many-redirects", "Too many redirects", `exceeded ${maxRedirects} redirects`);
        }
        redirects += 1;
        try {
          current = new URL(resp.headers["location"], current);
        } catch {
          return failure("fetch-failed", "Invalid redirect target", "location header is not a valid URL");
        }
        continue;
      }

      if (resp.status < 200 || resp.status > 299) {
        resp.close?.();
        return failure("fetch-failed", "Server returned an error status", `HTTP ${resp.status}`);
      }

      const contentType = resp.headers["content-type"] ?? "";
      const { mediaType, charset } = parseContentType(contentType);
      if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
        resp.close?.();
        return failure("unsupported-content-type", "Content type is not supported", `media type ${mediaType || "(missing)"}`);
      }
      const advertised = Number(resp.headers["content-length"]);
      if (Number.isFinite(advertised) && advertised > maxBytes) {
        resp.close?.();
        return failure("content-too-large", "Document is too large", `content-length ${advertised} exceeds ${maxBytes} bytes`);
      }

      const body = await readBody(resp, signal, maxBytes);
      if (!Buffer.isBuffer(body)) return body;
      if (body.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        return failure("unsupported-content-type", "Content appears to be binary", "NUL byte in document head");
      }
      return {
        ok: true,
        finalUrl: current,
        contentType,
        mediaType,
        text: decodeText(body, charset),
        bytes: body.length,
        redirects,
      };
    }
  } catch (err) {
    if (err instanceof DeadlineError || signal.aborted) {
      return failure("timeout", "Fetch timed out", `fetch exceeded ${timeoutMs}ms`);
    }
    return failure("fetch-failed", "Fetch failed", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
