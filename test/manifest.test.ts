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
  planManifests,
  MAX_NOTES_BYTES,
  summariseReleaseNotes,
  truncateBytes,
} from "../src/mirror/manifest.js";
import { PUBLIC_FW_BASE } from "../src/config.js";
import type { ManifestBuildInput } from "../src/mirror/manifest.js";
import type { RegistryProject } from "../src/registry/types.js";

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

  it("gives each board its own manifest file", () => {
    expect(
      manifestPathFor("p4_cockpit", PUBLIC_FW_BASE, "waveshare-p4-touch-x-7"),
    ).toBe(
      "/signalk-espos-manager/fw/p4_cockpit/manifest-waveshare-p4-touch-x-7.json",
    );
  });

  it("fits a real board's manifest URL in the device's buffer", () => {
    const path = manifestPathFor(
      "p4_cockpit",
      PUBLIC_FW_BASE,
      "waveshare-p4-touch-x-7",
    );
    expect(manifestUrlFits("http://192.168.100.100:3000", path)).toEqual({
      ok: true,
    });
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

describe("summariseReleaseNotes", () => {
  // Real GitHub release bodies from dirkwa/espos-p4-cockpit. A raw body is
  // markdown — headings, compare links, bullet lists — and the device stores
  // 127 bytes, so an unprocessed body arrives as a truncated URL.
  const bodies = JSON.parse(
    readFileSync(
      new URL("./fixtures/release-bodies.json", import.meta.url),
      "utf8",
    ),
  ) as { tag: string; body: string }[];

  it("produces a usable one-liner for every real release", () => {
    for (const { tag, body } of bodies) {
      const summary = summariseReleaseNotes(body);
      expect(summary, `${tag} should summarise to something`).not.toBe("");
      expect(summary, `${tag} must not be a bare URL`).not.toMatch(/^https?:/);
      expect(summary, `${tag} must not keep markdown link syntax`).not.toMatch(
        /\]\(/,
      );
      expect(
        summary,
        `${tag} must not start with a heading marker`,
      ).not.toMatch(/^#/);
    }
  });

  it("skips a release-please section label", () => {
    // "## Added" is a section header, not a description of the release.
    expect(
      summariseReleaseNotes("## 1.2.0\n\n### Added\n\n* a real change here"),
    ).toBe("a real change here");
  });

  it("skips a bare version heading", () => {
    expect(summariseReleaseNotes("## v1.2.0 (2026-09-19)\n\nSomething")).toBe(
      "Something",
    );
  });

  it("unwraps a markdown link to its text", () => {
    expect(
      summariseReleaseNotes("* [see the diff](https://x.invalid) matters"),
    ).toBe("see the diff matters");
  });

  it("returns empty for an empty or absent body", () => {
    expect(summariseReleaseNotes(undefined)).toBe("");
    expect(summariseReleaseNotes("")).toBe("");
    expect(summariseReleaseNotes("\n\n##\n")).toBe("");
  });

  it("fits the device's notes budget after truncation", () => {
    for (const { body } of bodies) {
      const { manifest } = generateManifest("cockpit", [
        build({ notes: summariseReleaseNotes(body) }),
      ]);
      const notes = manifest.builds[0]?.notes ?? "";
      expect(Buffer.byteLength(notes, "utf8")).toBeLessThanOrEqual(
        MAX_NOTES_BYTES,
      );
    }
  });
});

describe("planManifests", () => {
  // Shaped like the cockpit entry: two boards on one chip, one image each.
  const cockpit: RegistryProject = {
    id: "cockpit",
    app: "p4_cockpit",
    name: "Cockpit",
    repo: "dirkwa/espos-p4-cockpit",
    targets: ["esp32p4"],
    boards: [
      { id: "7b", target: "esp32p4", name: "7B", reportedAs: "7B" },
      { id: "x7", target: "esp32p4", name: "X7", reportedAs: "X7" },
    ],
    releases: [
      {
        version: "1.5.0",
        tag: "v1.5.0",
        channel: "stable",
        builds: [
          {
            target: "esp32p4",
            boardId: "7b",
            otaUrl: "https://gh.invalid/p4_cockpit-1.5.0-7b-ota.bin",
          },
          {
            target: "esp32p4",
            boardId: "x7",
            otaUrl: "https://gh.invalid/p4_cockpit-1.5.0-x7-ota.bin",
          },
        ],
      },
    ],
  };
  const both = [
    { version: "1.5.0", filename: "p4_cockpit-1.5.0-7b-ota.bin" },
    { version: "1.5.0", filename: "p4_cockpit-1.5.0-x7-ota.bin" },
  ];

  it("never puts one board's image in another board's manifest", () => {
    const plan = planManifests(cockpit, both, PUBLIC_FW_BASE);
    expect(plan.boards.get("7b")?.map((b) => b.url)).toEqual([
      "/signalk-espos-manager/fw/p4_cockpit/1.5.0/p4_cockpit-1.5.0-7b-ota.bin",
    ]);
    expect(plan.boards.get("x7")?.map((b) => b.url)).toEqual([
      "/signalk-espos-manager/fw/p4_cockpit/1.5.0/p4_cockpit-1.5.0-x7-ota.bin",
    ]);
  });

  it("offers a board-specific image to no device that cannot name its board", () => {
    expect(planManifests(cockpit, both, PUBLIC_FW_BASE).app).toEqual([]);
  });

  it("keeps an empty manifest for a declared board with nothing cached", () => {
    const plan = planManifests(cockpit, both.slice(0, 1), PUBLIC_FW_BASE);
    expect(plan.boards.get("x7")).toEqual([]);
  });

  it("withholds a board-agnostic image where the chip has several boards", () => {
    const project: RegistryProject = {
      ...cockpit,
      releases: [
        {
          version: "1.2.0",
          tag: "v1.2.0",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              otaUrl: "https://gh.invalid/p4_cockpit-v1.2.0-ota.bin",
            },
          ],
        },
      ],
    };
    const plan = planManifests(
      project,
      [{ version: "1.2.0", filename: "p4_cockpit-v1.2.0-ota.bin" }],
      PUBLIC_FW_BASE,
    );
    expect(plan.app).toEqual([]);
    expect([...plan.boards.values()].flat()).toEqual([]);
  });

  it("serves a board-agnostic image everywhere on a single-board chip", () => {
    const project: RegistryProject = {
      id: "ble-gateway",
      app: "ble_gateway",
      name: "BLE gateway",
      repo: "dirkwa/espos-ble-gateway",
      targets: ["esp32c6"],
      boards: [{ id: "c6", target: "esp32c6", name: "C6" }],
      releases: [
        {
          version: "0.3.0",
          tag: "v0.3.0",
          channel: "beta",
          notes: "## Fixed\n\n- scanning survives a reconnect",
          publishedAt: "2026-10-01T10:00:00Z",
          builds: [
            {
              target: "esp32c6",
              otaUrl: "https://gh.invalid/ble_gateway-0.3.0-ota.bin",
            },
          ],
        },
      ],
    };
    const plan = planManifests(
      project,
      [
        {
          version: "0.3.0",
          filename: "ble_gateway-0.3.0-ota.bin",
          sizeBytes: 1234,
        },
      ],
      PUBLIC_FW_BASE,
    );
    expect(plan.app).toEqual([
      {
        version: "0.3.0",
        target: "esp32c6",
        channel: "beta",
        url: "/signalk-espos-manager/fw/ble_gateway/0.3.0/ble_gateway-0.3.0-ota.bin",
        size: 1234,
        notes: "scanning survives a reconnect",
        date: "2026-10-01T10:00:00Z",
      },
    ]);
    expect(plan.boards.get("c6")).toEqual(plan.app);
  });

  it("leaves out an image the registry no longer describes", () => {
    const plan = planManifests(
      cockpit,
      [
        { version: "1.4.0", filename: "p4_cockpit-1.4.0-7b-ota.bin" },
        { version: "1.5.0", filename: "unknown.bin" },
        { version: "1.5.0", filename: "p4_cockpit-1.5.0-7b-merged.bin" },
      ],
      PUBLIC_FW_BASE,
    );
    expect(plan.app).toEqual([]);
    expect([...plan.boards.values()].flat()).toEqual([]);
  });
});
