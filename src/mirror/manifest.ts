/**
 * Generate the OTA manifest an espOS device parses.
 *
 * Every limit here was read out of the firmware, not guessed, because each one
 * truncates silently rather than erroring:
 *
 * - `espos_ota.c do_check()` assembles the manifest URL into `char url[168]`
 *   and reads `ota.manifest_path` into `char path[128]`.
 * - `espos_ota_manifest.h` caps a build's version at 32 bytes, its url at 256
 *   and its notes at 128, each including the NUL.
 * - `espos_ota_manifest_pick()` matches the manifest's top-level `app` against
 *   `esp_app_desc_t.project_name` with strcmp, so one manifest serves exactly
 *   one application.
 * - `espos_ota_resolve_url()` resolves a leading-slash url against scheme and
 *   host only, which is why build urls are emitted root-relative: the device
 *   then reaches them whatever address it used for the manifest itself.
 *
 * A manifest that busts a limit is worse than no manifest, so generation
 * reports what it dropped instead of emitting something the device will
 * quietly mangle.
 */

import type { AppName, Channel, Target } from "../types.js";

/** `char version[32]`, NUL included. */
export const MAX_VERSION_BYTES = 31;
/** `char url[256]` for a resolved build url, NUL included. */
export const MAX_BUILD_URL_BYTES = 255;
/** `char notes[128]`, NUL included. */
export const MAX_NOTES_BYTES = 127;
/** `char url[168]` for the assembled manifest URL, NUL included. */
export const MAX_MANIFEST_URL_BYTES = 167;
/** `char path[128]` for ota.manifest_path, NUL included. */
export const MAX_MANIFEST_PATH_BYTES = 127;
/**
 * The device reads the manifest into a bounded buffer. Keep a wide margin:
 * an over-long manifest fails wholesale, taking every device with it.
 */
export const MAX_MANIFEST_BYTES = 16 * 1024;

export interface ManifestBuildInput {
  version: string;
  target: Target;
  channel: Channel;
  /** Root-relative (preferred) or absolute. */
  url: string;
  size?: number;
  sha256?: string;
  notes?: string;
  /** ISO date; only the calendar part is emitted. */
  date?: string;
}

export interface ManifestBuild {
  version: string;
  target: Target;
  channel: Channel;
  url: string;
  size?: number;
  sha256?: string;
  notes?: string;
  date?: string;
}

export interface EsposManifest {
  schema: 1;
  app: AppName;
  builds: ManifestBuild[];
}

export interface GenerateResult {
  manifest: EsposManifest;
  json: string;
  /** Things a maintainer needs to know: dropped builds, truncated notes. */
  warnings: string[];
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Truncate to a byte budget without splitting a multi-byte character —
 * truncation on the device is a byte operation, and half a character would
 * make the JSON invalid.
 */
export function truncateBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const buf = Buffer.from(value, "utf8");
  let end = maxBytes;
  // Step back off a continuation byte (0b10xxxxxx).
  while (end > 0 && (buf[end] ?? 0) >= 0x80 && (buf[end] ?? 0) < 0xc0) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/** Newest first, using the same ordering rules the device applies. */
function compareVersionsDesc(a: string, b: string): number {
  return compareVersions(b, a);
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

/** Byte-wise comparison, as C's strcmp does it (not locale-aware). */
function strcmp(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const cmp = Buffer.compare(ba, bb);
  return cmp;
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

/**
 * Build the manifest for one application.
 *
 * Builds are emitted newest-first per target and channel, trimmed until the
 * document fits the device's buffer.
 */
export function generateManifest(
  app: AppName,
  builds: ManifestBuildInput[],
): GenerateResult {
  const warnings: string[] = [];
  const usable: ManifestBuild[] = [];

  for (const build of builds) {
    const version = build.version.replace(/^v/, "");
    if (byteLength(version) > MAX_VERSION_BYTES) {
      warnings.push(
        `dropped ${app} ${build.version} (${build.target}): the version is ` +
          `${byteLength(version)} bytes and the device stores ${MAX_VERSION_BYTES}`,
      );
      continue;
    }
    if (byteLength(build.url) > MAX_BUILD_URL_BYTES) {
      warnings.push(
        `dropped ${app} ${version} (${build.target}): the firmware URL is ` +
          `${byteLength(build.url)} bytes and the device stores ${MAX_BUILD_URL_BYTES}`,
      );
      continue;
    }

    let notes = build.notes?.replace(/\s+/g, " ").trim();
    if (notes !== undefined && byteLength(notes) > MAX_NOTES_BYTES) {
      notes = truncateBytes(notes, MAX_NOTES_BYTES - 1).trimEnd() + "…";
      // Re-check: the ellipsis is three bytes in UTF-8.
      if (byteLength(notes) > MAX_NOTES_BYTES) {
        notes = truncateBytes(notes, MAX_NOTES_BYTES);
      }
      warnings.push(
        `truncated the release notes for ${app} ${version} to ` +
          `${MAX_NOTES_BYTES} bytes`,
      );
    }

    const entry: ManifestBuild = {
      version,
      target: build.target,
      channel: build.channel,
      url: build.url,
    };
    if (build.size !== undefined && Number.isFinite(build.size)) {
      entry.size = Math.trunc(build.size);
    }
    if (build.sha256 !== undefined && /^[0-9a-f]{64}$/.test(build.sha256)) {
      entry.sha256 = build.sha256;
    }
    if (notes !== undefined && notes !== "") entry.notes = notes;
    const date = build.date?.slice(0, 10);
    if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      entry.date = date;
    }
    usable.push(entry);
  }

  // Newest first within each target+channel, so trimming drops the oldest.
  usable.sort((a, b) => {
    const t = a.target.localeCompare(b.target);
    if (t !== 0) return t;
    const c = a.channel.localeCompare(b.channel);
    if (c !== 0) return c;
    return compareVersionsDesc(a.version, b.version);
  });

  let kept = [...usable];
  let manifest: EsposManifest = { schema: 1, app, builds: kept };
  let json = JSON.stringify(manifest);

  while (byteLength(json) > MAX_MANIFEST_BYTES && kept.length > 1) {
    // Drop the oldest build overall, never the newest of any target.
    const newestPerGroup = new Set<ManifestBuild>();
    for (const build of kept) {
      const key = `${build.target}|${build.channel}`;
      if (
        ![...newestPerGroup].some((b) => `${b.target}|${b.channel}` === key)
      ) {
        newestPerGroup.add(build);
      }
    }
    const droppable = kept.filter((b) => !newestPerGroup.has(b));
    const victim = droppable.at(-1) ?? kept.at(-1);
    if (victim === undefined) break;
    kept = kept.filter((b) => b !== victim);
    warnings.push(
      `dropped ${app} ${victim.version} (${victim.target}) to keep the ` +
        `manifest under ${MAX_MANIFEST_BYTES} bytes`,
    );
    manifest = { schema: 1, app, builds: kept };
    json = JSON.stringify(manifest);
  }

  return { manifest, json, warnings };
}

/**
 * The public path a device fetches an application's manifest from, and the
 * value written to `ota.manifest_path`.
 */
export function manifestPathFor(app: AppName, base: string): string {
  return `${base}/${encodeURIComponent(app)}/manifest.json`;
}

/** Root-relative firmware URL, resolved by the device against scheme+host. */
export function firmwareUrlFor(
  app: AppName,
  version: string,
  filename: string,
  base: string,
): string {
  return `${base}/${encodeURIComponent(app)}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}`;
}

/**
 * Check a manifest path against what the device can actually hold, given the
 * address it will use to reach this server. Returns a reason when it will not
 * fit, so the caller can refuse rather than configure a silent truncation.
 */
export function manifestUrlFits(
  origin: string,
  path: string,
): { ok: true } | { ok: false; reason: string } {
  const pathBytes = byteLength(path);
  if (pathBytes > MAX_MANIFEST_PATH_BYTES) {
    return {
      ok: false,
      reason:
        `the manifest path is ${pathBytes} bytes and the device stores ` +
        `${MAX_MANIFEST_PATH_BYTES}`,
    };
  }
  const urlBytes = byteLength(`${origin.replace(/\/$/, "")}${path}`);
  if (urlBytes > MAX_MANIFEST_URL_BYTES) {
    return {
      ok: false,
      reason:
        `the manifest URL would be ${urlBytes} bytes via ${origin} and the ` +
        `device stores ${MAX_MANIFEST_URL_BYTES}`,
    };
  }
  return { ok: true };
}
