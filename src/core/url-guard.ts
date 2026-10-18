import { isIP } from "node:net";

export const MAX_URL_LENGTH = 2048;

export type ParseWebUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: "invalid-url" | "unsafe-url"; error: string; detail: string };

export interface ParseWebUrlOptions {
  allowPrivateNetwork?: boolean;
}

function fail(reason: "invalid-url" | "unsafe-url", error: string, detail: string): ParseWebUrlResult {
  return { ok: false, reason, error, detail };
}

export function parseWebUrl(raw: string, opts: ParseWebUrlOptions = {}): ParseWebUrlResult {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return fail("invalid-url", "URL is empty", "empty url");
  if (trimmed.length > MAX_URL_LENGTH) {
    return fail("invalid-url", "URL is too long", `url length ${trimmed.length} exceeds ${MAX_URL_LENGTH}`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail("invalid-url", "URL could not be parsed", "not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("unsafe-url", "Only http and https URLs are allowed", `scheme ${url.protocol.replace(":", "")} is not allowed`);
  }
  if (url.username || url.password) {
    return fail("unsafe-url", "URLs with credentials are not allowed", "url contains userinfo");
  }
  url.hash = "";
  if (!opts.allowPrivateNetwork) {
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host) return fail("invalid-url", "URL has no host", "empty hostname");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
      return fail("unsafe-url", "Local hostnames are not allowed", `host ${host} is a local name`);
    }
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (isIP(bare) !== 0) {
      return fail("unsafe-url", "IP literal hosts are not allowed", "host is an IP literal");
    }
  }
  return { ok: true, url };
}

function parseIPv4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.some((n) => !(n >= 0 && n <= 255)) ? undefined : nums;
}

function blockedIPv4(o: number[]): boolean {
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
}

/** Expand an IPv6 address into 8 16-bit groups; handles `::` and trailing dotted IPv4. */
function parseIPv6(ip: string): number[] | undefined {
  let text = ip;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) return undefined;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (s: string): number[] | undefined => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  if (tail.length) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

function embeddedV4(g: number[], hi: number, lo: number): number[] {
  return [g[hi] >> 8, g[hi] & 0xff, g[lo] >> 8, g[lo] & 0xff];
}

function blockedIPv6(g: number[]): boolean {
  const allZeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroTo(7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32
  if (allZeroTo(5) && g[5] === 0xffff) return blockedIPv4(embeddedV4(g, 6, 7)); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedIPv4(embeddedV4(g, 6, 7)); // NAT64
  if (g[0] === 0x2002) return blockedIPv4(embeddedV4(g, 1, 2)); // 6to4
  if (allZeroTo(6)) return blockedIPv4(embeddedV4(g, 6, 7)); // deprecated IPv4-compatible
  return false;
}

/** True when the address is private, reserved, or not a valid IP (fail closed). */
export function isBlockedAddress(ip: string): boolean {
  const text = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const family = isIP(text);
  if (family === 4) {
    const o = parseIPv4(text);
    return !o || blockedIPv4(o);
  }
  if (family === 6) {
    const g = parseIPv6(text);
    return !g || blockedIPv6(g);
  }
  return true;
}

/** Label safe for logs and display: origin + path, query redacted. */
export function maskUrl(url: URL): string {
  return `${url.origin}${url.pathname}${url.search ? "?<redacted>" : ""}`;
}
