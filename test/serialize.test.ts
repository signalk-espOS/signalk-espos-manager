import { describe, expect, it } from "vitest";

import { serializeDevice } from "../src/api/serialize.js";
import type { DeviceRecord, HardwareInfo } from "../src/types.js";

function record(hardware?: HardwareInfo): DeviceRecord {
  return {
    identity: {
      id: "2be9",
      port: 80,
      addresses: ["192.168.0.167"],
      sources: { mdns: 1 },
    },
    firstSeenAt: 1,
    lastSeenAt: 1,
    snapshot: {
      probedAt: 1,
      app: "ble_gateway",
      version: "0.3.0",
      authRequired: false,
      info: { hardware },
    },
  } as unknown as DeviceRecord;
}

describe("serializeDevice co-processor", () => {
  it("lifts a stale co-processor into the fleet row", () => {
    const dto = serializeDevice(
      record({
        coprocessor: {
          version: "2.12.3",
          hostVersion: "3.0.9",
          target: "esp32c6",
          stale: true,
        },
      }),
    );
    expect(dto.coprocessorStale).toBe(true);
    expect(dto.coprocessor?.version).toBe("2.12.3");
  });

  it("says nothing about a co-processor the device does not report", () => {
    const dto = serializeDevice(record({ board: "x" }));
    expect(dto.coprocessor).toBeUndefined();
    expect(dto.coprocessorStale).toBeUndefined();
  });
});
