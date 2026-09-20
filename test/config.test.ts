/**
 * Config-schema tests.
 *
 * Signal K starts a never-configured plugin with `{}` and does not seed schema
 * defaults, and a hand-edited config file can hold anything — so the merge has
 * to produce a usable config from every shape of input, repairing bad fields
 * individually rather than discarding the whole configuration.
 */

import { describe, expect, it } from "vitest";
import {
  applyDefaults,
  defaultSettings,
  DEFAULT_REGISTRY_INDEX,
  PUBLIC_FW_BASE,
  SettingsSchema,
} from "../src/config.js";

describe("defaults", () => {
  it("produces a complete config with no input", () => {
    const settings = defaultSettings();
    expect(settings.discovery.mdns).toBe(true);
    expect(settings.discovery.pollIntervalS).toBe(60);
    expect(settings.discovery.staticHosts).toEqual([]);
    expect(settings.auth.fleetKey).toBe("");
    expect(settings.auth.autoProvision).toBe(false);
    expect(settings.registry.indexUrl).toBe(DEFAULT_REGISTRY_INDEX);
    expect(settings.mirror.enabled).toBe(true);
    expect(settings.ota.channel).toBe("stable");
    // One at a time: several devices pulling firmware over one boat wifi is
    // how a fleet update goes wrong.
    expect(settings.ota.maxConcurrent).toBe(1);
  });

  it("does not provision keys onto hardware without being asked", () => {
    expect(defaultSettings().auth.autoProvision).toBe(false);
  });

  it("does not cache 15 MB full-flash images by default", () => {
    expect(defaultSettings().mirror.cacheMergedImages).toBe(false);
  });

  it("every section carries an object-level default", () => {
    // Without `default: {}` on a section, Value.Default never materialises a
    // missing section and every partial config fails validation wholesale.
    const properties = (
      SettingsSchema as unknown as {
        properties: Record<string, { default?: unknown }>;
      }
    ).properties;
    for (const [name, section] of Object.entries(properties)) {
      expect(section.default, `${name} needs default: {}`).toEqual({});
    }
  });
});

describe("applyDefaults", () => {
  it("fills everything in for a never-configured plugin", () => {
    expect(applyDefaults({})).toEqual(defaultSettings());
  });

  it("tolerates null and undefined", () => {
    expect(applyDefaults(null).ota.channel).toBe("stable");
    expect(applyDefaults(undefined).discovery.mdns).toBe(true);
  });

  it("keeps the user's values", () => {
    const settings = applyDefaults({
      discovery: { pollIntervalS: 30, staticHosts: ["10.0.0.5"] },
      ota: { channel: "beta" },
    });
    expect(settings.discovery.pollIntervalS).toBe(30);
    expect(settings.discovery.staticHosts).toEqual(["10.0.0.5"]);
    expect(settings.ota.channel).toBe("beta");
    // Untouched sections still get their defaults.
    expect(settings.mirror.keepVersions).toBe(3);
  });

  it("repairs one bad field without losing the rest of the config", () => {
    const settings = applyDefaults({
      discovery: { pollIntervalS: "not a number", staticHosts: ["10.0.0.5"] },
      auth: { fleetKey: "keep-me" },
    });
    expect(settings.discovery.pollIntervalS).toBe(60);
    expect(settings.auth.fleetKey).toBe("keep-me");
  });

  it("clamps an out-of-range value back to something usable", () => {
    expect(
      applyDefaults({ ota: { maxConcurrent: 99 } }).ota.maxConcurrent,
    ).toBe(1);
    expect(
      applyDefaults({ discovery: { pollIntervalS: 1 } }).discovery
        .pollIntervalS,
    ).toBe(60);
  });

  it("converts a numeric string, as the admin form can submit", () => {
    expect(
      applyDefaults({ discovery: { pollIntervalS: "45" } }).discovery
        .pollIntervalS,
    ).toBe(45);
  });

  it("survives a config that is not an object at all", () => {
    expect(applyDefaults("nonsense").ota.channel).toBe("stable");
    expect(applyDefaults(42).discovery.mdns).toBe(true);
  });

  it("drops unknown keys rather than choking on them", () => {
    const settings = applyDefaults({ leftoverFromAnOlderVersion: true });
    expect(settings).toEqual(defaultSettings());
  });

  it("rejects an invalid channel", () => {
    expect(applyDefaults({ ota: { channel: "nightly" } }).ota.channel).toBe(
      "stable",
    );
  });
});

describe("public paths", () => {
  it("serves firmware from the unauthenticated webapp mount", () => {
    // NOT /plugins/... — that is admin-gated, and a device holds a device
    // token, so it would be refused.
    expect(PUBLIC_FW_BASE).toBe("/signalk-espos-manager/fw");
    expect(PUBLIC_FW_BASE.startsWith("/plugins")).toBe(false);
  });

  it("keeps the manifest URL inside the device's 167-byte buffer", () => {
    // espOS stores the manifest URL in char[168].
    const worstCase = `http://192.168.100.100:3000${PUBLIC_FW_BASE}/ble_gateway/manifest.json`;
    expect(worstCase.length).toBeLessThan(168);
  });
});
