/**
 * Service-level helpers.
 *
 * filenameFromUrl is a security boundary: the URL comes from a third-party
 * registry entry, and it decides where a file lands in the cache.
 */

import { describe, expect, it } from "vitest";
import type os from "node:os";
import { filenameFromUrl, localAddressFor } from "../src/service.js";

describe("filenameFromUrl", () => {
  it("takes the last path segment of a real release URL", () => {
    expect(
      filenameFromUrl(
        "https://github.com/dirkwa/espos-p4-cockpit/releases/download/v1.2.0/p4_cockpit-v1.2.0-ota.bin",
      ),
    ).toBe("p4_cockpit-v1.2.0-ota.bin");
  });

  it("handles a root-relative mirror URL", () => {
    expect(
      filenameFromUrl("/signalk-espos-manager/fw/cockpit/1.3.0/app.bin"),
    ).toBe("app.bin");
  });

  it("refuses a crafted segment rather than using it", () => {
    // A registry entry must not be able to choose where the file lands.
    for (const url of [
      "https://x.invalid/a/../../etc/passwd",
      "https://x.invalid/",
      "https://x.invalid/.hidden",
      "https://x.invalid/-leading",
      "https://x.invalid/" + "x".repeat(200),
    ]) {
      const name = filenameFromUrl(url);
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
      expect(name).not.toContain("..");
      expect(name).not.toContain("/");
    }
  });

  it("falls back to a neutral name for an unusable URL", () => {
    expect(filenameFromUrl("https://x.invalid/")).toBe("firmware.bin");
    expect(filenameFromUrl("")).toBe("firmware.bin");
  });

  it("ignores a query string", () => {
    expect(filenameFromUrl("https://x.invalid/a/ota.bin?token=secret")).toBe(
      "ota.bin",
    );
  });
});

describe("localAddressFor", () => {
  // The interface list from the boat server this was developed on: two IPv4
  // addresses on eth0, one on wlan0, a container bridge, and loopback.
  const boat = {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    eth0: [
      { family: "IPv4", address: "172.31.3.148", internal: false },
      { family: "IPv4", address: "192.168.0.148", internal: false },
    ],
    wlan0: [{ family: "IPv4", address: "192.168.0.147", internal: false }],
    moinnet: [{ family: "IPv4", address: "10.211.0.2", internal: false }],
  } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

  it("gives a device the address on its own network", () => {
    // The critical case: handing a device 127.0.0.1 makes it look at itself
    // and find nothing, so every mirrored update would fail.
    expect(localAddressFor("192.168.0.167", boat)).toMatch(/^192\.168\.0\./);
    expect(localAddressFor("10.211.0.9", boat)).toBe("10.211.0.2");
    expect(localAddressFor("172.31.3.9", boat)).toBe("172.31.3.148");
  });

  it("never returns loopback when a real interface exists", () => {
    expect(localAddressFor("192.168.0.167", boat)).not.toBe("127.0.0.1");
    expect(localAddressFor(undefined, boat)).not.toBe("127.0.0.1");
  });

  it("falls back to loopback only when there is nothing else", () => {
    const only = {
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    expect(localAddressFor("192.168.0.167", only)).toBe("127.0.0.1");
  });
});
