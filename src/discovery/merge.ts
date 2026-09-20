/**
 * Pure merge of discovery sightings into one identity per device.
 *
 * Keyed on the espOS short id, because nothing else is stable. Verified on a
 * live network:
 *
 * - Two devices advertised the mDNS instance name `cockpit` at once, so the
 *   instance name cannot be a key.
 * - Every device appeared twice, once per host interface (eth0 + wlan0), so
 *   addresses must be unioned rather than replacing one another.
 * - The Signal K data model keys health paths on the device HOSTNAME
 *   (`espos.cockpit.*`), which only yields an id when the hostname is still
 *   the default `espos-<id>`.
 * - The short id equals the last two bytes of the base MAC
 *   (`aa:bb:cc:dd:2b:e9` -> `2be9`), which gives a free consistency check.
 */

import type {
  DeviceId,
  DeviceIdentity,
  DiscoverySighting,
  SightingSource,
} from "../types.js";

export const DEFAULT_DEVICE_PORT = 80;

/** Lower is tried first when ordering a device's candidate addresses. */
const SOURCE_RANK: Record<SightingSource, number> = {
  manual: 0,
  static: 1,
  mdns: 2,
  "sk-device": 3,
  "sk-model": 4,
};

export interface MergeResult {
  identities: Map<DeviceId, DeviceIdentity>;
  /** Sightings with no id — a host to probe once to learn which device it is. */
  unresolved: DiscoverySighting[];
  /** Human-readable oddities worth showing rather than swallowing. */
  warnings: string[];
}

/** True for a well-formed espOS short id. */
export function isDeviceId(value: string | undefined): value is DeviceId {
  return value !== undefined && /^[0-9a-f]{4}$/.test(value);
}

/**
 * Derive the short id from a MAC address, the way espOS does: the last two
 * bytes of the base MAC, lowercase hex, no separator.
 */
export function idFromMac(mac: string): DeviceId | undefined {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length < 4) return undefined;
  return hex.slice(-4);
}

/**
 * Extract a device id from a Signal K `espos.<segment>.*` path segment.
 * Returns undefined for a custom hostname, which can only be resolved by
 * probing the host itself.
 */
export function idFromSkSegment(segment: string): DeviceId | undefined {
  const prefixed = /^espos-([0-9a-f]{4})$/.exec(segment);
  if (prefixed?.[1] !== undefined) return prefixed[1];
  if (isDeviceId(segment)) return segment;
  return undefined;
}

/** Unwrap an IPv4-mapped IPv6 address (`::ffff:192.168.0.118`). */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address.trim());
  return mapped?.[1] ?? address.trim();
}

/** Parse a `host` or `host:port` entry from the static-hosts setting. */
export function parseHostEntry(entry: string): {
  host: string;
  port: number;
} | null {
  const trimmed = entry.trim();
  if (trimmed === "") return null;
  const withPort = /^(.+):(\d{1,5})$/.exec(trimmed);
  if (withPort?.[1] !== undefined && withPort[2] !== undefined) {
    const port = Number(withPort[2]);
    if (port > 0 && port <= 65535) return { host: withPort[1], port };
  }
  return { host: trimmed, port: DEFAULT_DEVICE_PORT };
}

/**
 * Order candidate addresses: the address that last answered first, then by
 * source quality, then most recently seen. Keeping the whole list (rather
 * than one "current" address) is what makes a DHCP move cost one failed
 * probe instead of a lost device.
 */
function orderAddresses(
  candidates: { address: string; source: SightingSource; seenAt: number }[],
  preferred: string | undefined,
): string[] {
  const best = new Map<
    string,
    { address: string; source: SightingSource; seenAt: number }
  >();
  for (const candidate of candidates) {
    const existing = best.get(candidate.address);
    if (
      existing === undefined ||
      SOURCE_RANK[candidate.source] < SOURCE_RANK[existing.source] ||
      (SOURCE_RANK[candidate.source] === SOURCE_RANK[existing.source] &&
        candidate.seenAt > existing.seenAt)
    ) {
      best.set(candidate.address, candidate);
    }
  }
  const ordered = [...best.values()].sort((a, b) => {
    if (a.address === preferred) return -1;
    if (b.address === preferred) return 1;
    const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    return rank !== 0 ? rank : b.seenAt - a.seenAt;
  });
  return ordered.map((entry) => entry.address);
}

/**
 * Fold a batch of sightings into the previously known identities.
 *
 * Merging is additive: a device known from an earlier cycle keeps its
 * identity even with zero sightings now, so the UI shows it as offline
 * instead of silently dropping it.
 */
export function mergeSightings(
  sightings: DiscoverySighting[],
  previous: Map<DeviceId, DeviceIdentity>,
): MergeResult {
  const warnings: string[] = [];
  const unresolved: DiscoverySighting[] = [];
  const identities = new Map<DeviceId, DeviceIdentity>();

  // Seed from what we already knew, so an unseen device survives the cycle.
  const addressPool = new Map<
    DeviceId,
    { address: string; source: SightingSource; seenAt: number }[]
  >();
  for (const [id, identity] of previous) {
    identities.set(id, { ...identity, sources: { ...identity.sources } });
    addressPool.set(
      id,
      identity.addresses.map((address) => ({
        address,
        source: "manual" as SightingSource,
        seenAt: 0,
      })),
    );
  }
  // The previously preferred address per device, to keep it first.
  const preferred = new Map<DeviceId, string>();
  for (const [id, identity] of previous) {
    const first = identity.addresses[0];
    if (first !== undefined) preferred.set(id, first);
  }

  for (const sighting of sightings) {
    let id = sighting.id;

    // A MAC gives us an id even when the source did not supply one, and
    // cross-checks one that was.
    if (sighting.mac !== undefined) {
      const derived = idFromMac(sighting.mac);
      if (derived !== undefined) {
        if (id === undefined) {
          id = derived;
        } else if (id !== derived) {
          // Either a cloned firmware or a merge bug. Never silently unify.
          warnings.push(
            `device ${id} reports MAC ${sighting.mac}, whose last two bytes ` +
              `are ${derived} — treating them as different devices`,
          );
        }
      }
    }

    if (!isDeviceId(id)) {
      unresolved.push(sighting);
      continue;
    }

    const existing = identities.get(id);
    const identity: DeviceIdentity = existing ?? {
      id,
      addresses: [],
      port: sighting.port ?? DEFAULT_DEVICE_PORT,
      sources: {},
    };

    if (sighting.host !== undefined && sighting.host !== "") {
      identity.hostname = sighting.host.replace(/\.local\.?$/i, "");
    }
    if (sighting.mac !== undefined) identity.mac = sighting.mac;
    if (sighting.port !== undefined) identity.port = sighting.port;
    identity.sources[sighting.source] = sighting.seenAt;

    const pool = addressPool.get(id) ?? [];
    for (const raw of sighting.addresses ?? []) {
      const address = normalizeAddress(raw);
      if (address !== "") {
        pool.push({
          address,
          source: sighting.source,
          seenAt: sighting.seenAt,
        });
      }
    }
    addressPool.set(id, pool);
    identities.set(id, identity);
  }

  for (const [id, identity] of identities) {
    identity.addresses = orderAddresses(
      addressPool.get(id) ?? [],
      preferred.get(id),
    );
  }

  return { identities, unresolved, warnings };
}

/**
 * Attribute Signal K `espos.<segment>` subtrees to device ids.
 *
 * Two devices whose hostnames collide land on the same subtree; espOS keys
 * these paths on the hostname rather than the id, so the data model genuinely
 * cannot tell them apart. We refuse to attribute an ambiguous subtree to
 * either device rather than showing one of them wrong data.
 */
export function attributeSkSegments(
  segments: string[],
  knownHostnames: Map<string, DeviceId[]>,
): { attributed: Map<string, DeviceId>; warnings: string[] } {
  const attributed = new Map<string, DeviceId>();
  const warnings: string[] = [];

  for (const segment of segments) {
    const direct = idFromSkSegment(segment);
    if (direct !== undefined) {
      attributed.set(segment, direct);
      continue;
    }
    const candidates = knownHostnames.get(segment) ?? [];
    if (candidates.length === 1 && candidates[0] !== undefined) {
      attributed.set(segment, candidates[0]);
    } else if (candidates.length > 1) {
      warnings.push(
        `Signal K path espos.${segment}.* could belong to any of ` +
          `${candidates.join(", ")} — these devices share a hostname, so ` +
          `their health data cannot be told apart`,
      );
    }
  }
  return { attributed, warnings };
}
