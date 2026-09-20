/**
 * Pure resolution: registry entries plus a device's identity to the build that
 * device should be offered.
 *
 * The rule that governs everything here is that guessing is worse than
 * declining. A build offered to the wrong target is an image the device rejects
 * after pulling it over boat wifi; a build offered for the wrong board variant
 * is a black screen. So an asset whose target cannot be established is skipped
 * and reported, never assumed.
 */

import { compareVersions, isReleaseVersion } from "../mirror/manifest.js";
import type { AppName, Channel, Target } from "../types.js";
import type {
  RegistryBuild,
  RegistryIndex,
  RegistryProject,
  RegistryRelease,
  ResolvedBuild,
} from "./types.js";

/** Known IDF targets, longest first so `esp32c6` wins over `esp32`. */
const KNOWN_TARGETS: readonly Target[] = [
  "esp32c61",
  "esp32c2",
  "esp32c3",
  "esp32c5",
  "esp32c6",
  "esp32h2",
  "esp32p4",
  "esp32s2",
  "esp32s3",
  "esp32",
];

/**
 * Infer a build's target from an asset name.
 *
 * Returns undefined rather than a guess when the name carries no target: the
 * cockpit's real assets are named `p4_cockpit-v1.2.0-ota.bin`, where `p4` is
 * part of the project name and not a reliable target marker.
 */
export function targetFromAssetName(name: string): Target | undefined {
  const lower = name.toLowerCase();
  for (const target of KNOWN_TARGETS) {
    // Require a separator so "esp32" inside "esp32p4" cannot match.
    const pattern = new RegExp(`(^|[^a-z0-9])${target}([^a-z0-9]|$)`);
    if (pattern.test(lower)) return target;
  }
  return undefined;
}

export interface MatchDeviceOptions {
  app: AppName;
  target?: Target;
  board?: string;
  runningVersion: string;
  channel: Channel;
  /** The key fingerprint the device trusts, when the firmware reports one. */
  keyFp?: string;
  includePrerelease?: boolean;
}

export interface MatchResult {
  build?: ResolvedBuild;
  /** Why no build was offered, for the UI to show instead of silence. */
  reason?: string;
  /** True when installing this needs a USB cable, not an OTA. */
  requiresUsb?: boolean;
  /**
   * True when the running version is not a known release (a git-describe
   * build), so "newer" is a downgrade in practice and needs confirmation.
   */
  needsConfirmation?: boolean;
}

/** Find the project in an index that serves a device's application. */
export function projectForApp(
  index: RegistryIndex,
  app: AppName,
): RegistryProject | undefined {
  return index.projects.find((project) => project.app === app);
}

function channelAllows(
  release: RegistryRelease,
  wanted: Channel,
  includePrerelease: boolean,
): boolean {
  if (release.channel === wanted) return true;
  // Opting into prereleases means beta is acceptable while on stable.
  return includePrerelease && release.channel === "beta";
}

function buildForTarget(
  release: RegistryRelease,
  target: Target | undefined,
  board: string | undefined,
): RegistryBuild | undefined {
  const candidates = release.builds.filter(
    (build) => target === undefined || build.target === target,
  );
  if (candidates.length === 0) return undefined;
  // A build naming this exact board wins over a board-agnostic one.
  const exact = candidates.find(
    (build) => board !== undefined && build.boardId === board,
  );
  if (exact !== undefined) return exact;
  const agnostic = candidates.find((build) => build.boardId === undefined);
  if (agnostic !== undefined) return agnostic;
  // Only board-specific builds, none of them this board: declining is right.
  return undefined;
}

/**
 * Decide what to offer one device.
 *
 * Returns a reason rather than an empty result whenever something is
 * deliberately withheld, so the UI can explain itself.
 */
export function matchDevice(
  project: RegistryProject,
  options: MatchDeviceOptions,
): MatchResult {
  if (project.deprecated === true || typeof project.deprecated === "string") {
    const why =
      typeof project.deprecated === "string"
        ? project.deprecated
        : "this project is no longer maintained";
    return { reason: why };
  }

  const releases = (project.releases ?? []).filter((release) =>
    channelAllows(release, options.channel, options.includePrerelease ?? false),
  );
  if (releases.length === 0) {
    return {
      reason:
        project.releases === undefined || project.releases.length === 0
          ? "this project has not published any firmware yet"
          : `no ${options.channel} release is available`,
    };
  }

  // Newest first.
  const ordered = [...releases].sort((a, b) =>
    compareVersions(b.version, a.version),
  );

  for (const release of ordered) {
    const build = buildForTarget(release, options.target, options.board);
    if (build === undefined) continue;
    if (build.otaUrl === undefined) {
      // A release with only a full-flash image cannot be installed over the
      // air; saying so beats silently skipping it.
      return {
        reason: `${release.version} ships no over-the-air image — it must be flashed over USB`,
        requiresUsb: true,
      };
    }
    if (compareVersions(release.version, options.runningVersion) <= 0) {
      return { reason: "this device is up to date" };
    }

    const resolved: ResolvedBuild = {
      projectId: project.id,
      app: project.app,
      version: release.version,
      target: build.target,
      channel: release.channel,
      boardId: build.boardId,
      otaUrl: build.otaUrl,
      otaBytes: build.otaBytes,
      otaSha256: build.otaSha256,
      mergedUrl: build.mergedUrl,
      mergedBytes: build.mergedBytes,
      notes: release.notes,
      notesUrl: release.notesUrl,
      publishedAt: release.publishedAt,
      unsigned: build.unsigned,
    };

    // A device only accepts an image signed with the key it was flashed with,
    // so a key mismatch means USB, not OTA. Only decidable when both sides
    // report a fingerprint; unknown is reported as unknown, not as safe.
    const keyMismatch =
      options.keyFp !== undefined &&
      project.signingKeyId !== undefined &&
      options.keyFp !== project.signingKeyId;

    return {
      build: resolved,
      requiresUsb: keyMismatch || build.unsigned === true,
      reason: keyMismatch
        ? "this device trusts a different signing key, so the update must be " +
          "flashed over USB"
        : build.unsigned === true
          ? "this build is unsigned and will not be accepted over the air"
          : undefined,
      // A git-describe running version compares below its own release, so the
      // "update" would be a downgrade unless the user says otherwise.
      needsConfirmation: !isReleaseVersion(options.runningVersion),
    };
  }

  return {
    reason:
      options.target === undefined
        ? "this device has not reported which chip it runs"
        : `no ${options.channel} build for ${options.target}`,
  };
}

/** Merge several indexes by project id, first one winning. */
export function mergeIndexes(
  sources: { url: string; index: RegistryIndex }[],
): { index: RegistryIndex; warnings: string[] } {
  const byId = new Map<string, RegistryProject>();
  const byApp = new Map<AppName, string>();
  const warnings: string[] = [];

  for (const source of sources) {
    for (const project of source.index.projects) {
      if (byId.has(project.id)) {
        warnings.push(
          `ignored a second entry for ${project.id} from ${source.url}`,
        );
        continue;
      }
      const owner = byApp.get(project.app);
      if (owner !== undefined) {
        // Two projects claiming one app name would fight over the same
        // manifest, since a manifest serves exactly one app.
        warnings.push(
          `${project.id} and ${owner} both claim the application name ` +
            `"${project.app}" — only ${owner} will be offered`,
        );
        continue;
      }
      byId.set(project.id, project);
      byApp.set(project.app, project.id);
    }
  }

  return {
    index: { schema: 1, projects: [...byId.values()] },
    warnings,
  };
}
