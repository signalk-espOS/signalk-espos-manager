/**
 * Discovery-merge tests.
 *
 * The cases are taken from what a real boat network produced on 2026-09-20,
 * not from imagination: duplicate instance names, one record per host
 * interface, hostname-keyed Signal K paths, and stale registered devices.
 */

import { describe, expect, it } from "vitest";
import {
  attributeSkSegments,
  idFromMac,
  idFromSkSegment,
  isDeviceId,
  mergeSightings,
  normalizeAddress,
  parseHostEntry,
} from "../src/discovery/merge.js";
import type {
  DeviceId,
  DeviceIdentity,
  DiscoverySighting,
} from "../src/types.js";

const NOW = 1_758_400_000_000;

function mdns(
  id: string | undefined,
  addresses: string[],
  extra: Partial<DiscoverySighting> = {},
): DiscoverySighting {
  return {
    source: "mdns",
    seenAt: NOW,
    id,
    addresses,
    port: 80,
    ...extra,
  };
}

const empty = (): Map<DeviceId, DeviceIdentity> => new Map();

describe("id helpers", () => {
  it("accepts a four-hex short id and rejects anything else", () => {
    expect(isDeviceId("2be9")).toBe(true);
    expect(isDeviceId("cbec")).toBe(true);
    expect(isDeviceId("2BE9")).toBe(false); // espOS advertises lowercase
    expect(isDeviceId("2be")).toBe(false);
    expect(isDeviceId(undefined)).toBe(false);
  });

  it("derives the id from the last two MAC bytes, as espOS does", () => {
    // espOS derives the id from the last two bytes of the base MAC;
    // confirmed on a real device, with the MAC here made up.
    expect(idFromMac("aa:bb:cc:dd:2b:e9")).toBe("2be9");
    expect(idFromMac("30-ED-A0-E3-2B-E9")).toBe("2be9");
    expect(idFromMac("zz")).toBeUndefined();
  });

  it("reads an id out of a Signal K path segment only when it can", () => {
    expect(idFromSkSegment("espos-2be9")).toBe("2be9");
    expect(idFromSkSegment("cbec")).toBe("cbec");
    // A custom hostname carries no id — this is the espos.cockpit.* case.
    expect(idFromSkSegment("cockpit")).toBeUndefined();
    expect(idFromSkSegment("ble-gateway")).toBeUndefined();
  });

  it("unwraps IPv4-mapped IPv6 addresses from security.json", () => {
    expect(normalizeAddress("::ffff:192.168.0.118")).toBe("192.168.0.118");
    expect(normalizeAddress(" 192.168.0.108 ")).toBe("192.168.0.108");
  });

  it("parses static host entries with and without a port", () => {
    expect(parseHostEntry("espos-2be9.local")).toEqual({
      host: "espos-2be9.local",
      port: 80,
    });
    expect(parseHostEntry("10.0.5.9:8080")).toEqual({
      host: "10.0.5.9",
      port: 8080,
    });
    expect(parseHostEntry("  ")).toBeNull();
  });
});

describe("mergeSightings", () => {
  it("collapses the same device seen on two host interfaces", () => {
    // Every device appeared twice on the live network, once per interface.
    const { identities, warnings } = mergeSightings(
      [
        mdns("2be9", ["192.168.0.167"], { host: "espos-2be9.local" }),
        mdns("2be9", ["192.168.0.167"], { host: "espos-2be9.local" }),
      ],
      empty(),
    );
    expect(identities.size).toBe(1);
    expect(identities.get("2be9")?.addresses).toEqual(["192.168.0.167"]);
    expect(warnings).toEqual([]);
  });

  it("keeps two devices apart even when they share an instance name", () => {
    // Two panels both advertising "cockpit" is a real, observed state.
    const { identities } = mergeSightings(
      [
        mdns("6f19", ["192.168.0.118"], { host: "cockpit.local" }),
        mdns("2be9", ["192.168.0.167"], { host: "cockpit.local" }),
      ],
      empty(),
    );
    expect(identities.size).toBe(2);
    expect(identities.get("6f19")?.addresses).toEqual(["192.168.0.118"]);
    expect(identities.get("2be9")?.addresses).toEqual(["192.168.0.167"]);
  });

  it("strips the .local suffix from the hostname", () => {
    const { identities } = mergeSightings(
      [mdns("cbd8", ["192.168.0.108"], { host: "ble-gateway.local" })],
      empty(),
    );
    expect(identities.get("cbd8")?.hostname).toBe("ble-gateway");
  });

  it("derives a missing id from the MAC", () => {
    const { identities, unresolved } = mergeSightings(
      [
        {
          source: "mdns",
          seenAt: NOW,
          addresses: ["192.168.0.167"],
          mac: "aa:bb:cc:dd:2b:e9",
        },
      ],
      empty(),
    );
    expect(unresolved).toHaveLength(0);
    expect(identities.has("2be9")).toBe(true);
  });

  it("warns instead of unifying when the id and MAC disagree", () => {
    const { identities, warnings } = mergeSightings(
      [mdns("1234", ["192.168.0.9"], { mac: "aa:bb:cc:dd:2b:e9" })],
      empty(),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/2be9/);
    // The advertised id still wins; we do not silently merge two devices.
    expect(identities.has("1234")).toBe(true);
  });

  it("queues an id-less sighting for probing rather than dropping it", () => {
    const { identities, unresolved } = mergeSightings(
      [mdns(undefined, ["192.168.0.50"], { host: "cockpit.local" })],
      empty(),
    );
    expect(identities.size).toBe(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.host).toBe("cockpit.local");
  });

  it("keeps a previously known device that was not seen this cycle", () => {
    // Offline must mean "shown as offline", never "vanished from the list".
    const previous = new Map<DeviceId, DeviceIdentity>([
      [
        "cbd8",
        {
          id: "cbd8",
          hostname: "ble-gateway",
          addresses: ["192.168.0.108"],
          port: 80,
          sources: { mdns: NOW - 60_000 },
        },
      ],
    ]);
    const { identities } = mergeSightings([], previous);
    expect(identities.get("cbd8")?.addresses).toEqual(["192.168.0.108"]);
  });

  it("unions addresses across sources and prefers the known-good one", () => {
    const previous = new Map<DeviceId, DeviceIdentity>([
      [
        "2be9",
        {
          id: "2be9",
          addresses: ["192.168.0.167"],
          port: 80,
          sources: { mdns: NOW - 1000 },
        },
      ],
    ]);
    const { identities } = mergeSightings(
      [
        mdns("2be9", ["192.168.0.199"]),
        {
          source: "sk-device",
          seenAt: NOW,
          id: "2be9",
          addresses: ["::ffff:192.168.0.167"],
        },
      ],
      previous,
    );
    const addresses = identities.get("2be9")?.addresses ?? [];
    // The address that worked last time stays first; the new one is kept.
    expect(addresses[0]).toBe("192.168.0.167");
    expect(addresses).toContain("192.168.0.199");
  });

  it("records which sources have seen a device", () => {
    const { identities } = mergeSightings(
      [
        mdns("2be9", ["192.168.0.167"]),
        { source: "sk-model", seenAt: NOW, id: "2be9" },
      ],
      empty(),
    );
    const sources = identities.get("2be9")?.sources ?? {};
    expect(sources.mdns).toBe(NOW);
    expect(sources["sk-model"]).toBe(NOW);
  });
});

describe("attributeSkSegments", () => {
  it("resolves default hostnames and bare ids", () => {
    const { attributed } = attributeSkSegments(
      ["espos-2be9", "cbec"],
      new Map(),
    );
    expect(attributed.get("espos-2be9")).toBe("2be9");
    expect(attributed.get("cbec")).toBe("cbec");
  });

  it("resolves a custom hostname via the known device list", () => {
    const { attributed } = attributeSkSegments(
      ["cockpit"],
      new Map([["cockpit", ["6f19"]]]),
    );
    expect(attributed.get("cockpit")).toBe("6f19");
  });

  it("refuses to attribute a hostname two devices share", () => {
    // espOS keys these paths on the hostname, so the data model genuinely
    // cannot tell the two apart. Showing one device the other's health is
    // worse than showing neither.
    const { attributed, warnings } = attributeSkSegments(
      ["cockpit"],
      new Map([["cockpit", ["6f19", "2be9"]]]),
    );
    expect(attributed.has("cockpit")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/share a hostname/);
  });

  it("leaves an unknown hostname unattributed and silent", () => {
    const { attributed, warnings } = attributeSkSegments(
      ["mystery"],
      new Map(),
    );
    expect(attributed.size).toBe(0);
    expect(warnings).toEqual([]);
  });
});
