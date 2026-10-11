import { describe, expect, it } from "vitest";

import { serializeDevice } from "../src/api/serialize.js";
import { parseIndex } from "../src/registry/client.js";
import { hardwareFor } from "../src/registry/hardware.js";
import { mergeIndexes } from "../src/registry/resolve.js";
import type { RegistryIndex } from "../src/registry/types.js";
import type { DeviceRecord } from "../src/types.js";

// Shaped like the live index after registry #18, trimmed to what matters.
const index: RegistryIndex = parseIndex({
  schema: 1,
  projects: [
    {
      id: "cockpit",
      app: "cockpit",
      targets: ["esp32p4"],
      boards: [
        {
          id: "waveshare-p4-touch-7b",
          target: "esp32p4",
          name: "7B",
          reportedAs: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B",
        },
        {
          id: "waveshare-p4-touch-x-7",
          target: "esp32p4",
          name: "X 7",
          reportedAs: "Waveshare ESP32-P4-WIFI6-Touch-LCD-X 7in",
        },
      ],
    },
    {
      id: "ble-gateway",
      app: "ble_gateway",
      targets: ["esp32p4", "esp32c6"],
      boards: [
        {
          id: "waveshare-p4-poe",
          target: "esp32p4",
          name: "P4",
          reportedAs: "Waveshare ESP32-P4",
          runsOn: ["waveshare-p4-poe-eth", "waveshare-p4-touch-7b"],
        },
        {
          id: "esp32c6-devkit",
          target: "esp32c6",
          name: "C6",
          reportedAs: "ESP32-C6 dev kit",
        },
      ],
    },
  ],
  boards: [
    {
      id: "waveshare-p4-touch-7b",
      vendor: "Waveshare",
      model: "ESP32-P4-WIFI6-Touch-LCD-7B",
      name: "Waveshare ESP32-P4 7-inch touch display (7B, 1024x600)",
      image: "https://example.com/7b.jpg",
      features: ["can"],
    },
    {
      id: "waveshare-p4-touch-x-7",
      name: "Waveshare X 7",
      buyUrl: "javascript:alert(1)",
      image: "http://example.com/x7.jpg",
    },
    { id: "waveshare-p4-poe-eth", name: "Waveshare P4 PoE" },
    { id: "esp32c6-devkit", vendor: "Various", name: "ESP32-C6 board" },
    { name: "no id, dropped" },
  ],
  useCases: [
    {
      id: "instrument-panel",
      title: "Show instruments on a touch screen",
      projects: ["cockpit"],
      boards: [
        { id: "waveshare-p4-touch-7b", fits: true },
        { id: "waveshare-p4-touch-x-7", fits: true },
      ],
    },
    {
      id: "nmea2000",
      title: "Connect an NMEA 2000 network",
      projects: ["cockpit"],
      boards: [
        { id: "waveshare-p4-touch-7b", fits: true },
        { id: "waveshare-p4-touch-x-7", fits: false },
      ],
    },
    {
      id: "bluetooth-sensors",
      title: "Bring Bluetooth sensors into Signal K",
      projects: ["ble-gateway"],
      boards: [
        { id: "waveshare-p4-touch-7b", fits: true },
        { id: "esp32c6-devkit", fits: true },
      ],
    },
    { title: "no id, dropped", projects: [] },
  ],
});

describe("parseIndex catalogue", () => {
  it("keeps boards and use cases with an id and a name, and drops the rest", () => {
    expect(index.boards?.map((b) => b.id)).toEqual([
      "waveshare-p4-touch-7b",
      "waveshare-p4-touch-x-7",
      "waveshare-p4-poe-eth",
      "esp32c6-devkit",
    ]);
    expect(index.useCases?.map((u) => u.id)).toEqual([
      "instrument-panel",
      "nmea2000",
      "bluetooth-sensors",
    ]);
  });

  it("drops a shop link or photo that is not https", () => {
    const x7 = index.boards?.find((b) => b.id === "waveshare-p4-touch-x-7");
    expect(x7?.buyUrl).toBeUndefined();
    expect(x7?.image).toBeUndefined();
  });

  it("reads an index from before the catalogue as having none", () => {
    const old = parseIndex({ schema: 1, projects: [] });
    expect(old.boards).toEqual([]);
    expect(old.useCases).toEqual([]);
  });

  it("lets a source label only its own projects", () => {
    const other = parseIndex({
      schema: 1,
      projects: [{ id: "theirs", app: "theirs", targets: ["esp32"] }],
      useCases: [
        {
          id: "mine",
          title: "Anything they like",
          projects: ["cockpit", "theirs"],
          boards: [],
        },
      ],
    });
    const merged = mergeIndexes([
      { url: "a", index },
      { url: "b", index: other },
    ]).index;
    expect(merged.useCases?.find((u) => u.id === "mine")?.projects).toEqual([
      "theirs",
    ]);
  });

  it("carries the catalogue through a merge, the first source winning", () => {
    const other = parseIndex({
      schema: 1,
      projects: [],
      boards: [{ id: "waveshare-p4-touch-7b", name: "someone else's 7B" }],
    });
    const merged = mergeIndexes([
      { url: "a", index },
      { url: "b", index: other },
    ]).index;
    expect(
      merged.boards?.find((b) => b.id === "waveshare-p4-touch-7b")?.name,
    ).toBe("Waveshare ESP32-P4 7-inch touch display (7B, 1024x600)");
    expect(merged.useCases).toHaveLength(3);
  });
});

describe("hardwareFor", () => {
  it("names the product and every job it does on that board", () => {
    const result = hardwareFor(
      index,
      "cockpit",
      "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B",
    );
    expect(result.board?.vendor).toBe("Waveshare");
    expect(result.board?.image).toBe("https://example.com/7b.jpg");
    expect(result.useCases.map((u) => u.id)).toEqual([
      "instrument-panel",
      "nmea2000",
    ]);
  });

  it("leaves out a job the board cannot do without an add-on", () => {
    const result = hardwareFor(
      index,
      "cockpit",
      "Waveshare ESP32-P4-WIFI6-Touch-LCD-X 7in",
    );
    expect(result.board?.id).toBe("waveshare-p4-touch-x-7");
    expect(result.useCases.map((u) => u.id)).toEqual(["instrument-panel"]);
  });

  it("names no product for an image several boards share", () => {
    const result = hardwareFor(index, "ble_gateway", "Waveshare ESP32-P4");
    expect(result.board).toBeUndefined();
    expect(result.useCases.map((u) => u.id)).toEqual(["bluetooth-sensors"]);
  });

  it("claims only the jobs every board does when the board is unknown", () => {
    const result = hardwareFor(index, "cockpit", undefined);
    expect(result.board).toBeUndefined();
    expect(result.useCases.map((u) => u.id)).toEqual(["instrument-panel"]);
  });

  it("claims no job for a board the use case does not list", () => {
    const bare = parseIndex({
      schema: 1,
      projects: index.projects,
      useCases: [{ id: "x", title: "X", projects: ["cockpit"], boards: [] }],
    });
    expect(hardwareFor(bare, "cockpit", undefined).useCases).toEqual([]);
    expect(
      hardwareFor(bare, "cockpit", "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B")
        .useCases,
    ).toEqual([]);
  });

  it("judges an unreported board by the boards its firmware runs on", () => {
    // The C6 dev kit cannot show instruments, but no cockpit runs on it.
    const wider = parseIndex({
      schema: 1,
      projects: index.projects,
      useCases: [
        {
          id: "instrument-panel",
          title: "Show instruments on a touch screen",
          projects: ["cockpit"],
          boards: [
            { id: "waveshare-p4-touch-7b", fits: true },
            { id: "esp32c6-devkit", fits: false },
          ],
        },
      ],
    });
    expect(hardwareFor(wider, "cockpit", undefined).useCases).toHaveLength(1);
  });

  it("does not trust runsOn to be an array", () => {
    const odd = parseIndex({
      schema: 1,
      projects: [
        {
          id: "odd",
          app: "odd",
          targets: ["esp32p4"],
          boards: [
            {
              id: "waveshare-p4-touch-7b",
              target: "esp32p4",
              name: "7B",
              reportedAs: "7B",
              runsOn: "x",
            },
          ],
        },
      ],
      boards: index.boards,
    });
    expect(hardwareFor(odd, "odd", "7B").board?.id).toBe(
      "waveshare-p4-touch-7b",
    );
  });

  it("says nothing for firmware the registry does not list", () => {
    expect(hardwareFor(index, "mystery", "x")).toEqual({ useCases: [] });
    expect(hardwareFor(index, undefined, "x")).toEqual({ useCases: [] });
  });
});

describe("serializeDevice hardware", () => {
  function record(board?: string): DeviceRecord {
    return {
      identity: { id: "a1", port: 80, addresses: [], sources: { mdns: 1 } },
      firstSeenAt: 1,
      lastSeenAt: 1,
      snapshot: {
        probedAt: 1,
        app: "cockpit",
        version: "2.0.0",
        authRequired: false,
        info: { hardware: { board } },
      },
    } as unknown as DeviceRecord;
  }
  const lookup = (app: string | undefined, reported: string | undefined) =>
    hardwareFor(index, app, reported);

  it("puts the product and jobs on the device, from the board in its info", () => {
    const dto = serializeDevice(
      record("Waveshare ESP32-P4-WIFI6-Touch-LCD-7B"),
      undefined,
      undefined,
      lookup,
    );
    expect(dto.hardware?.id).toBe("waveshare-p4-touch-7b");
    expect(dto.useCases?.map((u) => u.title)).toEqual([
      "Show instruments on a touch screen",
      "Connect an NMEA 2000 network",
    ]);
  });

  it("omits both when nothing resolves", () => {
    const dto = serializeDevice(
      record("unknown"),
      undefined,
      undefined,
      () => ({
        useCases: [],
      }),
    );
    expect(dto.hardware).toBeUndefined();
    expect(dto.useCases).toBeUndefined();
  });
});
