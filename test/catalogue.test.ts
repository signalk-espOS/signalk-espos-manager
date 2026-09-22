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
