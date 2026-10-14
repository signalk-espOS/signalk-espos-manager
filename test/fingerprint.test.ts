import { describe, expect, it } from "vitest";

import {
  APP_DESC_OFFSET,
  bootPartition,
  leadingBoard,
  likelyBoards,
  OTADATA_SECTOR,
  otadataPartition,
  parseAppDescription,
  parsePartitionTable,
  usbId,
  type Fingerprint,
} from "../web/src/flash/fingerprint.js";
import type { HardwareBoard } from "../web/src/flash/catalogue.js";

function entry(
  type: number,
  subtype: number,
  offset: number,
  size: number,
  label: string,
): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x50aa, true);
  view.setUint8(2, type);
  view.setUint8(3, subtype);
  view.setUint32(4, offset, true);
  view.setUint32(8, size, true);
  bytes.set(new TextEncoder().encode(label), 12);
  return bytes;
}

/** The layout espOS projects use: nvs, otadata, two OTA slots. */
function table(withFactory = false): Uint8Array {
  const rows = [
    entry(1, 0x02, 0x9000, 0x6000, "nvs"),
    entry(1, 0x00, 0xf000, 0x2000, "otadata"),
    ...(withFactory ? [entry(0, 0x00, 0x10000, 0x100000, "factory")] : []),
    entry(0, 0x10, 0x110000, 0x300000, "ota_0"),
    entry(0, 0x11, 0x410000, 0x300000, "ota_1"),
  ];
  const md5 = new Uint8Array(32).fill(0xeb);
  const out = new Uint8Array(0xc00).fill(0xff);
  [...rows, md5].forEach((row, i) => out.set(row, i * 32));
  return out;
}

// What ESP-IDF writes for seq 1 to 3, from esp_rom_crc32_le(UINT32_MAX, ...).
const CRC: Record<number, number> = {
  1: 0x4743989a,
  2: 0x55f63774,
  3: 0xed4a5011,
};

function otadata(
  ...entries: { seq: number; state?: number; crc?: number }[]
): Uint8Array {
  const out = new Uint8Array(2 * OTADATA_SECTOR).fill(0xff);
  const view = new DataView(out.buffer);
  entries.forEach(({ seq, state = 2, crc = CRC[seq] ?? 0 }, i) => {
    view.setUint32(i * OTADATA_SECTOR, seq, true);
    view.setUint32(i * OTADATA_SECTOR + 24, state, true);
    view.setUint32(i * OTADATA_SECTOR + 28, crc, true);
  });
  return out;
}

function appImage(projectName: string, version: string): Uint8Array {
  const out = new Uint8Array(APP_DESC_OFFSET + 0x100);
  out[0] = 0xe9;
  const view = new DataView(out.buffer);
  view.setUint32(APP_DESC_OFFSET, 0xabcd5432, true);
  const text = new TextEncoder();
  out.set(text.encode(version), APP_DESC_OFFSET + 16);
  out.set(text.encode(projectName), APP_DESC_OFFSET + 48);
  out.set(text.encode("v5.3.1"), APP_DESC_OFFSET + 112);
  return out;
}

describe("reading what is on the flash", () => {
  it("lists the partitions up to the MD5 row", () => {
    const parts = parsePartitionTable(table());
    expect(parts.map((p) => p.label)).toEqual([
      "nvs",
      "otadata",
      "ota_0",
      "ota_1",
    ]);
    expect(otadataPartition(parts)?.offset).toBe(0xf000);
  });

  it("finds no table on blank flash", () => {
    expect(parsePartitionTable(new Uint8Array(0xc00).fill(0xff))).toEqual([]);
  });

  it("boots the slot the newest valid otadata entry names", () => {
    const parts = parsePartitionTable(table());
    expect(bootPartition(parts, otadata({ seq: 1 }, { seq: 2 }))?.label).toBe(
      "ota_1",
    );
    expect(bootPartition(parts, otadata({ seq: 3 }))?.label).toBe("ota_0");
    // An aborted update does not count; the older entry still boots.
    expect(
      bootPartition(parts, otadata({ seq: 1 }, { seq: 2, state: 4 }))?.label,
    ).toBe("ota_0");
  });

  it("skips an entry whose CRC does not match, as the bootloader does", () => {
    const parts = parsePartitionTable(table());
    expect(
      bootPartition(parts, otadata({ seq: 1 }, { seq: 2, crc: 0x1234 }))?.label,
    ).toBe("ota_0");
  });

  it("finds the slot by subtype, not by position", () => {
    const rows = [
      entry(1, 0x00, 0xf000, 0x2000, "otadata"),
      entry(0, 0x11, 0x410000, 0x300000, "ota_1"),
      entry(0, 0x10, 0x110000, 0x300000, "ota_0"),
    ];
    const bytes = new Uint8Array(0xc00).fill(0xff);
    rows.forEach((row, i) => bytes.set(row, i * 32));
    expect(
      bootPartition(parsePartitionTable(bytes), otadata({ seq: 1 }))?.label,
    ).toBe("ota_0");
  });

  it("falls back to factory, then the first slot, without an entry", () => {
    expect(
      bootPartition(parsePartitionTable(table(true)), otadata())?.label,
    ).toBe("factory");
    expect(bootPartition(parsePartitionTable(table()), undefined)?.label).toBe(
      "ota_0",
    );
  });

  it("reads the project name and version from the app description", () => {
    expect(parseAppDescription(appImage("cockpit", "2.1.0"))).toEqual({
      projectName: "cockpit",
      version: "2.1.0",
      idfVersion: "v5.3.1",
    });
  });

  it("reads nothing from an erased slot or a non-app image", () => {
    expect(
      parseAppDescription(new Uint8Array(0x200).fill(0xff)),
    ).toBeUndefined();
    const image = appImage("x", "1");
    image[APP_DESC_OFFSET] = 0;
    expect(parseAppDescription(image)).toBeUndefined();
  });

  it("writes USB ids as the registry does", () => {
    expect(usbId(0x1a86)).toBe("1a86");
    expect(usbId(0x303a)).toBe("303a");
    expect(usbId(undefined)).toBeUndefined();
  });
});

const hardware: HardwareBoard[] = [
  {
    id: "waveshare-p4-touch-7b",
    vendor: "Waveshare",
    name: "7B",
    target: "esp32p4",
    flashBytes: 32 * 1048576,
    usbBridge: { chip: "CH343", vid: "1a86", pid: "55d3" },
    factoryApps: ["ESP32-P4-7B-demo"],
  },
  {
    id: "waveshare-p4-touch-x-7",
    vendor: "Waveshare",
    name: "X 7",
    target: "esp32p4",
    flashBytes: 16 * 1048576,
    usbBridge: { chip: "CH343", vid: "1a86", pid: "55d3" },
  },
  {
    id: "waveshare-p4-poe-eth",
    vendor: "Waveshare",
    name: "P4 PoE",
    target: "esp32p4",
    usbBridge: { chip: "CH343", vid: "1a86", pid: "55d3" },
  },
  { id: "esp32c6-devkit", vendor: "Various", name: "C6", target: "esp32c6" },
];

const projects = [
  {
    id: "cockpit",
    app: "cockpit",
    name: "P4 Cockpit",
    boards: [
      { id: "waveshare-p4-touch-7b", target: "esp32p4" },
      { id: "waveshare-p4-touch-x-7", target: "esp32p4" },
    ],
  },
  {
    id: "ble-gateway",
    app: "ble_gateway",
    name: "BLE Gateway",
    boards: [
      {
        id: "waveshare-p4-poe",
        target: "esp32p4",
        runsOn: ["waveshare-p4-poe-eth"],
      },
    ],
  },
];

const p4: Fingerprint = {
  target: "esp32p4",
  flashSizeDetected: false,
  usbVid: "1a86",
  usbPid: "55d3",
};

describe("which board this looks like", () => {
  it("leads with the board whose factory demo is on it", () => {
    const likely = likelyBoards(
      { ...p4, installed: { projectName: "ESP32-P4-7B-demo", version: "1" } },
      hardware,
      projects,
    );
    expect(leadingBoard(likely)?.id).toBe("waveshare-p4-touch-7b");
    expect(leadingBoard(likely)?.clues).toEqual(["factory", "bridge"]);
  });

  it("leads with the one board an installed espOS project runs on", () => {
    const likely = likelyBoards(
      { ...p4, installed: { projectName: "ble_gateway", version: "0.4.0" } },
      hardware,
      projects,
    );
    const lead = leadingBoard(likely);
    expect(lead?.id).toBe("waveshare-p4-poe-eth");
    expect(lead?.project).toBe("BLE Gateway");
  });

  it("leads with nothing when the installed project runs on two boards", () => {
    const likely = likelyBoards(
      { ...p4, installed: { projectName: "cockpit", version: "2.1.0" } },
      hardware,
      projects,
    );
    expect(likely.slice(0, 2).map((l) => l.id)).toEqual([
      "waveshare-p4-touch-7b",
      "waveshare-p4-touch-x-7",
    ]);
    expect(leadingBoard(likely)).toBeUndefined();
  });

  it("lets the measured flash size settle a tie", () => {
    const likely = likelyBoards(
      {
        ...p4,
        flashBytes: 16 * 1048576,
        flashSizeDetected: true,
        installed: { projectName: "cockpit", version: "2.1.0" },
      },
      hardware,
      projects,
    );
    expect(leadingBoard(likely)?.id).toBe("waveshare-p4-touch-x-7");
  });

  it("matches a board sold in several sizes on any of them", () => {
    const sized: HardwareBoard[] = [
      { ...hardware[0]!, flashSizes: [16 * 1048576, 32 * 1048576] },
      ...hardware.slice(1),
    ];
    const likely = likelyBoards(
      { ...p4, flashBytes: 16 * 1048576, flashSizeDetected: true },
      sized,
      projects,
    );
    expect(likely.map((l) => l.id)).toContain("waveshare-p4-touch-7b");
  });

  it("ignores a flash size that was only guessed", () => {
    const likely = likelyBoards(
      { ...p4, flashBytes: 4 * 1048576, flashSizeDetected: false },
      hardware,
      projects,
    );
    expect(likely).toHaveLength(3);
  });

  it("takes nothing from firmware built for a generic dev board", () => {
    const generic: HardwareBoard[] = [
      ...hardware,
      {
        id: "esp32s3-devkit",
        vendor: "Various",
        name: "S3",
        target: "esp32s3",
      },
    ];
    const likely = likelyBoards(
      {
        target: "esp32s3",
        flashSizeDetected: false,
        installed: { projectName: "ble_gateway", version: "0.4.0" },
      },
      generic,
      [
        {
          id: "ble-gateway",
          app: "ble_gateway",
          name: "BLE Gateway",
          boards: [{ id: "esp32s3-devkit", target: "esp32s3" }],
        },
      ],
    );
    expect(likely).toEqual([]);
  });

  it("matches no project to a blank board", () => {
    const likely = likelyBoards(
      { target: "esp32p4", flashSizeDetected: false },
      hardware,
      [
        {
          id: "cockpit",
          name: "P4 Cockpit",
          app: undefined as unknown as string,
          boards: [{ id: "waveshare-p4-touch-7b", target: "esp32p4" }],
        },
      ],
    );
    expect(likely).toEqual([]);
  });

  it("never leads on a shared USB bridge alone", () => {
    const likely = likelyBoards(p4, hardware, projects);
    expect(likely.every((l) => l.clues.join() === "bridge")).toBe(true);
    expect(leadingBoard(likely)).toBeUndefined();
  });

  it("suggests nothing on another chip", () => {
    expect(
      likelyBoards({ ...p4, target: "esp32c6" }, hardware, projects),
    ).toEqual([]);
  });
});
