/**
 * The demo fleet: three virtual devices for a public showcase server, where a
 * visitor without an administrator login should see what the manager does.
 *
 * Built as the records a poll would have produced, so every serializer and
 * route downstream runs unchanged. Versions come from the registry index, so
 * the demo grows with it: two devices run the newest release, one the
 * release before, which is what makes an update show up.
 *
 * Addresses are from the documentation range (RFC 5737) and MACs are
 * locally administered: nothing here names a real boat or a real board.
 */

import { PUBLIC_FW_BASE } from "../config.js";
import { manifestPathFor } from "../mirror/manifest.js";
import { compareVersions } from "../mirror/version.js";
import { matchDevice, projectForApp } from "../registry/resolve.js";
import type { RegistryIndex } from "../registry/types.js";
import type { DeviceRecord, DeviceSnapshot, UpdateOffer } from "../types.js";

export interface DemoDevice {
  id: string;
  hostname: string;
  /** The firmware's app name, as the registry's `app` spells it. */
  app: string;
  chip: string;
  chipRevision: number;
  cores: number;
  cpuMhz: number;
  /** What the firmware reports as its board, when it declares one. */
  board?: string;
  address: string;
  mac: string;
  flashBytes: number;
  flashPhysicalBytes: number;
  ramInternalBytes: number;
  ramPsramBytes: number;
  features: string[];
  /** Seconds of uptime at plugin start. */
  uptimeS: number;
  /** Releases behind the newest: 0 is current, 1 shows an update. */
  behind: number;
  coprocessor?: { version: string; hostVersion: string; target: string };
}

export const DEMO_DEVICES: readonly DemoDevice[] = [
  {
    id: "espos-cockpit",
    hostname: "espos-cockpit",
    app: "cockpit",
    chip: "esp32p4",
    chipRevision: 100,
    cores: 2,
    cpuMhz: 360,
    board: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B",
    address: "192.0.2.21",
    mac: "02:00:5e:20:00:01",
    flashBytes: 16 * 1024 * 1024,
    flashPhysicalBytes: 32 * 1024 * 1024,
    ramInternalBytes: 768 * 1024,
    ramPsramBytes: 32 * 1024 * 1024,
    features: ["wifi", "ble"],
    uptimeS: 3 * 86400 + 4 * 3600 + 17 * 60,
    behind: 0,
    coprocessor: { version: "2.6.3", hostVersion: "2.6.3", target: "esp32c6" },
  },
  {
    id: "espos-engine-room",
    hostname: "espos-engine-room",
    app: "ble_gateway",
    chip: "esp32c5",
    chipRevision: 100,
    cores: 1,
    cpuMhz: 240,
    address: "192.0.2.22",
    mac: "02:00:5e:20:00:02",
    flashBytes: 16 * 1024 * 1024,
    flashPhysicalBytes: 16 * 1024 * 1024,
    ramInternalBytes: 384 * 1024,
    ramPsramBytes: 8 * 1024 * 1024,
    features: ["wifi", "ble", "802.15.4"],
    uptimeS: 11 * 86400 + 2 * 3600 + 41 * 60,
    behind: 1,
  },
  {
    id: "espos-zigbee",
    hostname: "espos-zigbee",
    app: "zigbee_coordinator",
    chip: "esp32c5",
    chipRevision: 100,
    cores: 1,
    cpuMhz: 240,
    address: "192.0.2.23",
    mac: "02:00:5e:20:00:03",
    flashBytes: 16 * 1024 * 1024,
    flashPhysicalBytes: 16 * 1024 * 1024,
    ramInternalBytes: 384 * 1024,
    ramPsramBytes: 8 * 1024 * 1024,
    features: ["wifi", "ble", "802.15.4"],
    uptimeS: 6 * 86400 + 19 * 3600 + 5 * 60,
    behind: 0,
  },
];

/** Shown when the index has no release for a device's app (offline, first start). */
const FALLBACK_VERSION = "1.0.0";

/** The stable versions the index lists for an app, newest first. */
function stableVersions(index: RegistryIndex, app: string): string[] {
  const project = projectForApp(index, app);
  return (project?.releases ?? [])
    .filter((release) => release.channel === "stable")
    .map((release) => release.version)
    .sort((a, b) => compareVersions(b, a));
}

export function demoVersion(index: RegistryIndex, device: DemoDevice): string {
  const versions = stableVersions(index, device.app);
  return (
    versions[Math.min(device.behind, versions.length - 1)] ?? FALLBACK_VERSION
  );
}

/**
 * The record a successful poll of this device would leave, at `now`.
 * `startedAt` is when the demo began, so uptime keeps counting.
 */
export function demoRecord(
  device: DemoDevice,
  index: RegistryIndex,
  boardId: string | undefined,
  startedAt: number,
  now: number,
): DeviceRecord {
  const project = projectForApp(index, device.app);
  const version = demoVersion(index, device);
  const keyFp = project?.signingKeyId;
  const snapshot: DeviceSnapshot = {
    probedAt: now,
    app: device.app,
    version,
    target: device.chip,
    board: device.board,
    authRequired: false,
    info: {
      app: device.app,
      version,
      chip: device.chip,
      chipRevision: device.chipRevision,
      cores: device.cores,
      uptimeS: device.uptimeS + Math.round((now - startedAt) / 1000),
      freeHeap: 212_000,
      resetReason: "power_on",
      hardware: {
        mac: device.mac,
        cpuMhz: device.cpuMhz,
        flashBytes: device.flashBytes,
        flashPhysicalBytes: device.flashPhysicalBytes,
        flashPartitionedBytes: device.flashBytes - 0x10000,
        ramInternalBytes: device.ramInternalBytes,
        ramPsramBytes: device.ramPsramBytes,
        features: device.features,
        board: device.board,
        coprocessor:
          device.coprocessor === undefined
            ? undefined
            : { ...device.coprocessor, stale: false },
      },
    },
    // Pointed at this server's manifest, as the manager sets a device up,
    // so no "not set up for updates" warning shows on a demo device.
    otaConfig: {
      manifestSrc: "signalk",
      manifestPath: manifestPathFor(device.app, PUBLIC_FW_BASE, boardId),
    },
    ota: {
      state: "idle",
      running: {
        version,
        project: device.app,
        target: device.chip,
        slot: "ota_0",
        pendingVerify: false,
        confirmed: true,
        rolledBack: false,
        keyFp,
      },
      manifest: { url: "", channel: "stable", autoCheck: true },
    },
  };

  let update: UpdateOffer | undefined;
  if (project !== undefined) {
    const match = matchDevice(project, {
      app: device.app,
      target: device.chip,
      board: device.board,
      runningVersion: version,
      channel: "stable",
      keyFp,
    });
    if (match.build !== undefined && !match.requiresUsb) {
      update = {
        projectId: project.id,
        fromVersion: version,
        toVersion: match.build.version,
        channel: match.build.channel,
        otaUrl: match.build.otaUrl,
        mirrored: false,
        sizeBytes: match.build.otaBytes,
        sha256: match.build.otaSha256,
        notes: match.build.notes,
      };
    }
  }

  return {
    identity: {
      id: device.id,
      hostname: device.hostname,
      mac: device.mac,
      addresses: [device.address],
      port: 80,
      sources: { mdns: now },
    },
    reachability: "online",
    auth: "open",
    lastSeenAt: now,
    lastOkProbeAt: now,
    consecutiveFailures: 0,
    snapshot,
    project: project?.id,
    update,
  };
}

/** The demo device with this id, if any. */
export function demoDevice(id: string): DemoDevice | undefined {
  return DEMO_DEVICES.find((device) => device.id === id);
}
