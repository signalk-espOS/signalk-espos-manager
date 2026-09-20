/**
 * Service-level helpers.
 *
 * filenameFromUrl is a security boundary: the URL comes from a third-party
 * registry entry, and it decides where a file lands in the cache.
 */

import { describe, expect, it } from "vitest";
import { filenameFromUrl } from "../src/service.js";

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
