/*
 * Version comparison, exactly as the device does it.
 *
 * Split out of manifest.ts so the webapp can share it: that module also handles
 * byte-budget truncation and touches `Buffer`, which drags Node types into a
 * browser build. This file imports nothing at all.
 *
 * Sharing matters more than the file count. These functions were verified
 * against espOS's own `espos_ota_version_cmp` (components/espos_ota/src/
 * manifest.c) over 3000 random pairs, and a flasher that ordered versions
 * differently from the device that installs them would be a bug nobody would
 * think to look for.
 */

/**
 * Byte-wise comparison, as C's strcmp does it (not locale-aware).
 *
 * TextEncoder rather than Buffer: identical UTF-8 bytes, and it exists in both
 * Node and the browser, which is what lets the webapp share this file. The
 * ordering it must reproduce is C's -- unsigned bytes, and a prefix sorts below
 * the longer string -- so it compares bytes and then lengths rather than using
 * JavaScript's own `<`, which orders by UTF-16 code unit and disagrees above
 * the BMP.
 */
const utf8 = new TextEncoder();

function strcmp(a: string, b: string): number {
  const ba = utf8.encode(a);
  const bb = utf8.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (ba[i] as number) - (bb[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (ba.length === bb.length) return 0;
  return ba.length < bb.length ? -1 : 1;
}

/**
 * Compare two versions the way `espos_ota_version_cmp` does: a dotted numeric
 * core of up to four parts, a `-prerelease` suffix sorting BELOW the release
 * it qualifies, and a fallback to plain string comparison when the core does
 * not parse. Reimplemented here so the plugin and the device can never
 * disagree about which build is newer.
 */
export function compareVersions(a: string, b: string): number {
  // Mirrors parse_core(): an optional v/V, then up to four dot-separated
  // numbers, stopping at the first component that is not digit-dot-digit.
  // Whatever is left is `rest`, and it keeps its leading '-'.
  const parseCore = (
    value: string,
  ): { core: number[]; rest: string; count: number } => {
    let s = value;
    if (s.startsWith("v") || s.startsWith("V")) s = s.slice(1);
    const core: number[] = [0, 0, 0, 0];
    let count = 0;
    while (count < 4) {
      const m = /^\d+/.exec(s);
      if (m === null) break;
      core[count] = Number(m[0]);
      count += 1;
      s = s.slice(m[0].length);
      if (s.startsWith(".") && /^\d/.test(s.slice(1))) {
        s = s.slice(1);
      } else {
        break;
      }
    }
    return { core, rest: s, count };
  };

  const pa = parseCore(a);
  const pb = parseCore(b);
  // strcmp on the whole strings when either has no numeric core at all.
  if (pa.count === 0 || pb.count === 0) return strcmp(a, b);

  for (let i = 0; i < 4; i += 1) {
    const na = pa.core[i] ?? 0;
    const nb = pb.core[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  // Same core: a prerelease ("-...") is older than a release.
  const preA = pa.rest.startsWith("-");
  const preB = pb.rest.startsWith("-");
  if (preA !== preB) return preA ? -1 : 1;
  if (preA) return strcmp(pa.rest, pb.rest);
  return 0;
}

/** True when `candidate` is newer than `running`. */
export function isNewer(candidate: string, running: string): boolean {
  return compareVersions(candidate, running) > 0;
}

/**
 * True when a version string is a release rather than a development build.
 *
 * Devices in the field run git-describe versions such as
 * `1.1.0-12-g44590ce-dirty`, which compare BELOW `1.1.0`. Offering them
 * `1.1.0` is a downgrade wearing an update's clothes, so the caller must ask
 * before doing it.
 */
export function isReleaseVersion(version: string): boolean {
  return /^v?\d+(\.\d+){0,3}$/.test(version.trim());
}
