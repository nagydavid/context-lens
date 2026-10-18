import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { isBlockedAddress, maskUrl, parseWebUrl } from "./url-guard.js";

function reason(raw: string, opts?: { allowPrivateNetwork?: boolean }): string {
  const result = parseWebUrl(raw, opts);
  return result.ok ? "ok" : result.reason;
}

describe("parseWebUrl", () => {
  it("accepts http and https documentation URLs and strips the hash", () => {
    const result = parseWebUrl("  https://docs.example.com/guide?x=1#section ");
    ok(result.ok);
    strictEqual(result.url.href, "https://docs.example.com/guide?x=1");
    strictEqual(reason("http://docs.example.com/"), "ok");
  });

  it("rejects empty, unparsable and over-long input as invalid-url", () => {
    strictEqual(reason(""), "invalid-url");
    strictEqual(reason("   "), "invalid-url");
    strictEqual(reason("not a url"), "invalid-url");
    strictEqual(reason("https://example.com/" + "a".repeat(2048)), "invalid-url");
  });

  it("rejects non-http schemes", () => {
    for (const raw of ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "data:text/plain,hi"]) {
      strictEqual(reason(raw), "unsafe-url", raw);
    }
  });

  it("rejects credentials in the URL", () => {
    strictEqual(reason("https://user:pw@example.com/"), "unsafe-url");
    strictEqual(reason("https://user@example.com/"), "unsafe-url");
  });

  it("rejects local hostnames", () => {
    for (const host of ["localhost", "LOCALHOST", "app.localhost", "printer.local", "db.internal", "localhost."]) {
      strictEqual(reason(`http://${host}/`), "unsafe-url", host);
    }
  });

  it("rejects IP literals including numeric IPv4 forms and IPv6", () => {
    for (const host of ["127.0.0.1", "8.8.8.8", "2130706433", "0x7f.1", "017700000001", "[::1]", "[2606:4700::1111]", "[::ffff:127.0.0.1]"]) {
      strictEqual(reason(`http://${host}/`), "unsafe-url", host);
    }
  });

  it("allowPrivateNetwork skips only the IP and hostname checks", () => {
    strictEqual(reason("http://127.0.0.1:8080/", { allowPrivateNetwork: true }), "ok");
    strictEqual(reason("http://localhost/", { allowPrivateNetwork: true }), "ok");
    strictEqual(reason("file:///etc/passwd", { allowPrivateNetwork: true }), "unsafe-url");
    strictEqual(reason("http://u:p@127.0.0.1/", { allowPrivateNetwork: true }), "unsafe-url");
  });
});

describe("isBlockedAddress", () => {
  it("blocks reserved IPv4 ranges", () => {
    for (const ip of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254",
      "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.168.1.1", "198.18.0.1", "198.19.255.255",
      "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    ]) {
      ok(isBlockedAddress(ip), ip);
    }
  });

  it("allows public IPv4 addresses and range edges", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "198.17.0.1", "198.20.0.1", "223.255.255.255"]) {
      ok(!isBlockedAddress(ip), ip);
    }
  });

  it("blocks reserved IPv6 ranges", () => {
    for (const ip of ["::", "::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "2001:db8::1", "2001:0db8:ffff::1"]) {
      ok(isBlockedAddress(ip), ip);
    }
  });

  it("re-checks embedded IPv4 in mapped, NAT64 and 6to4 forms", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "2002:7f00:1::", "2002:c0a8:101::1"]) {
      ok(isBlockedAddress(ip), ip);
    }
    for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1"]) {
      ok(!isBlockedAddress(ip), ip);
    }
  });

  it("allows public IPv6 addresses", () => {
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001::200e", "2001:4860:4860::8888"]) {
      ok(!isBlockedAddress(ip), ip);
    }
  });

  it("fails closed on non-IP input", () => {
    for (const bad of ["", "example.com", "999.1.1.1", "1.2.3", "::g", "garbage"]) {
      ok(isBlockedAddress(bad), bad);
    }
  });
});

describe("maskUrl", () => {
  it("returns origin and path and redacts the query", () => {
    strictEqual(maskUrl(new URL("https://docs.example.com/a/b?token=secret&x=1")), "https://docs.example.com/a/b?<redacted>");
    strictEqual(maskUrl(new URL("https://docs.example.com:8443/a")), "https://docs.example.com:8443/a");
    deepStrictEqual(maskUrl(new URL("https://docs.example.com/")).includes("secret"), false);
  });
});
