/**
 * Domain records to wire DTOs.
 *
 * Pure, and deliberately narrow: keys never appear in any response, only
 * whether one is held. An admin session is powerful enough already.
 */

import type { KeyStore } from "../device/auth.js";
import { PUBLIC_FW_BASE } from "../config.js";
import { isProvisionalId } from "../fleet/poller.js";
import { manifestPathFor } from "../mirror/manifest.js";
import { needsOtaRepair } from "../ota/configure.js";
import type { DeviceRecord } from "../types.js";

export interface DeviceDto {
  id: string;
  /** False when the plugin invented the id because mDNS has not named it. */
  identified: boolean;
  hostname?: string;
  addresses: string[];
  port: number;
  reachability: DeviceRecord["reachability"];
  auth: DeviceRecord["auth"];
  hasKey: boolean;
  lockedOutUntil?: string;
  lastSeenAt: string;
  lastOkProbeAt?: string;
  lastError?: string;
  project?: string;
  app?: string;
  version?: string;
  esposVersion?: string;
  target?: string;
  board?: string;
  chip?: string;
  mac?: string;
  flashBytes?: number;
  psramBytes?: number;
  uptimeS?: number;
  freeHeap?: number;
  otaState?: string;
  otaError?: string;
  manifestUrl?: string;
  /** True when this device is looking for updates somewhere it cannot read. */
  otaNeedsRepair?: boolean;
  /** Plain-language reason, for the UI to show beside a repair button. */
  otaRepairReason?: string;
  sources: string[];
}

function iso(value: number | undefined): string | undefined {
  return value === undefined || value === 0
    ? undefined
    : new Date(value).toISOString();
}

export function serializeDevice(
  record: DeviceRecord,
  keys?: KeyStore,
): DeviceDto {
  const snapshot = record.snapshot;
  const info = snapshot?.info;
  return {
    id: record.identity.id,
    identified: !isProvisionalId(record.identity.id),
    hostname: record.identity.hostname,
    addresses: record.identity.addresses,
    port: record.identity.port,
    reachability: record.reachability,
    auth: record.auth,
    hasKey: keys?.hasKey(record.identity.id) ?? false,
    lockedOutUntil: iso(record.lockedOutUntil),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    lastOkProbeAt: iso(record.lastOkProbeAt),
    lastError: record.lastError,
    project: record.project,
    app: snapshot?.app,
    version: snapshot?.version,
    // Only mDNS reports this; /system/info does not carry it.
    esposVersion: snapshot?.esposVersion,
    target: snapshot?.target ?? snapshot?.ota?.running?.target,
    board: snapshot?.board ?? info?.hardware?.board,
    chip: info?.chip,
    // Hardware the device measures about itself. Worth surfacing because
    // "which board is this and what is in it" is the first question when
    // a panel misbehaves, and the alternative is curl plus a datasheet.
    mac: info?.hardware?.mac,
    flashBytes: info?.hardware?.flashBytes,
    psramBytes: info?.hardware?.ramPsramBytes,
    uptimeS: info?.uptimeS,
    freeHeap: info?.freeHeap,
    otaState: snapshot?.ota?.state,
    otaError: snapshot?.ota?.lastError,
    manifestUrl: snapshot?.ota?.manifest?.url,
    ...otaRepair(record),
    sources: Object.keys(record.identity.sources),
  };
}

/**
 * Whether this device can actually reach an update manifest.
 *
 * Only decidable once we know which firmware it runs, because the expected
 * path is per-application. A device that has not reported its app yet is left
 * unflagged rather than accused.
 */
function otaRepair(record: DeviceRecord): {
  otaNeedsRepair?: boolean;
  otaRepairReason?: string;
} {
  const app = record.snapshot?.app;
  const manifest = record.snapshot?.ota?.manifest;
  if (app === undefined || manifest === undefined) return {};
  const expected = manifestPathFor(app, PUBLIC_FW_BASE);
  // The device reports the ASSEMBLED url, so compare on the path portion.
  const reportedPath = pathOf(manifest.url);
  const result = needsOtaRepair(
    reportedPath === expected ? "signalk" : "url",
    reportedPath,
    manifest.url,
    expected,
  );
  return result.needed
    ? { otaNeedsRepair: true, otaRepairReason: result.reason }
    : { otaNeedsRepair: false };
}

/** The path part of a URL, or the input when it is already a path. */
function pathOf(url: string | undefined): string | undefined {
  if (url === undefined || url === "") return url;
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export interface FleetDto {
  devices: DeviceDto[];
  summary: {
    total: number;
    online: number;
    offline: number;
    needKey: number;
    updatesAvailable: number;
  };
  warnings: string[];
}

export function serializeFleet(
  records: DeviceRecord[],
  warnings: string[],
  keys?: KeyStore,
): FleetDto {
  const devices = records.map((record) => serializeDevice(record, keys));
  return {
    devices,
    summary: {
      total: devices.length,
      online: devices.filter((d) => d.reachability === "online").length,
      offline: devices.filter((d) => d.reachability === "offline").length,
      needKey: devices.filter((d) => d.auth === "needs-key").length,
      updatesAvailable: records.filter((r) => r.update !== undefined).length,
    },
    warnings,
  };
}
