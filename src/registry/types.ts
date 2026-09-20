/**
 * The firmware registry: what a project entry looks like and what a resolved
 * build looks like.
 *
 * Shaped around what real releases actually contain rather than a convention
 * we wish they followed. As of 2026-09-20 the cockpit publishes
 * `p4_cockpit-v1.2.0-ota.bin` — no target segment — and the BLE gateway's
 * v0.2.0 release has no assets at all. Both must be describable: the first
 * because it is the only firmware anyone can install today, the second because
 * a project with nothing published yet is the normal state of a new entry, not
 * an error.
 */

import type { AppName, Channel, ProjectId, Target } from "../types.js";

/** A board a project supports, for matching and for the flasher's warnings. */
export interface RegistryBoard {
  id: string;
  target: Target;
  /** Human name, ideally the project's own Kconfig prompt. */
  name: string;
  /** Minimum flash size the image needs, in bytes. */
  flashMinBytes?: number;
  notes?: string;
  buyUrl?: string;
  /**
   * The string this board's firmware reports verbatim in
   * `/api/v1/system/info` -> `hardware.board` (espOS `opts.board`).
   *
   * A device reports a human name chosen by its firmware; the registry keys
   * builds by `id`. Only an explicit, exact mapping can join the two: names
   * are edited for readability and a fuzzy match would eventually install
   * firmware for a different display. Absent means the board cannot be
   * identified from a device's own report, and an update is withheld rather
   * than guessed.
   */
  reportedAs?: string;
}

/** How to find the firmware files in a release's asset list. */
export interface AssetPatterns {
  /** Anchored regex with a `version` group; `target` and `board` optional. */
  ota?: string;
  merged?: string;
}

export interface RegistryProject {
  id: ProjectId;
  /**
   * The device's runtime application name: the firmware's CMake `project()`
   * name, which is what espOS matches a manifest's `app` against and what
   * mDNS and /system/ping report. NOT the repository name.
   */
  app: AppName;
  name: string;
  summary?: string;
  description?: string;
  /** owner/repo on GitHub. */
  repo: string;
  homepage?: string;
  license?: string;
  targets: Target[];
  boards?: RegistryBoard[];
  channels?: Channel[];
  assets?: AssetPatterns;
  /**
   * Opaque identity of the signing key these releases use. A device only
   * accepts an image signed with the key it was flashed with, so a change here
   * strands every already-flashed device for OTA.
   */
  signingKeyId?: string;
  /** False when releases are built with a throwaway key (no future OTA). */
  signed?: boolean;
  /** True for projects maintained by the signalk-espOS organisation. */
  official?: boolean;
  deprecated?: boolean | string;
  screenshots?: string[];
  minEsposVersion?: string;
  /** Pre-resolved by the registry's CI so the plugin makes no API calls. */
  releases?: RegistryRelease[];
}

export interface RegistryRelease {
  version: string;
  tag: string;
  channel: Channel;
  publishedAt?: string;
  notes?: string;
  notesUrl?: string;
  builds: RegistryBuild[];
}

export interface RegistryBuild {
  target: Target;
  boardId?: string;
  otaUrl?: string;
  otaBytes?: number;
  otaSha256?: string;
  mergedUrl?: string;
  mergedBytes?: number;
  mergedSha256?: string;
  /** The image was built with a throwaway key: it will take no future OTA. */
  unsigned?: boolean;
}

export interface RegistryIndex {
  schema: 1;
  updated?: string;
  projects: RegistryProject[];
}

/** A build resolved for one device, ready to mirror and offer. */
export interface ResolvedBuild {
  projectId: ProjectId;
  app: AppName;
  version: string;
  target: Target;
  channel: Channel;
  boardId?: string;
  otaUrl: string;
  otaBytes?: number;
  otaSha256?: string;
  mergedUrl?: string;
  mergedBytes?: number;
  notes?: string;
  notesUrl?: string;
  publishedAt?: string;
  unsigned?: boolean;
  /** Where this entry came from, when several indexes are merged. */
  sourceUrl?: string;
}
