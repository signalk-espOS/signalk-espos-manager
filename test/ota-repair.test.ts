import { describe, expect, it } from "vitest";

import { serializeDevice } from "../src/api/serialize.js";
import type { DeviceRecord } from "../src/types.js";

/** A minimal online cockpit whose OTA status reports `manifest.url`. */
function record(
  manifestUrl: string,
  otaConfig?: {
    manifestSrc?: string;
    manifestPath?: string;
    manifestUrl?: string;
  },
): DeviceRecord {
  return {
    identity: {
      id: "2be9",
      hostname: "espos-2be9",
      port: 80,
      addresses: [{ address: "192.168.0.167", source: "mdns", seenAt: 1 }],
      sources: { mdns: 1 },
    },
    firstSeenAt: 1,
    lastSeenAt: 1,
    snapshot: {
      probedAt: 1,
      app: "cockpit",
      version: "1.3.2",
      authRequired: false,
      ota: {
        state: "idle",
        manifest: { url: manifestUrl, channel: "stable" },
      },
      otaConfig,
    },
  } as unknown as DeviceRecord;
}

describe("otaNeedsRepair", () => {
  it("says nothing when the device reports no manifest url yet", () => {
    // With ota.manifest_src = "signalk" espOS derives the URL from the server
    // it selected, and /ota/status reports manifest_eff only once a check has
    // run — so a correctly configured device that has not checked reports "".
    // Claiming it is "not looking for updates anywhere" was wrong, and was
    // what made "fix it" look like it had done nothing.
    const dto = serializeDevice(record(""));
    expect(dto.otaNeedsRepair).toBeUndefined();
    expect(dto.otaRepairReason).toBeUndefined();
  });

  it("still flags a device pointed at the admin-gated /plugins path", () => {
    const dto = serializeDevice(
      record(
        "http://192.168.0.148/plugins/signalk-espos-updates/manifest.json",
      ),
    );
    expect(dto.otaNeedsRepair).toBe(true);
    expect(dto.otaRepairReason).toContain("/plugins/");
  });

  it("accepts the path this plugin serves", () => {
    const dto = serializeDevice(
      record(
        "http://192.168.0.148/signalk-espos-manager/fw/cockpit/manifest.json",
      ),
    );
    expect(dto.otaNeedsRepair).toBe(false);
  });

  it("trusts the config over an empty status url", () => {
    // The real case that made "fix it" look broken: configured correctly,
    // never checked, so /ota/status reports "".
    const dto = serializeDevice(
      record("", {
        manifestSrc: "signalk",
        manifestPath: "/signalk-espos-manager/fw/cockpit/manifest.json",
        manifestUrl: "",
      }),
    );
    expect(dto.otaNeedsRepair).toBe(false);
  });

  it("still flags a device with no OTA config at all", () => {
    // An espOS 0.7.0 gateway: no manifest_src, no path. Genuinely pointed
    // nowhere, and the earlier "empty url means say nothing" fix hid it.
    const dto = serializeDevice(record("", {}));
    expect(dto.otaNeedsRepair).toBe(true);
  });
});
