/**
 * Registry resolution and caching tests.
 *
 * Shaped by what the real releases contain, checked on 2026-09-20:
 * dirkwa/espos-p4-cockpit v1.2.0 publishes `p4_cockpit-v1.2.0-merged.bin` and
 * `p4_cockpit-v1.2.0-ota.bin` — no target segment — while
 * dirkwa/espos-ble-gateway v0.2.0 publishes nothing at all.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseIndex, RegistryClient } from "../src/registry/client.js";
import {
  boardIdFromReport,
  matchDevice,
  mergeIndexes,
  projectForApp,
  targetFromAssetName,
} from "../src/registry/resolve.js";
import type { RegistryIndex, RegistryProject } from "../src/registry/types.js";

let cacheDir: string;
let server: Server | undefined;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "espos-reg-"));
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
  }
  await rm(cacheDir, { recursive: true, force: true });
});

const cockpit: RegistryProject = {
  id: "cockpit",
  // The CMake project() name, which is what the device reports and matches.
  app: "cockpit",
  name: "P4 Cockpit",
  repo: "dirkwa/espos-p4-cockpit",
  targets: ["esp32p4"],
  signingKeyId: "0badc0ffee123456",
  official: true,
  releases: [
    {
      version: "1.2.0",
      tag: "v1.2.0",
      channel: "stable",
      publishedAt: "2026-09-19T00:00:00Z",
      notes: "Theme support",
      builds: [
        {
          target: "esp32p4",
          otaUrl: "https://example.invalid/p4_cockpit-v1.2.0-ota.bin",
          otaBytes: 4460544,
          mergedUrl: "https://example.invalid/p4_cockpit-v1.2.0-merged.bin",
          mergedBytes: 15036742,
        },
      ],
    },
    {
      version: "1.3.0-beta.1",
      tag: "v1.3.0-beta.1",
      channel: "beta",
      builds: [
        {
          target: "esp32p4",
          otaUrl: "https://example.invalid/p4_cockpit-v1.3.0-beta.1-ota.bin",
        },
      ],
    },
  ],
};

/** The gateway as it really is today: a release with no assets. */
const gateway: RegistryProject = {
  id: "ble-gateway",
  app: "ble_gateway",
  name: "BLE Gateway",
  repo: "dirkwa/espos-ble-gateway",
  targets: ["esp32p4", "esp32", "esp32s3", "esp32c3", "esp32c6"],
  releases: [],
};

const index: RegistryIndex = { schema: 1, projects: [cockpit, gateway] };

describe("targetFromAssetName", () => {
  it("finds a target when the name carries one", () => {
    expect(targetFromAssetName("ble-gateway-esp32c6-v0.3.0-ota.bin")).toBe(
      "esp32c6",
    );
    expect(targetFromAssetName("x-esp32s3-ota.bin")).toBe("esp32s3");
  });

  it("does not let esp32 swallow a longer target", () => {
    expect(targetFromAssetName("fw-esp32p4-ota.bin")).toBe("esp32p4");
    expect(targetFromAssetName("fw-esp32c61-ota.bin")).toBe("esp32c61");
  });

  it("returns undefined rather than guessing from the real cockpit name", () => {
    // "p4_cockpit-v1.2.0-ota.bin" has no target segment, and the "p4" in the
    // project name is not one. Guessing here would offer a P4 image to a C6.
    expect(targetFromAssetName("p4_cockpit-v1.2.0-ota.bin")).toBeUndefined();
  });
});

describe("projectForApp", () => {
  it("matches on the runtime app name, not the repo name", () => {
    expect(projectForApp(index, "cockpit")?.id).toBe("cockpit");
    expect(projectForApp(index, "ble_gateway")?.id).toBe("ble-gateway");
    // The repo is espos-p4-cockpit and app_name is p4-cockpit; neither is it.
    expect(projectForApp(index, "p4-cockpit")).toBeUndefined();
  });
});

describe("matchDevice", () => {
  const base = {
    app: "cockpit",
    target: "esp32p4",
    channel: "stable" as const,
  };

  it("offers a newer stable release", () => {
    const result = matchDevice(cockpit, {
      ...base,
      runningVersion: "1.1.0",
    });
    expect(result.build?.version).toBe("1.2.0");
    expect(result.build?.otaUrl).toContain("p4_cockpit-v1.2.0-ota.bin");
    expect(result.requiresUsb).toBe(false);
  });

  it("says a current device is up to date", () => {
    const result = matchDevice(cockpit, { ...base, runningVersion: "1.2.0" });
    expect(result.build).toBeUndefined();
    expect(result.reason).toMatch(/up to date/);
  });

  it("flags a git-describe version as needing confirmation", () => {
    // 1.1.0-12-g44590ce-dirty compares BELOW 1.1.0, so an "update" to 1.2.0
    // is legitimate but the device is running something unreleased.
    const result = matchDevice(cockpit, {
      ...base,
      runningVersion: "1.1.0-12-g44590ce-dirty",
    });
    expect(result.build?.version).toBe("1.2.0");
    expect(result.needsConfirmation).toBe(true);
  });

  it("does not need confirmation from a released version", () => {
    expect(
      matchDevice(cockpit, { ...base, runningVersion: "1.1.0" })
        .needsConfirmation,
    ).toBe(false);
  });

  it("withholds a beta unless prereleases are enabled", () => {
    const without = matchDevice(cockpit, { ...base, runningVersion: "1.2.0" });
    expect(without.build).toBeUndefined();

    const with_ = matchDevice(cockpit, {
      ...base,
      runningVersion: "1.2.0",
      includePrerelease: true,
    });
    expect(with_.build?.version).toBe("1.3.0-beta.1");
  });

  it("offers nothing when the device has not reported its chip", () => {
    // Review finding: an undefined target matched every build, so a device
    // that had not reported its chip was handed whichever build was listed
    // first — a C6 image to a P4. The guess this module exists to refuse.
    const multi: RegistryProject = {
      ...cockpit,
      targets: ["esp32c6", "esp32p4"],
      releases: [
        {
          version: "2.0.0",
          tag: "v2.0.0",
          channel: "stable",
          builds: [
            { target: "esp32c6", otaUrl: "https://example.invalid/c6.bin" },
            { target: "esp32p4", otaUrl: "https://example.invalid/p4.bin" },
          ],
        },
      ],
    };
    const result = matchDevice(multi, {
      app: "cockpit",
      target: undefined,
      channel: "stable",
      runningVersion: "1.0.0",
    });
    expect(result.build).toBeUndefined();
    expect(result.reason).toMatch(/has not reported which chip/);
  });

  it("declines a target the project does not build", () => {
    const result = matchDevice(cockpit, {
      ...base,
      target: "esp32c6",
      runningVersion: "1.0.0",
    });
    expect(result.build).toBeUndefined();
    expect(result.reason).toMatch(/no stable build for esp32c6/);
  });

  it("says so plainly when a project has published nothing", () => {
    // The live state of the BLE gateway: this is normal, not an error.
    const result = matchDevice(gateway, {
      app: "ble_gateway",
      target: "esp32p4",
      channel: "stable",
      runningVersion: "0.2.0",
    });
    expect(result.build).toBeUndefined();
    expect(result.reason).toMatch(/has not published any firmware yet/);
  });

  it("requires USB when the device trusts a different signing key", () => {
    // A device only accepts an image signed with the key it was flashed with,
    // so offering this as an OTA would waste a 4 MB download and fail.
    const result = matchDevice(cockpit, {
      ...base,
      runningVersion: "1.1.0",
      keyFp: "different-key-fp",
    });
    expect(result.build?.version).toBe("1.2.0");
    expect(result.requiresUsb).toBe(true);
    expect(result.reason).toMatch(/different signing key/);
  });

  it("does not claim a key mismatch when the device reports no fingerprint", () => {
    // Pre-0.10.0 firmware reports no key_fp. Unknown must read as unknown,
    // not as safe and not as broken.
    const result = matchDevice(cockpit, { ...base, runningVersion: "1.1.0" });
    expect(result.requiresUsb).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("marks an unsigned build as USB-only", () => {
    const unsigned: RegistryProject = {
      ...cockpit,
      releases: [
        {
          version: "9.9.9",
          tag: "v9.9.9",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              otaUrl: "https://example.invalid/unsigned-ota.bin",
              unsigned: true,
            },
          ],
        },
      ],
    };
    const result = matchDevice(unsigned, { ...base, runningVersion: "1.0.0" });
    expect(result.requiresUsb).toBe(true);
    expect(result.reason).toMatch(/unsigned/);
  });

  it("reports a release that ships no OTA image", () => {
    const mergedOnly: RegistryProject = {
      ...cockpit,
      releases: [
        {
          version: "2.0.0",
          tag: "v2.0.0",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              mergedUrl: "https://example.invalid/merged.bin",
            },
          ],
        },
      ],
    };
    const result = matchDevice(mergedOnly, {
      ...base,
      runningVersion: "1.0.0",
    });
    expect(result.build).toBeUndefined();
    expect(result.requiresUsb).toBe(true);
    expect(result.reason).toMatch(/no over-the-air image/);
  });

  it("refuses a deprecated project with its stated reason", () => {
    const result = matchDevice(
      { ...cockpit, deprecated: "superseded by cockpit-ng" },
      { ...base, runningVersion: "1.0.0" },
    );
    expect(result.build).toBeUndefined();
    expect(result.reason).toBe("superseded by cockpit-ng");
  });

  it("prefers a build naming the device's board over a generic one", () => {
    const boards: RegistryProject = {
      ...cockpit,
      boards: [
        {
          id: "waveshare-7b",
          target: "esp32p4",
          name: "7B",
          reportedAs: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B",
        },
      ],
      releases: [
        {
          version: "1.4.0",
          tag: "v1.4.0",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              otaUrl: "https://example.invalid/generic.bin",
            },
            {
              target: "esp32p4",
              boardId: "waveshare-7b",
              otaUrl: "https://example.invalid/7b.bin",
            },
          ],
        },
      ],
    };
    const result = matchDevice(boards, {
      ...base,
      board: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B",
      runningVersion: "1.0.0",
    });
    expect(result.build?.otaUrl).toContain("7b.bin");
  });

  it("refuses a board-agnostic build when boards share a chip", () => {
    // Found by flashing a Waveshare Touch-LCD-X with the stock 7B release:
    // black screen. The two panels use different controllers, geometries and
    // backlight pins, and espOS matches an update on app+target+channel only
    // — never on board — so the device accepts the wrong image happily. One
    // unnamed binary plus several boards on a chip means we cannot know which
    // it fits, and guessing costs a working panel.
    const twoBoards: RegistryProject = {
      ...cockpit,
      boards: [
        { id: "waveshare-p4-touch-7b", target: "esp32p4", name: "7B" },
        { id: "waveshare-p4-touch-x", target: "esp32p4", name: "X" },
      ],
      releases: [
        {
          version: "1.2.0",
          tag: "v1.2.0",
          channel: "stable",
          builds: [
            { target: "esp32p4", otaUrl: "https://example.invalid/ota.bin" },
          ],
        },
      ],
    };
    const result = matchDevice(twoBoards, { ...base, runningVersion: "1.1.0" });
    expect(result.build).toBeUndefined();
    expect(result.requiresUsb).toBe(true);
    expect(result.reason).toMatch(/2 different boards/);
    expect(result.reason).toMatch(/screen black/);
  });

  it("still offers a board-agnostic build when only one board uses the chip", () => {
    // The ordinary case, and it must keep working: most projects support one
    // board per chip and publish one binary for it.
    const oneBoard: RegistryProject = {
      ...cockpit,
      boards: [{ id: "only", target: "esp32p4", name: "The only board" }],
      releases: [
        {
          version: "1.2.0",
          tag: "v1.2.0",
          channel: "stable",
          builds: [
            { target: "esp32p4", otaUrl: "https://example.invalid/ota.bin" },
          ],
        },
      ],
    };
    expect(
      matchDevice(oneBoard, { ...base, runningVersion: "1.1.0" }).build
        ?.version,
    ).toBe("1.2.0");
  });

  it("offers a named build to the board it names, and not to the other", () => {
    // options.board is what the DEVICE reports; the registry joins it to a
    // board id through reportedAs. Passing an id here would not resolve --
    // that is the point of the mapping.
    const named: RegistryProject = {
      ...cockpit,
      boards: [
        {
          id: "waveshare-p4-touch-7b",
          target: "esp32p4",
          name: "7B",
          reportedAs: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B",
        },
        {
          id: "waveshare-p4-touch-x",
          target: "esp32p4",
          name: "X",
          reportedAs: "Waveshare ESP32-P4-WIFI6-Touch-LCD-X 7in",
        },
      ],
      releases: [
        {
          version: "1.3.0",
          tag: "v1.3.0",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              boardId: "waveshare-p4-touch-x",
              otaUrl: "https://example.invalid/x.bin",
            },
          ],
        },
      ],
    };
    expect(
      matchDevice(named, {
        ...base,
        board: "Waveshare ESP32-P4-WIFI6-Touch-LCD-X 7in",
        runningVersion: "1.1.0",
      }).build?.version,
    ).toBe("1.3.0");
    expect(
      matchDevice(named, {
        ...base,
        board: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B",
        runningVersion: "1.1.0",
      }).build,
    ).toBeUndefined();
  });

  it("declines when only other boards have builds", () => {
    // Two incompatible panels behind one target: the wrong image is a black
    // screen, so no build is better than a guess.
    const boards: RegistryProject = {
      ...cockpit,
      releases: [
        {
          version: "1.4.0",
          tag: "v1.4.0",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              boardId: "waveshare-x",
              otaUrl: "https://example.invalid/x.bin",
            },
          ],
        },
      ],
    };
    const result = matchDevice(boards, {
      ...base,
      board: "waveshare-7b",
      runningVersion: "1.0.0",
    });
    expect(result.build).toBeUndefined();
  });
});

describe("mergeIndexes", () => {
  it("keeps the first entry for a duplicated id", () => {
    const merged = mergeIndexes([
      { url: "a", index: { schema: 1, projects: [cockpit] } },
      {
        url: "b",
        index: {
          schema: 1,
          projects: [{ ...cockpit, name: "Impostor" }],
        },
      },
    ]);
    expect(merged.index.projects).toHaveLength(1);
    expect(merged.index.projects[0]?.name).toBe("P4 Cockpit");
    expect(merged.warnings[0]).toMatch(/ignored a second entry/);
  });

  it("refuses a second project claiming the same app name", () => {
    // A manifest serves exactly one app, so two projects claiming one app
    // would fight over the same file.
    const merged = mergeIndexes([
      { url: "a", index: { schema: 1, projects: [cockpit] } },
      {
        url: "b",
        index: {
          schema: 1,
          projects: [{ ...cockpit, id: "cockpit-fork" }],
        },
      },
    ]);
    expect(merged.index.projects).toHaveLength(1);
    expect(
      merged.warnings.some((w) => /claim the application name/.test(w)),
    ).toBe(true);
  });
});

describe("parseIndex", () => {
  it("skips an entry missing the fields needed to use it", () => {
    const parsed = parseIndex({
      projects: [
        cockpit,
        { name: "no id or app" },
        { id: "x", app: "x" }, // no targets
      ],
    });
    // One bad third-party entry must not empty the store.
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]?.id).toBe("cockpit");
  });

  it("rejects something that is not an index at all", () => {
    expect(() => parseIndex(null)).toThrow(/not an object/);
    expect(() => parseIndex({ nope: true })).toThrow(/no projects array/);
  });
});

describe("RegistryClient", () => {
  async function serveIndex(
    body: unknown,
    options: { etag?: string; status?: number } = {},
  ): Promise<string> {
    let served = 0;
    server = createServer((req, res) => {
      served += 1;
      if (
        options.etag !== undefined &&
        req.headers["if-none-match"] === options.etag
      ) {
        res.writeHead(304).end();
        return;
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (options.etag !== undefined) headers.ETag = options.etag;
      res.writeHead(options.status ?? 200, headers);
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => {
      server?.listen(0, "127.0.0.1", r);
    });
    const { port } = server.address() as AddressInfo;
    void served;
    return `http://127.0.0.1:${port}/index.json`;
  }

  it("fetches and caches the index", async () => {
    const url = await serveIndex(index);
    const client = new RegistryClient({ cacheDir, indexUrl: url });
    const result = await client.getIndex();
    expect(result.stale).toBe(false);
    expect(result.index.projects).toHaveLength(2);
  });

  it("serves the cache when the registry is unreachable", async () => {
    // The whole point: a store that still works at anchor.
    const url = await serveIndex(index);
    const client = new RegistryClient({ cacheDir, indexUrl: url });
    await client.getIndex();

    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;

    const offline = await client.getIndex({ force: true });
    expect(offline.index.projects).toHaveLength(2);
    expect(offline.stale).toBe(true);
    expect(offline.reason).toBeDefined();
  });

  it("reports an empty index rather than throwing with no cache", async () => {
    const client = new RegistryClient({
      cacheDir,
      indexUrl: "http://127.0.0.1:1/index.json",
      timeoutMs: 1000,
    });
    const result = await client.getIndex();
    expect(result.index.projects).toEqual([]);
    expect(result.stale).toBe(true);
  });

  it("honours an ETag with a conditional request", async () => {
    const url = await serveIndex(index, { etag: '"v1"' });
    const client = new RegistryClient({ cacheDir, indexUrl: url });
    await client.getIndex();
    const second = await client.getIndex({ force: true });
    expect(second.stale).toBe(false);
    expect(second.index.projects).toHaveLength(2);
  });

  it("uses the cache without a request while it is fresh", async () => {
    const url = await serveIndex(index);
    const client = new RegistryClient({ cacheDir, indexUrl: url });
    await client.getIndex();
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    // Not forced and within maxAge: no request, so no failure.
    const cached = await client.getIndex({ maxAgeMs: 60_000 });
    expect(cached.stale).toBe(false);
    expect(cached.index.projects).toHaveLength(2);
  });

  it("keeps separate caches for different index URLs", async () => {
    // Review finding: a 32-bit rolling hash could collide, and two colliding
    // index URLs would each serve the other's projects — a wrong answer, not a
    // slow one.
    const urlA = await serveIndex({
      schema: 1,
      projects: [{ ...cockpit, id: "from-a", app: "app_a" }],
    });
    const clientA = new RegistryClient({ cacheDir, indexUrl: urlA });
    const a = await clientA.getIndex();
    expect(a.index.projects[0]?.id).toBe("from-a");

    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;

    const urlB = await serveIndex({
      schema: 1,
      projects: [{ ...cockpit, id: "from-b", app: "app_b" }],
    });
    const clientB = new RegistryClient({ cacheDir, indexUrl: urlB });
    const b = await clientB.getIndex();
    expect(b.index.projects[0]?.id).toBe("from-b");

    // A's cache is untouched by B: still readable offline, still A's data.
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    const aAgain = await clientA.getIndex({ force: true });
    expect(aAgain.index.projects[0]?.id).toBe("from-a");
  });

  it("does not throw on a corrupt but still-fresh cache", async () => {
    // A cache file can be valid JSON at the envelope level and still not be an
    // index — a truncated write, or a schema that moved on. Unguarded this
    // threw out of getIndex() into the route handler and the poll loop, and
    // nothing short of deleting the file by hand recovered it.
    const { writeFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const url = "http://127.0.0.1:1/index.json";
    const digest = createHash("sha256")
      .update(url, "utf8")
      .digest("hex")
      .slice(0, 32);
    await writeFile(
      join(cacheDir, `registry-${digest}.json`),
      JSON.stringify({ url, fetchedAt: Date.now(), body: '{"nope":true}' }),
    );
    const client = new RegistryClient({
      cacheDir,
      indexUrl: url,
      timeoutMs: 800,
    });
    const result = await client.getIndex({ maxAgeMs: 60_000 });
    expect(result.index.projects).toEqual([]);
    expect(result.stale).toBe(true);
  });

  it("treats a server error as a fallback, not a crash", async () => {
    const url = await serveIndex({}, { status: 500 });
    const client = new RegistryClient({ cacheDir, indexUrl: url });
    const result = await client.getIndex();
    expect(result.stale).toBe(true);
    expect(result.index.projects).toEqual([]);
  });
});

describe("boardIdFromReport", () => {
  const boards = [
    {
      id: "waveshare-p4-touch-7b",
      target: "esp32p4" as const,
      name: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B (1024x600)",
      reportedAs: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B",
    },
    {
      id: "waveshare-p4-touch-x-7",
      target: "esp32p4" as const,
      name: "Waveshare ESP32-P4-WIFI6-Touch-LCD-X, 7 inch (720x1280, rotated)",
      reportedAs: "Waveshare ESP32-P4-WIFI6-Touch-LCD-X 7in",
    },
  ];

  it("resolves the exact string a panel reports", () => {
    // Verbatim from a live Touch-LCD-X running cockpit 1.3.0:
    // /api/v1/system/info -> hardware.board
    expect(
      boardIdFromReport(boards, "Waveshare ESP32-P4-WIFI6-Touch-LCD-X 7in"),
    ).toBe("waveshare-p4-touch-x-7");
    expect(
      boardIdFromReport(boards, "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B"),
    ).toBe("waveshare-p4-touch-7b");
  });

  it("does not match the display name, only reportedAs", () => {
    // The names are similar enough that a fuzzy match would look correct and
    // then hand a 10.1-inch panel a 7-inch image.
    expect(
      boardIdFromReport(
        boards,
        "Waveshare ESP32-P4-WIFI6-Touch-LCD-X, 7 inch (720x1280, rotated)",
      ),
    ).toBeUndefined();
  });

  it("trims whitespace but does not fold case", () => {
    expect(
      boardIdFromReport(boards, "  Waveshare ESP32-P4-WIFI6-Touch-LCD-7B  "),
    ).toBe("waveshare-p4-touch-7b");
    expect(
      boardIdFromReport(boards, "waveshare esp32-p4-wifi6-touch-lcd-7b"),
    ).toBeUndefined();
  });

  it("refuses a near miss rather than picking the closest", () => {
    // The 8-inch X panel is a different controller (JD9365) and unsupported.
    expect(
      boardIdFromReport(boards, "Waveshare ESP32-P4-WIFI6-Touch-LCD-X 8in"),
    ).toBeUndefined();
    expect(boardIdFromReport(boards, "")).toBeUndefined();
    expect(boardIdFromReport(boards, undefined)).toBeUndefined();
    expect(boardIdFromReport(undefined, "anything")).toBeUndefined();
  });

  it("refuses when two boards claim one reported string", () => {
    // A registry bug; resolving it either way guesses at the hardware.
    const clashing = [
      { ...boards[0]!, id: "a" },
      { ...boards[0]!, id: "b" },
    ];
    expect(
      boardIdFromReport(clashing, "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B"),
    ).toBeUndefined();
  });

  it("boards without reportedAs never match", () => {
    const undeclared = [
      { id: "x", target: "esp32p4" as const, name: "Some Panel" },
    ];
    expect(boardIdFromReport(undeclared, "Some Panel")).toBeUndefined();
  });
});
