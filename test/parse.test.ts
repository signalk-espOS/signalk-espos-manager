/**
 * Parser tests against payloads captured from the three live espOS devices on
 * 2026-09-20 (cockpit 192.168.0.118 and .167, ble-gateway .108), not against
 * invented JSON. All three run pre-0.10.0 firmware, so they are exactly the
 * "old device" case the parsers must tolerate.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseOtaStatus,
  parsePing,
  parseSystemInfo,
} from "../src/device/parse.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

describe("parsePing", () => {
  it("reads the live cockpit ping", () => {
    const result = parsePing(fixture("ping-118"));
    expect(result.app).toBe("cockpit");
    expect(result.version).toBe("1.1.0-3-g468d0f0-dirty");
    expect(result.authRequired).toBe(false);
  });

  it("reads the live gateway ping, whose app name uses an underscore", () => {
    // ble_gateway, not ble-gateway: the CMake project() name is the OTA
    // manifest join key, and it differs from the repo name.
    expect(parsePing(fixture("ping-108")).app).toBe("ble_gateway");
  });

  it("treats a missing auth field as no auth required", () => {
    expect(parsePing({ app: "x", version: "1" }).authRequired).toBe(false);
  });

  it("reports auth when the device asks for a key", () => {
    expect(parsePing({ app: "x", version: "1", auth: true }).authRequired).toBe(
      true,
    );
  });

  it("rejects a response without app or version", () => {
    expect(() => parsePing({ auth: false })).toThrow(/missing app or version/);
    expect(() => parsePing(null)).toThrow();
  });
});

describe("parseSystemInfo", () => {
  it("reads the live cockpit info", () => {
    const info = parseSystemInfo(fixture("info-118"));
    expect(info.app).toBe("cockpit");
    expect(info.chip).toBe("esp32p4");
    expect(info.chipRevision).toBe(103);
    expect(info.cores).toBe(2);
    expect(info.idfVersion).toBe("v6.0.2");
    expect(info.resetReason).toBe("software");
    expect(info.uptimeS).toBeGreaterThan(0);
  });

  it("returns no hardware block for pre-0.10.0 firmware", () => {
    // The hardware{} block arrived in espOS 0.10.0. Every device in the
    // field today lacks it, and that must not be an error.
    for (const name of ["info-118", "info-167", "info-108"]) {
      expect(parseSystemInfo(fixture(name)).hardware).toBeUndefined();
    }
  });

  it("does not find an espOS version in info (it lives in mDNS TXT)", () => {
    expect(parseSystemInfo(fixture("info-167")).esposVersion).toBeUndefined();
  });

  it("reads a 0.10.0-shaped hardware block when present", () => {
    const info = parseSystemInfo({
      app: "cockpit",
      version: "1.3.0",
      hardware: {
        mac: "30:ed:a0:e3:2b:e9",
        cpu_mhz: 360,
        flash_bytes: 16777216,
        ram_psram_bytes: 33554432,
        features: ["wifi", "ble"],
        board: "Waveshare ESP32-P4-Touch-LCD-7B",
      },
    });
    expect(info.hardware?.board).toBe("Waveshare ESP32-P4-Touch-LCD-7B");
    expect(info.hardware?.flashBytes).toBe(16777216);
    expect(info.hardware?.features).toEqual(["wifi", "ble"]);
  });

  it("survives junk without throwing", () => {
    expect(parseSystemInfo(null)).toEqual(expect.any(Object));
    expect(parseSystemInfo({ app: 42, cores: "two" }).app).toBeUndefined();
    expect(parseSystemInfo({ cores: "two" }).cores).toBeUndefined();
  });
});

describe("parseOtaStatus", () => {
  it("reads an idle device", () => {
    const status = parseOtaStatus(fixture("ota-167"));
    expect(status.state).toBe("idle");
    expect(status.running?.version).toBe("1.1.0-12-g44590ce-dirty");
    expect(status.running?.project).toBe("cockpit");
    expect(status.running?.target).toBe("esp32p4");
    expect(status.running?.confirmed).toBe(true);
    expect(status.running?.rolledBack).toBe(false);
    expect(status.available).toBeNull();
    expect(status.lastError).toBeUndefined(); // "" normalises away
  });

  it("reads a device whose manifest fetch failed", () => {
    // .118 was left pointing at a manual test server that is gone. This is
    // precisely the state configure-ota exists to repair.
    const status = parseOtaStatus(fixture("ota-118"));
    expect(status.state).toBe("failed");
    expect(status.lastError).toBe("manifest: ESP_ERR_HTTP_CONNECT");
    expect(status.manifest?.url).toBe(
      "http://192.168.0.148:8090/manifest.json",
    );
    expect(status.manifest?.autoCheck).toBe(true);
    expect(status.manifest?.autoInstall).toBe(false);
  });

  it("reads the gateway status", () => {
    const status = parseOtaStatus(fixture("ota-108"));
    expect(status.running?.project).toBe("ble_gateway");
    expect(status.manifest?.url).toBeUndefined(); // empty string, not set
  });

  it("parses an available build", () => {
    const status = parseOtaStatus({
      state: "available",
      available: {
        version: "1.3.0",
        url: "/signalk-espos-manager/fw/cockpit/1.3.0/app.bin",
        size: 4612096,
        sha256: "a".repeat(64),
        notes: "Adds the Flow page",
        newer: true,
      },
      progress: { received: 0, total: 0 },
    });
    expect(status.state).toBe("available");
    expect(status.available?.version).toBe("1.3.0");
    expect(status.available?.newer).toBe(true);
  });

  it("ignores an available entry missing version or url", () => {
    expect(
      parseOtaStatus({ state: "available", available: { size: 10 } }).available,
    ).toBeNull();
  });

  it("reports download progress", () => {
    const status = parseOtaStatus({
      state: "downloading",
      progress: { received: 1024, total: 4096 },
    });
    expect(status.progress).toEqual({ received: 1024, total: 4096 });
  });

  it("falls back to idle for an unknown state", () => {
    expect(parseOtaStatus({ state: "reticulating" }).state).toBe("idle");
    expect(parseOtaStatus(null).state).toBe("idle");
  });

  it("reads the signing key fingerprint when the firmware reports one", () => {
    // espOS E4 and later. Absent on every device today, which is why the
    // field is optional and the UI must say "unknown" rather than "safe".
    const status = parseOtaStatus({
      state: "idle",
      running: { version: "1.3.0", key_fp: "0badc0ffee123456" },
    });
    expect(status.running?.keyFp).toBe("0badc0ffee123456");
    expect(parseOtaStatus(fixture("ota-118")).running?.keyFp).toBeUndefined();
  });
});
