/**
 * Tests for the board-first view of the registry.
 *
 * The fixtures are the shapes the live registry actually has, not invented
 * ones: the cockpit with two board variants on its newest releases and a
 * board-agnostic older one, and the gateway with five declared boards and no
 * releases at all. Both were read from
 * raw.githubusercontent.com/signalk-espOS/registry/main/index.json on
 * 2026-09-22, and both are cases the page renders today.
 */

import { describe, expect, it } from "vitest";
import {
  boardCatalogue,
  targetsInCatalogue,
  type CatalogueProject,
  esposLag,
} from "../web/src/flash/catalogue.js";

/** The cockpit: two P4 panels, per-board builds, plus an older agnostic one. */
const cockpit: CatalogueProject = {
  id: "cockpit",
  name: "P4 Cockpit",
  summary: "Touch instrument panel",
  repo: "dirkwa/espos-p4-cockpit",
  official: true,
  boards: [
    {
      id: "waveshare-p4-touch-7b",
      target: "esp32p4",
      name: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B (1024x600)",
    },
    {
      id: "waveshare-p4-touch-x-7",
      target: "esp32p4",
      name: "Waveshare ESP32-P4-WIFI6-Touch-LCD-X, 7 inch",
    },
  ],
  releases: [
    {
      version: "1.3.1",
      channel: "stable",
      notesUrl: "https://example.invalid/notes",
      builds: [
        {
          target: "esp32p4",
          boardId: "waveshare-p4-touch-7b",
          mergedUrl: "https://example.invalid/7b-merged.bin",
          mergedBytes: 15_000_000,
          otaUrl: "https://example.invalid/7b-ota.bin",
        },
        {
          target: "esp32p4",
          boardId: "waveshare-p4-touch-x-7",
          mergedUrl: "https://example.invalid/x7-merged.bin",
          mergedBytes: 15_100_000,
          otaUrl: "https://example.invalid/x7-ota.bin",
        },
      ],
    },
  ],
};

/** The gateway as it really is today: boards declared, nothing published. */
const gateway: CatalogueProject = {
  id: "ble-gateway",
  name: "BLE Gateway",
  summary: "Bridges BLE sensors to Signal K",
  repo: "dirkwa/espos-ble-gateway",
  official: true,
  boards: [
    { id: "esp32c6-devkit", target: "esp32c6", name: "ESP32-C6 devkit" },
    { id: "esp32c3-devkit", target: "esp32c3", name: "ESP32-C3 devkit" },
  ],
  releases: [],
};

describe("boardCatalogue", () => {
  it("offers each panel its own build rather than one row per release", () => {
    const entries = boardCatalogue([cockpit]);

    expect(entries.map((e) => e.id)).toEqual([
      "waveshare-p4-touch-7b",
      "waveshare-p4-touch-x-7",
    ]);
    for (const entry of entries) {
      const offer = entry.offers[0];
      expect(offer?.state).toBe("flashable");
      expect(offer?.build?.boardId).toBe(entry.id);
    }
    // The whole point: the two boards get DIFFERENT images. Handing both the
    // same URL is the black-screen bug this view exists to prevent.
    expect(entries[0]?.offers[0]?.build?.mergedUrl).not.toBe(
      entries[1]?.offers[0]?.build?.mergedUrl,
    );
  });

  it("withholds a board-agnostic image where several boards share the chip", () => {
    const agnostic: CatalogueProject = {
      ...cockpit,
      releases: [
        {
          version: "1.2.0",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              mergedUrl: "https://example.invalid/merged.bin",
              mergedBytes: 15_000_000,
            },
          ],
        },
      ],
    };

    const entries = boardCatalogue([agnostic]);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.offers[0]?.state).toBe("ambiguous");
      expect(entry.offers[0]?.build).toBeUndefined();
      expect(entry.offers[0]?.reason).toContain("black");
    }
    expect(entries.every((e) => !e.anyFlashable)).toBe(true);
  });

  it("does flash a board-agnostic image when the chip has only one board", () => {
    const single: CatalogueProject = {
      id: "solo",
      name: "Solo",
      repo: "example/solo",
      boards: [{ id: "c6-devkit", target: "esp32c6", name: "C6 devkit" }],
      releases: [
        {
          version: "1.0.0",
          channel: "stable",
          builds: [
            {
              target: "esp32c6",
              mergedUrl: "https://example.invalid/solo.bin",
              mergedBytes: 1_000_000,
            },
          ],
        },
      ],
    };

    const offer = boardCatalogue([single])[0]?.offers[0];
    expect(offer?.state).toBe("flashable");
    expect(offer?.build?.boardId).toBeUndefined();
  });

  it("says an OTA-only build cannot start a blank board", () => {
    const otaOnly: CatalogueProject = {
      ...cockpit,
      releases: [
        {
          version: "1.3.1",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              boardId: "waveshare-p4-touch-7b",
              otaUrl: "https://example.invalid/ota.bin",
            },
            {
              target: "esp32p4",
              boardId: "waveshare-p4-touch-x-7",
              otaUrl: "https://example.invalid/ota-x.bin",
            },
          ],
        },
      ],
    };

    const offer = boardCatalogue([otaOnly])[0]?.offers[0];
    expect(offer?.state).toBe("ota-only");
    expect(offer?.build).toBeUndefined();
  });

  it("lists a supported board with no firmware instead of hiding it", () => {
    // This is the gateway's real state, and the reason `none` is a state: a
    // board that is simply absent reads as a board nobody supports.
    const entries = boardCatalogue([gateway]);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.offers[0]?.state).toBe("none");
      expect(entry.offers[0]?.reason).toContain("has not published");
    }
  });

  it("merges one physical board that two projects support", () => {
    const other: CatalogueProject = {
      id: "other",
      name: "Other",
      repo: "example/other",
      boards: [{ id: "esp32c6-devkit", target: "esp32c6", name: "C6 devkit" }],
      releases: [
        {
          version: "2.0.0",
          channel: "stable",
          builds: [
            {
              target: "esp32c6",
              mergedUrl: "https://example.invalid/other.bin",
              mergedBytes: 900_000,
            },
          ],
        },
      ],
    };

    const entries = boardCatalogue([gateway, other]);
    const c6 = entries.find((e) => e.id === "esp32c6-devkit");
    expect(c6?.offers).toHaveLength(2);
    expect(c6?.anyFlashable).toBe(true);
    // Flashable first, so the thing you can actually do is not below an
    // explanation of something you cannot.
    expect(c6?.offers[0]?.state).toBe("flashable");
    expect(c6?.offers[0]?.projectId).toBe("other");
  });

  it("keeps an older release that still supports a board", () => {
    // A project adding a board must not appear to drop the one it had: the
    // newest release says nothing about this chip, so the walk continues.
    const grew: CatalogueProject = {
      id: "grew",
      name: "Grew",
      repo: "example/grew",
      boards: [
        { id: "c6", target: "esp32c6", name: "C6" },
        { id: "p4", target: "esp32p4", name: "P4" },
      ],
      releases: [
        {
          version: "2.0.0",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              boardId: "p4",
              mergedUrl: "https://example.invalid/p4.bin",
            },
          ],
        },
        {
          version: "1.0.0",
          channel: "stable",
          builds: [
            {
              target: "esp32c6",
              boardId: "c6",
              mergedUrl: "https://example.invalid/c6.bin",
            },
          ],
        },
      ],
    };

    const c6 = boardCatalogue([grew]).find((e) => e.id === "c6");
    expect(c6?.offers[0]?.state).toBe("flashable");
    expect(c6?.offers[0]?.build?.version).toBe("1.0.0");
  });

  it("sorts boards that can be flashed above boards that cannot", () => {
    const entries = boardCatalogue([gateway, cockpit]);
    const flags = entries.map((e) => e.anyFlashable);
    // Every true precedes every false.
    expect(flags.indexOf(false)).toBeGreaterThan(flags.lastIndexOf(true));
  });

  it("carries the board name onto the build, for the confirmation step", () => {
    const build = boardCatalogue([cockpit])[0]?.offers[0]?.build;
    expect(build?.boardName).toContain("7B");
  });

  it("survives a project that declares no boards at all", () => {
    const boardless: CatalogueProject = {
      id: "b",
      name: "Boardless",
      repo: "example/b",
      releases: [
        {
          version: "1.0.0",
          channel: "stable",
          builds: [
            { target: "esp32", mergedUrl: "https://example.invalid/x.bin" },
          ],
        },
      ],
    };
    // Nothing to key on, so nothing is offered — and no crash. A project that
    // lists no boards cannot be placed in a board-first view; the firmware
    // list still shows it.
    expect(boardCatalogue([boardless])).toEqual([]);
  });

  it("returns an empty catalogue for an empty registry", () => {
    expect(boardCatalogue([])).toEqual([]);
  });
});

describe("targetsInCatalogue", () => {
  it("lists each chip once, sorted", () => {
    const entries = boardCatalogue([gateway, cockpit]);
    expect(targetsInCatalogue(entries)).toEqual([
      "esp32c3",
      "esp32c6",
      "esp32p4",
    ]);
  });
});

/**
 * A browser-readable URL is separate from the release URL.
 *
 * GitHub serves release downloads with no Access-Control-Allow-Origin, on the
 * redirect and on its target, so `mergedUrl` cannot be fetched from a web page
 * at all — measured 2026-09-23 against a real release asset. A project that
 * mirrors its images to a branch also publishes `mergedWebUrl`, served by
 * raw.githubusercontent, which does send the header.
 */
describe("browser-readable urls", () => {
  const withMirror: CatalogueProject = {
    id: "m",
    name: "Mirrored",
    repo: "example/m",
    boards: [{ id: "c6", target: "esp32c6", name: "C6" }],
    releases: [
      {
        version: "1.0.0",
        channel: "stable",
        builds: [
          {
            target: "esp32c6",
            boardId: "c6",
            mergedUrl: "https://github.com/example/m/releases/download/x.bin",
            mergedWebUrl:
              "https://raw.githubusercontent.com/example/m/release-assets/v1.0.0/x.bin",
            mergedBytes: 1_000_000,
          },
        ],
      },
    ],
  };

  it("carries both urls onto the build", () => {
    const build = boardCatalogue([withMirror])[0]?.offers[0]?.build;
    expect(build?.mergedUrl).toContain("releases/download");
    expect(build?.mergedWebUrl).toContain("raw.githubusercontent.com");
  });

  it("leaves the web url undefined when a project publishes none", () => {
    const without: CatalogueProject = {
      ...withMirror,
      releases: [
        {
          ...withMirror.releases![0]!,
          builds: [
            {
              ...withMirror.releases![0]!.builds[0]!,
              mergedWebUrl: undefined,
            },
          ],
        },
      ],
    };
    const build = boardCatalogue([without])[0]?.offers[0]?.build;
    // Still flashable-by-registry: the plugin can install it server-side. Only
    // the browser cannot, and the page says so rather than guessing a URL that
    // would always fail.
    expect(build?.mergedUrl).toBeDefined();
    expect(build?.mergedWebUrl).toBeUndefined();
  });
});

/**
 * More than one version per board.
 *
 * "The latest" is not the only thing someone needs. A release can regress and
 * rolling back is the first thing an owner reaches for, and a project with a
 * prerelease channel is worth offering to whoever wants to test one. The
 * registry already carries every release; the chooser used to keep the newest
 * and throw the rest away.
 */
describe("version choices", () => {
  const withVersions = (
    versions: { v: string; channel?: string }[],
  ): CatalogueProject => ({
    id: "many",
    name: "Many",
    repo: "example/many",
    boards: [{ id: "c6", target: "esp32c6", name: "C6" }],
    releases: versions.map(({ v, channel }) => ({
      version: v,
      channel: channel ?? "stable",
      builds: [
        {
          target: "esp32c6",
          boardId: "c6",
          mergedUrl: `https://example.invalid/${v}.bin`,
          mergedBytes: 1_000_000,
        },
      ],
    })),
  });

  it("offers the newest three stable versions, newest first", () => {
    const offer = boardCatalogue([
      withVersions([
        { v: "1.4.0" },
        { v: "1.3.0" },
        { v: "1.2.0" },
        { v: "1.1.0" },
        { v: "1.0.0" },
      ]),
    ])[0]?.offers[0];

    expect(offer?.builds.map((b) => b.version)).toEqual([
      "1.4.0",
      "1.3.0",
      "1.2.0",
    ]);
    // Three is enough to get past a bad release; the releases are the archive.
    expect(offer?.builds).toHaveLength(3);
  });

  it("installs the newest STABLE by default, never a beta", () => {
    const offer = boardCatalogue([
      withVersions([
        { v: "2.0.0-beta.1", channel: "beta" },
        { v: "1.4.0" },
        { v: "1.3.0" },
      ]),
    ])[0]?.offers[0];

    // The beta is offered...
    expect(offer?.builds.map((b) => b.version)).toContain("2.0.0-beta.1");
    // ...listed first, because someone looking for one should not have to hunt.
    expect(offer?.builds[0]?.version).toBe("2.0.0-beta.1");
    // ...but a click installs the stable release. Nobody gets handed a
    // prerelease by accident; this mirrors npm, where `latest` stays stable.
    expect(offer?.build?.version).toBe("1.4.0");
    expect(offer?.build?.channel).not.toBe("beta");
  });

  it("drops a beta that a stable release has already overtaken", () => {
    const offer = boardCatalogue([
      withVersions([
        { v: "1.5.0" },
        { v: "1.5.0-beta.1", channel: "beta" },
        { v: "1.4.0" },
      ]),
    ])[0]?.offers[0];

    // Once stable catches up, the prerelease it came from is history, not a
    // choice. Offering it would invite installing something strictly older.
    expect(offer?.builds.map((b) => b.version)).not.toContain("1.5.0-beta.1");
    expect(offer?.build?.version).toBe("1.5.0");
  });

  it("falls back to a beta when a project has published no stable at all", () => {
    const offer = boardCatalogue([
      withVersions([{ v: "0.1.0-beta.2", channel: "beta" }]),
    ])[0]?.offers[0];

    expect(offer?.state).toBe("flashable");
    expect(offer?.build?.version).toBe("0.1.0-beta.2");
  });

  it("orders versions the way the device does, not lexically", () => {
    const offer = boardCatalogue([
      // Deliberately NOT in order: if the chooser merely preserved input order
      // this test would pass for the wrong reason.
      withVersions([{ v: "1.9.0" }, { v: "1.2.0" }, { v: "1.10.0" }]),
    ])[0]?.offers[0];

    // Lexically "1.10.0" < "1.9.0"; the device compares the numeric core, and
    // a flasher that disagreed with it would offer the wrong "newest".
    expect(offer?.build?.version).toBe("1.10.0");
    expect(offer?.builds[0]?.version).toBe("1.10.0");
  });

  it("keeps builds empty when nothing is installable", () => {
    const entries = boardCatalogue([gateway]);
    for (const e of entries) {
      expect(e.offers[0]?.state).toBe("none");
      expect(e.offers[0]?.builds).toEqual([]);
    }
  });

  it("says when a newer release exists but cannot be installed here", () => {
    // An older release being installable must not hide the newest one being
    // unidentifiable: without a word on screen the page looks stale to anyone
    // who knows a newer version shipped. An earlier version of this test
    // asserted the reason was dropped, which codified the gap instead of
    // questioning it.
    const mixed: CatalogueProject = {
      ...cockpit,
      releases: [
        {
          version: "2.0.0",
          channel: "stable",
          builds: [
            {
              target: "esp32p4",
              mergedUrl: "https://example.invalid/agnostic.bin",
            },
          ],
        },
        ...(cockpit.releases ?? []),
      ],
    };
    const offer = boardCatalogue([mixed])[0]?.offers[0];
    // 1.3.1 names the board, so there IS something installable.
    expect(offer?.state).toBe("flashable");
    expect(offer?.builds.map((b) => b.version)).toEqual(["1.3.1"]);
    // 2.0.0 is not offered, because it cannot be tied to a board...
    expect(offer?.builds.map((b) => b.version)).not.toContain("2.0.0");
    // ...but the page is told why, naming the version being held back.
    expect(offer?.note).toBeDefined();
    expect(offer?.note).toContain("2.0.0");
    expect(offer?.note).toContain("black");
  });

  it("does not add a note when the unusable release is OLDER", () => {
    // Only a newer release is worth mentioning. An old OTA-only build being
    // skipped is routine and explaining it every time would be noise.
    const oldOtaOnly: CatalogueProject = {
      id: "old",
      name: "Old",
      repo: "example/old",
      boards: [{ id: "c6", target: "esp32c6", name: "C6" }],
      releases: [
        {
          version: "2.0.0",
          channel: "stable",
          builds: [
            {
              target: "esp32c6",
              boardId: "c6",
              mergedUrl: "https://example.invalid/2.bin",
            },
          ],
        },
        {
          version: "1.0.0",
          channel: "stable",
          builds: [
            {
              target: "esp32c6",
              boardId: "c6",
              otaUrl: "https://example.invalid/1-ota.bin",
            },
          ],
        },
      ],
    };
    const offer = boardCatalogue([oldOtaOnly])[0]?.offers[0];
    expect(offer?.build?.version).toBe("2.0.0");
    expect(offer?.note).toBeUndefined();
  });
});

/**
 * Which espOS runtime a build carries.
 *
 * A fix can land in the runtime rather than the application, so a firmware whose
 * own version is unchanged can still be missing one. The registry establishes
 * this from the project's submodule pin; the flasher has no other way to know,
 * because it talks to a blank board and an unflashed board cannot be asked.
 */
describe("espOS runtime version", () => {
  it("carries the release's espOS version onto every build", () => {
    const withEspos: CatalogueProject = {
      id: "e",
      name: "E",
      repo: "example/e",
      boards: [{ id: "c6", target: "esp32c6", name: "C6" }],
      releases: [
        {
          version: "1.0.0",
          channel: "stable",
          espos: "0.10.2",
          builds: [
            {
              target: "esp32c6",
              boardId: "c6",
              mergedUrl: "https://example.invalid/1.bin",
            },
          ],
        },
      ],
    };
    expect(boardCatalogue([withEspos])[0]?.offers[0]?.build?.espos).toBe(
      "0.10.2",
    );
  });

  it("compares runtime versions numerically, not lexically", () => {
    // 0.10.2 is NEWER than 0.9.0, though it sorts below it as a string. Getting
    // this backwards would tell someone a current build was out of date.
    expect(esposLag("0.10.2", "0.10.3")).toBe("behind");
    expect(esposLag("0.10.3", "0.10.3")).toBe("current");
    expect(esposLag("0.10.2", "0.9.0")).toBe("ahead");
  });

  it("stays unknown rather than guessing when either side is missing", () => {
    // A project that pinned an untagged espOS commit records no version, and
    // calling that "current" would be worse than saying nothing.
    expect(esposLag(undefined, "0.10.3")).toBe("unknown");
    expect(esposLag("0.10.2", undefined)).toBe("unknown");
    expect(esposLag(undefined, undefined)).toBe("unknown");
  });
});
