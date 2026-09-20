/**
 * Domain types shared across the plugin. No imports, no side effects — this
 * module is the vocabulary, not behaviour.
 */

/**
 * An espOS device's short id: four lowercase hex digits, advertised as the
 * `id` key of the _espos._tcp TXT record and equal to the last two bytes of
 * the base MAC. This is the ONLY stable primary key for a device:
 *
 * - mDNS instance names are not unique (two panels can both be `cockpit`),
 * - the hostname is user-settable and changes,
 * - the IP address moves with DHCP.
 */
export type DeviceId = string;

/** Registry project id, e.g. `cockpit`. */
export type ProjectId = string;

/**
 * The device's runtime application name: `esp_app_desc_t.project_name`, which
 * is the firmware's CMake `project()` name. It is what the mDNS `app` TXT key
 * and `GET /api/v1/system/ping` report, and what espOS matches an OTA
 * manifest's top-level `app` field against.
 *
 * Beware: it is NOT the repository name, NOT the release asset base name, and
 * NOT `espos_start_opts_t.app_name` (a Signal K access-request label). Live
 * examples: `cockpit`, `ble_gateway`.
 */
export type AppName = string;

/** ESP-IDF chip target, e.g. `esp32p4`, `esp32c6`. */
export type Target = string;

/** Release channel. */
export type Channel = "stable" | "beta";

/** Where a sighting of a device came from. */
export type SightingSource =
  "mdns" | "sk-model" | "sk-device" | "static" | "manual";

/** One observation of a device from one source at one moment. */
export interface DiscoverySighting {
  source: SightingSource;
  /** Date.now() when observed. */
  seenAt: number;
  /** Absent when the source cannot supply one (a custom mDNS hostname). */
  id?: DeviceId;
  /** Hostname or `<name>.local`, when known. */
  host?: string;
  /** IPv4 addresses, deduplicated across host interfaces. */
  addresses?: string[];
  port?: number;
  mac?: string;
  /** Parsed _espos._tcp TXT values. `auth` is deliberately absent: espOS
   * hardcodes it, so it is never trustworthy — probe /system/ping instead. */
  txt?: {
    v?: string;
    app?: AppName;
    espos?: string;
    target?: Target;
    board?: string;
    api?: string;
  };
}

/**
 * How current our knowledge of a device is.
 *
 * `offline` is a state, not an error: a device that is asleep, off, or out of
 * range must never turn the plugin red.
 */
export type Reachability = "online" | "stale" | "offline" | "unreachable";

/** Whether we can talk to a device's protected endpoints. */
export type AuthState =
  | "open" // no key set on the device
  | "authorized" // key set and ours works
  | "needs-key" // key set, we do not have a working one
  | "locked-out" // device is throttling us after failed attempts
  | "unknown"; // not probed yet

/** Identity merged from every source that has seen this device. */
export interface DeviceIdentity {
  id: DeviceId;
  hostname?: string;
  mac?: string;
  /** Preference-ordered; index 0 is tried first and the one that answers is
   * promoted, so DHCP churn costs at most one failed probe. */
  addresses: string[];
  port: number;
  /** Last time each source contributed. */
  sources: Partial<Record<SightingSource, number>>;
}

/** The hardware block espOS 0.10.0+ reports; absent on older firmware. */
export interface HardwareInfo {
  mac?: string;
  cpuMhz?: number;
  flashBytes?: number;
  ramInternalBytes?: number;
  ramPsramBytes?: number;
  features?: string[];
  board?: string;
}

/** Parsed `GET /api/v1/system/info` (protected). Every field is optional:
 * 0.7.x devices lack `hardware`, and newer ones add fields. */
export interface SystemInfo {
  app?: AppName;
  version?: string;
  esposVersion?: string;
  idfVersion?: string;
  chip?: string;
  chipRevision?: number;
  cores?: number;
  uptimeS?: number;
  freeHeap?: number;
  resetReason?: string;
  hardware?: HardwareInfo;
}

/** Device-reported OTA state machine position. */
export type DeviceOtaState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "verifying"
  | "ready"
  | "failed";

/** Parsed `GET /api/v1/ota/status` (protected). */
export interface OtaStatus {
  state: DeviceOtaState;
  running?: {
    version?: string;
    project?: AppName;
    target?: Target;
    slot?: string;
    pendingVerify?: boolean;
    confirmed?: boolean;
    rolledBack?: boolean;
    /** espOS E4 and later: fingerprint of the signing key this device
     * trusts. An image signed with any other key is refused after the whole
     * download, so this is what lets the UI say "USB reflash required". */
    keyFp?: string;
  };
  manifest?: {
    url?: string;
    channel?: string;
    autoCheck?: boolean;
    autoInstall?: boolean;
  };
  progress?: { received: number; total: number };
  available?: {
    version: string;
    url: string;
    size?: number;
    sha256?: string;
    notes?: string;
    newer?: boolean;
  } | null;
  lastError?: string;
}

/** Result of one successful probe cycle against a device. */
export interface DeviceSnapshot {
  probedAt: number;
  app: AppName;
  version: string;
  esposVersion?: string;
  target?: Target;
  board?: string;
  /** From the public /system/ping — the only trustworthy auth signal. */
  authRequired: boolean;
  /** Only when we are authorized. */
  info?: SystemInfo;
  ota?: OtaStatus;
}

/** A firmware build offered to a device. */
export interface UpdateOffer {
  projectId: ProjectId;
  fromVersion: string;
  toVersion: string;
  channel: Channel;
  /** The URL handed to the device: a mirror path when mirrored, else the
   * upstream release asset. */
  otaUrl: string;
  mirrored: boolean;
  sizeBytes?: number;
  sha256?: string;
  notes?: string;
  releaseUrl?: string;
  /** True when the running version is not a known release (a git-describe
   * build such as `1.1.0-12-g44590ce`), so "newer" would in practice be a
   * downgrade and needs explicit confirmation. */
  needsConfirmation?: boolean;
}

/** Everything the plugin knows about one device. */
export interface DeviceRecord {
  identity: DeviceIdentity;
  reachability: Reachability;
  auth: AuthState;
  lastSeenAt: number;
  lastOkProbeAt?: number;
  consecutiveFailures: number;
  lastError?: string;
  /** Last good snapshot, retained while the device is offline. */
  snapshot?: DeviceSnapshot;
  /** Resolved from the registry by app + target. */
  project?: ProjectId;
  update?: UpdateOffer;
  /** Until when this device must not be contacted with a key (429 lockout). */
  lockedOutUntil?: number;
}
