/**
 * Partition-table reading for the flasher's layout line.
 *
 * The fixture is the table from ble-gateway 1.1.0's ESP32-C5 merged image,
 * rebuilt entry by entry rather than shipped as a 64 KiB binary.
 */

import { describe, expect, it } from "vitest";
import {
  flashLayout,
  parsePartitionTable,
  type Partition,
} from "../web/src/flash/partitions.js";

const GATEWAY_C5: Partition[] = [
  { label: "nvs", type: 1, subtype: 0x02, offset: 0x9000, size: 0xc000 },
  { label: "otadata", type: 1, subtype: 0x00, offset: 0x15000, size: 0x2000 },
  { label: "phy_init", type: 1, subtype: 0x01, offset: 0x17000, size: 0x1000 },
  { label: "nvs_keys", type: 1, subtype: 0x04, offset: 0x18000, size: 0x1000 },
  { label: "coredump", type: 1, subtype: 0x03, offset: 0x19000, size: 0x40000 },
  { label: "ota_0", type: 0, subtype: 0x10, offset: 0x60000, size: 0x280000 },
  { label: "ota_1", type: 0, subtype: 0x11, offset: 0x2e0000, size: 0x280000 },
  { label: "storage", type: 1, subtype: 0x83, offset: 0x560000, size: 0x90000 },
];

function imageWithTable(
  partitions: Partition[],
  tableOffset = 0x8000,
  length = 0x10000,
): Uint8Array {
  const image = new Uint8Array(length).fill(0xff);
  const view = new DataView(image.buffer);
  partitions.forEach((p, i) => {
    const at = tableOffset + i * 32;
    image[at] = 0xaa;
    image[at + 1] = 0x50;
    image[at + 2] = p.type;
    image[at + 3] = p.subtype;
    view.setUint32(at + 4, p.offset, true);
    view.setUint32(at + 8, p.size, true);
    image.fill(0, at + 12, at + 32);
    image.set(new TextEncoder().encode(p.label), at + 12);
  });
  // The MD5 row that follows the entries.
  const md5 = tableOffset + partitions.length * 32;
  image[md5] = 0xeb;
  image[md5 + 1] = 0xeb;
  return image;
}

describe("parsePartitionTable", () => {
  it("reads every entry at the default offset", () => {
    expect(parsePartitionTable(imageWithTable(GATEWAY_C5))).toEqual(GATEWAY_C5);
  });

  it("finds a table moved to another 4 KiB boundary", () => {
    const moved = imageWithTable(GATEWAY_C5, 0xd000);
    expect(parsePartitionTable(moved)?.map((p) => p.label)).toEqual(
      GATEWAY_C5.map((p) => p.label),
    );
  });

  it("returns undefined for an image without a table", () => {
    expect(parsePartitionTable(new Uint8Array(0x10000).fill(0xff))).toBe(
      undefined,
    );
  });

  it("stops at the end of a truncated head instead of reading past it", () => {
    const head = imageWithTable(GATEWAY_C5).subarray(0, 0x8000 + 3 * 32 + 10);
    expect(parsePartitionTable(head)).toHaveLength(3);
  });
});

describe("flashLayout", () => {
  it("reports the partitioned span, the app slot and how full it is", () => {
    expect(flashLayout(GATEWAY_C5, 2_297_856)).toEqual({
      partitionedBytes: 0x5f0000,
      appSlotBytes: 0x280000,
      appBytes: 2_297_856,
    });
  });

  it("takes the smaller slot when the two differ", () => {
    const uneven = GATEWAY_C5.map((p) =>
      p.label === "ota_1" ? { ...p, size: 0x200000 } : p,
    );
    expect(flashLayout(uneven).appSlotBytes).toBe(0x200000);
  });

  it("counts a factory partition as an app slot", () => {
    const factory: Partition[] = [
      { label: "nvs", type: 1, subtype: 0x02, offset: 0x9000, size: 0x6000 },
      {
        label: "factory",
        type: 0,
        subtype: 0x00,
        offset: 0x10000,
        size: 0x100000,
      },
    ];
    expect(flashLayout(factory)).toEqual({
      partitionedBytes: 0x110000,
      appSlotBytes: 0x100000,
      appBytes: undefined,
    });
  });

  it("has no app slot when the table names none", () => {
    expect(
      flashLayout(GATEWAY_C5.filter((p) => p.type !== 0)).appSlotBytes,
    ).toBe(undefined);
  });
});
