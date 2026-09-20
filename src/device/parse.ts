/**
 * Tolerant parsers for espOS REST payloads.
 *
 * Every field is optional except the few verified present on the oldest
 * firmware in the field (0.7.x). Rationale, from probing live devices:
 *
 * - 0.7.x has NO `hardware` block; 0.10.0+ does.
 * - 0.7.x carries fields absent from the docs (`min_free_heap`,
 *   `schema_etag`, `ui_storage`).
 *
 * So a strict schema would reject devices that are working fine. A parser
 * that drops what it does not recognise and keeps what it does is the only
 * version that survives a mixed-firmware boat.
 */

import type {
  AppName,
  DeviceOtaState,
  HardwareInfo,
  OtaStatus,
  SystemInfo,
} from "../types.js";
import type { PingResult } from "./client.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return items.length > 0 ? items : undefined;
}

const OTA_STATES: readonly DeviceOtaState[] = [
  "idle",
  "checking",
  "available",
  "downloading",
  "verifying",
  "ready",
  "failed",
];

function otaState(value: unknown): DeviceOtaState {
  const text = str(value);
  return text !== undefined && (OTA_STATES as readonly string[]).includes(text)
    ? (text as DeviceOtaState)
    : "idle";
}

/**
 * `GET /api/v1/system/ping` — the public probe. `app` and `version` are the
 * contract; `auth` tells us whether protected endpoints need a key.
 */
export function parsePing(raw: unknown): PingResult {
  const body = asRecord(raw);
  const app = str(body.app);
  const version = str(body.version);
  if (app === undefined || version === undefined) {
    throw new Error("ping response is missing app or version");
  }
  return {
    app,
    version,
    // Absent means no auth: espOS only added the field when it gained auth.
    authRequired: bool(body.auth) ?? false,
  };
}

function parseHardware(raw: unknown): HardwareInfo | undefined {
  const body = asRecord(raw);
  if (Object.keys(body).length === 0) return undefined;
  const hardware: HardwareInfo = {
    mac: str(body.mac),
    cpuMhz: num(body.cpu_mhz),
    flashBytes: num(body.flash_bytes),
    ramInternalBytes: num(body.ram_internal_bytes),
    ramPsramBytes: num(body.ram_psram_bytes),
    features: strArray(body.features),
    board: str(body.board),
  };
  return Object.values(hardware).some((value) => value !== undefined)
    ? hardware
    : undefined;
}

/** `GET /api/v1/system/info` (protected). */
export function parseSystemInfo(raw: unknown): SystemInfo {
  const body = asRecord(raw);
  return {
    app: str(body.app),
    version: str(body.version),
    // Verified absent on every 0.7.x/0.9.x device probed: /system/info does
    // NOT report the espOS version — only the mDNS TXT `espos` key does. Read
    // here anyway in case a later firmware adds it, but the Fleet view must
    // take this value from discovery, not from info.
    esposVersion: str(body.espos_version) ?? str(body.espos),
    idfVersion: str(body.idf_version),
    chip: str(body.chip),
    chipRevision: num(body.chip_revision),
    cores: num(body.cores),
    uptimeS: num(body.uptime_s),
    freeHeap: num(body.free_heap),
    resetReason: str(body.reset_reason),
    hardware: parseHardware(body.hardware),
  };
}

/** `GET /api/v1/ota/status` (protected). */
export function parseOtaStatus(raw: unknown): OtaStatus {
  const body = asRecord(raw);
  const running = asRecord(body.running);
  const manifest = asRecord(body.manifest);
  const progress = asRecord(body.progress);
  const availableRaw = body.available;

  const received = num(progress.received);
  const total = num(progress.total);

  let available: OtaStatus["available"] = null;
  if (typeof availableRaw === "object" && availableRaw !== null) {
    const entry = asRecord(availableRaw);
    const version = str(entry.version);
    const url = str(entry.url);
    if (version !== undefined && url !== undefined) {
      available = {
        version,
        url,
        size: num(entry.size),
        sha256: str(entry.sha256),
        notes: str(entry.notes),
        newer: bool(entry.newer),
      };
    }
  }

  return {
    state: otaState(body.state),
    running: {
      version: str(running.version),
      project: str(running.project) as AppName | undefined,
      target: str(running.target),
      slot: str(running.slot),
      pendingVerify: bool(running.pending_verify),
      confirmed: bool(running.confirmed),
      rolledBack: bool(running.rolled_back),
      keyFp: str(running.key_fp),
    },
    manifest: {
      url: str(manifest.url),
      channel: str(manifest.channel),
      autoCheck: bool(manifest.auto_check),
      autoInstall: bool(manifest.auto_install),
    },
    progress:
      received !== undefined && total !== undefined
        ? { received, total }
        : undefined,
    available,
    lastError: str(body.last_error),
  };
}
