/**
 * Manifest-generation tests.
 *
 * The version-comparison cases come from `test/fixtures/version-compare.json`,
 * whose expected values were produced by compiling espOS's own
 * `espos_ota_version_cmp` and running it — not by reasoning about what it
 * ought to return. The plugin and the device must never disagree about which
 * build is newer, because that disagreement offers the wrong firmware and
 * nothing reports it. See `test/fixtures/regenerate-vercmp.md`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  firmwareUrlFor,
  generateManifest,
  isNewer,
  isReleaseVersion,
  manifestPathFor,
  manifestUrlFits,
  MAX_MANIFEST_BYTES,
  MAX_NOTES_BYTES,
  truncateBytes,
} from "../src/mirror/manifest.js";
import { PUBLIC_FW_BASE } from "../src/config.js";
import type { ManifestBuildInput } from "../src/mirror/manifest.js";

interface OracleCase {
  a: string;
  b: string;
  expected: number;
}

const oracle: { cases: OracleCase[] } = JSON.parse(
  readFileSync(
    new URL("./fixtures/version-compare.json", import.meta.url),
    "utf8",
  ),
) as { cases: OracleCase[] };

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe("compareVersions matches the firmware", () => {
  it.each(oracle.cases)(
    "$a vs $b -> $expected (per the C oracle)",
    ({ a, b, expected }) => {
      expect(sign(compareVersions(a, b))).toBe(expected);
    },
  );

  it("has cases covering the shapes devices actually report", () => {
    const pairs = oracle.cases.map((c) => `${c.a}|${c.b}`).join(" ");
    expect(pairs).toContain("g44590ce"); // git-describe build
    expect(pairs).toContain("v1.2.0"); // v prefix
    expect(pairs).toContain("+build7"); // build metadata
    expect(oracle.cases.length).toBeGreaterThanOrEqual(20);
  });
});

describe("isNewer and isReleaseVersion", () => {
  it("treats a git-describe build as older than its release", () => {
    // This is the live trap: all three devices on the boat run versions like
    // 1.1.0-12-g44590ce-dirty, which compare BELOW 1.1.0.
    expect(isNewer("1.1.0", "1.1.0-12-g44590ce-dirty")).toBe(true);
    expect(isReleaseVersion("1.1.0-12-g44590ce-dirty")).toBe(false);
    expect(isReleaseVersion("1.1.0")).toBe(true);
    expect(isReleaseVersion("v1.2.0")).toBe(true);
  });

  it("does not call an equal version newer", () => {
    expect(isNewer("1.2.0", "1.2.0")).toBe(false);
  });
});

describe("truncateBytes", () => {
  it("leaves a short string alone", () => {
    expect(truncateBytes("hello", 10)).toBe("hello");
  });

  it("never splits a multi-byte character", () => {
    // Truncation on the device is a byte operation; half a character would
    // make the JSON invalid.
    const value = "aé".repeat(50); // é is two bytes
    for (let limit = 1; limit <= 40; limit += 1) {
      const out = truncateBytes(value, limit);
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(limit);
      expect(
        () => JSON.parse(JSON.stringify({ out })) as unknown,
      ).not.toThrow();
      expect(out).toBe(Buffer.from(out, "utf8").toString("utf8"));
    }
  });
});

function build(over: Partial<ManifestBuildInput> = {}): ManifestBuildInput {
  return {
    version: "1.3.0",
    target: "esp32p4",
    channel: "stable",
    url: "/signalk-espos-manager/fw/cockpit/1.3.0/p4_cockpit-esp32p4-v1.3.0-ota.bin",
    size: 4612096,
    ...over,
  };
}

describe("generateManifest", () => {
  it("emits the shape the device parses", () => {
    const { manifest, json, warnings } = generateManifest("cockpit", [build()]);
    expect(manifest.schema).toBe(1);
    // `app` must equal the device's project() name, which is what
    // espos_ota_manifest_pick strcmps against.
    expect(manifest.app).toBe("cockpit");
    expect(manifest.builds).toHaveLength(1);
    expect(manifest.builds[0]?.target).toBe("esp32p4");
    expect(warnings).toEqual([]);
    expect(JSON.parse(json)).toEqual(manifest);
  });

  it("strips a leading v from the version", () => {
    const { manifest } = generateManifest("cockpit", [
      build({ version: "v1.3.0" }),
    ]);
    expect(manifest.builds[0]?.version).toBe("1.3.0");
  });

  it("drops a build whose version cannot fit the device buffer", () => {
    const { manifest, warnings } = generateManifest("cockpit", [
      build({ version: "1.3.0-" + "x".repeat(40) }),
    ]);
    expect(manifest.builds).toHaveLength(0);
    expect(warnings[0]).toMatch(/the version is \d+ bytes/);
  });

  it("drops a build whose URL cannot fit the device buffer", () => {
    const { manifest, warnings } = generateManifest("cockpit", [
      build({ url: "/x/" + "y".repeat(300) }),
    ]);
    expect(manifest.builds).toHaveLength(0);
    expect(warnings[0]).toMatch(/firmware URL is \d+ bytes/);
  });

  it("truncates over-long notes rather than dropping the build", () => {
    const { manifest, warnings } = generateManifest("cockpit", [
      build({ notes: "n".repeat(400) }),
    ]);
    expect(manifest.builds).toHaveLength(1);
    const notes = manifest.builds[0]?.notes ?? "";
    expect(Buffer.byteLength(notes, "utf8")).toBeLessThanOrEqual(
      MAX_NOTES_BYTES,
    );
    expect(warnings.some((w) => /truncated the release notes/.test(w))).toBe(
      true,
    );
  });

  it("collapses whitespace in notes so a changelog stays one line", () => {
    const { manifest } = generateManifest("cockpit", [
      build({ notes: "line one\n\nline two\t  end" }),
    ]);
    expect(manifest.builds[0]?.notes).toBe("line one line two end");
  });

  it("omits a malformed sha256 rather than passing it through", () => {
    const { manifest } = generateManifest("cockpit", [
      build({ sha256: "not-a-hash" }),
    ]);
    expect(manifest.builds[0]?.sha256).toBeUndefined();
  });

  it("keeps a well-formed sha256", () => {
    const hash = "a".repeat(64);
    const { manifest } = generateManifest("cockpit", [build({ sha256: hash })]);
    expect(manifest.builds[0]?.sha256).toBe(hash);
  });

  it("emits only the calendar part of a date", () => {
    const { manifest } = generateManifest("cockpit", [
      build({ date: "2026-09-20T08:31:29.833Z" }),
    ]);
    expect(manifest.builds[0]?.date).toBe("2026-09-20");
  });

  it("drops a non-finite size instead of emitting Infinity", () => {
    // The firmware range-checks this because a manifest saying 1e999 parses
    // as infinity and casting that to size_t is undefined behaviour. Do not
    // hand it one in the first place.
    const { manifest } = generateManifest("cockpit", [
      build({ size: Number.POSITIVE_INFINITY }),
    ]);
    expect(manifest.builds[0]?.size).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("null");
  });

  it("orders builds newest first within a target and channel", () => {
    const { manifest } = generateManifest("cockpit", [
      build({ version: "1.2.0" }),
      build({ version: "1.10.0" }),
      build({ version: "1.3.0" }),
    ]);
    expect(manifest.builds.map((b) => b.version)).toEqual([
      "1.10.0",
      "1.3.0",
      "1.2.0",
    ]);
  });

  it("trims to fit the device buffer, keeping the newest of each target", () => {
    const many: ManifestBuildInput[] = [];
    for (let i = 0; i < 400; i += 1) {
      many.push(
        build({
          version: `1.${i}.0`,
          target: i % 2 === 0 ? "esp32p4" : "esp32c6",
          notes: "n".repeat(100),
        }),
      );
    }
    const { manifest, json, warnings } = generateManifest("cockpit", many);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(
      MAX_MANIFEST_BYTES,
    );
    expect(warnings.some((w) => /to keep the manifest under/.test(w))).toBe(
      true,
    );
    // The newest build of each target survives the trim.
    const targets = new Set(manifest.builds.map((b) => b.target));
    expect(targets).toContain("esp32p4");
    expect(targets).toContain("esp32c6");
  });
});

describe("public paths and device buffers", () => {
  it("builds the manifest path under the unauthenticated mount", () => {
    expect(manifestPathFor("cockpit", PUBLIC_FW_BASE)).toBe(
      "/signalk-espos-manager/fw/cockpit/manifest.json",
    );
  });

  it("builds a root-relative firmware URL", () => {
    // Root-relative because espos_ota_resolve_url resolves a leading slash
    // against scheme+host, so the device reaches it via whatever address it
    // used for the manifest.
    expect(
      firmwareUrlFor("cockpit", "1.3.0", "p4_cockpit-ota.bin", PUBLIC_FW_BASE),
    ).toBe("/signalk-espos-manager/fw/cockpit/1.3.0/p4_cockpit-ota.bin");
  });

  it("accepts a realistic manifest URL", () => {
    const path = manifestPathFor("ble_gateway", PUBLIC_FW_BASE);
    expect(manifestUrlFits("http://192.168.100.100:3000", path)).toEqual({
      ok: true,
    });
  });

  it("refuses a manifest URL that would be silently truncated", () => {
    const result = manifestUrlFits(
      "http://a-very-long-hostname-for-a-boat-server.example.invalid:30000",
      `/signalk-espos-manager/fw/${"app".repeat(30)}/manifest.json`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/bytes/);
  });

  it("refuses a path longer than the device's own field", () => {
    const result = manifestUrlFits("http://x", `/${"p".repeat(200)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/manifest path is \d+ bytes/);
  });
});

describe("the manifest a real server served", () => {
  // This exact document was produced by generateManifest, served by
  // signalk-server 2.32.0, and then accepted by espOS's own
  // espos_ota_manifest_pick() compiled from firmware source. See
  // test/fixtures/device-parser-verification.md.
  const served = JSON.parse(
    readFileSync(
      new URL("./fixtures/generated-manifest.json", import.meta.url),
      "utf8",
    ),
  ) as {
    schema: number;
    app: string;
    builds: { version: string; target: string; url: string; size: number }[];
  };

  it("carries the shape the device parser requires", () => {
    expect(served.schema).toBe(1);
    // The app must be the CMake project() name; the device strcmps it.
    expect(served.app).toBe("cockpit");
    expect(served.builds).toHaveLength(1);
  });

  it("uses a root-relative URL the device can resolve", () => {
    const url = served.builds[0]?.url ?? "";
    expect(url.startsWith("/signalk-espos-manager/fw/")).toBe(true);
    // espos_ota_resolve_url only reassembles scheme+host for a leading slash;
    // a "../" style relative URL is concatenated literally and breaks.
    expect(url).not.toContain("../");
  });

  it("regenerates byte-identically from the same inputs", () => {
    const first = served.builds[0];
    const { json } = generateManifest(served.app, [
      {
        version: first?.version ?? "",
        target: first?.target ?? "",
        channel: "stable",
        url: first?.url ?? "",
        size: first?.size,
        notes: "Adds the Flow page and the hardware block.",
        date: "2026-09-20T00:00:00Z",
      },
    ]);
    expect(JSON.parse(json)).toEqual(served);
  });
});
