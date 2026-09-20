/**
 * signalk-espos-manager configuration: the TypeBox settings schema (which is
 * both the Admin UI form and the TypeScript type) plus the defaults merge.
 *
 * `@sinclair/typebox` 0.34 is what `@signalk/server-api` ships; the unscoped
 * `typebox` package on npm is a different 1.x line with a different API.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const PLUGIN_ID = "signalk-espos-manager";
export const PLUGIN_NAME = "espOS Manager";

/**
 * Public base path of the plugin's webapp mount. A package carrying the
 * `signalk-webapp` keyword has its `public/` directory served here with no
 * authentication (signalk-server src/interfaces/webapps.ts, mountWebModules),
 * which is what lets a device — holding a device token, not an admin one —
 * fetch the manifest at all. `/plugins/<id>/*` is admin-gated and would 401.
 */
export const PUBLIC_BASE = `/${PLUGIN_ID}`;

/** Public path of the firmware mirror, inside PUBLIC_BASE. */
export const PUBLIC_FW_BASE = `${PUBLIC_BASE}/fw`;

/**
 * Default registry index. Served from raw.githubusercontent.com so the plugin
 * makes exactly one unauthenticated request with no API rate limit — the
 * registry's own CI pre-resolves each project's releases into the index.
 */
export const DEFAULT_REGISTRY_INDEX =
  "https://raw.githubusercontent.com/signalk-espOS/registry/main/index.json";

const discoveryProperties = {
  mdns: Type.Boolean({
    title: "Find devices via mDNS",
    default: true,
    description:
      "Browse _espos._tcp on the local network. This is the primary way " +
      "devices are found; turn it off only if multicast is unavailable.",
  }),
  skDataModel: Type.Boolean({
    title: "Use Signal K health paths",
    default: true,
    description:
      "Treat espos.<device>.* values in the data model as a sign of life. " +
      "A secondary hint: it proves a device is talking to this server, but " +
      "carries no address.",
  }),
  skDevices: Type.Boolean({
    title: "Use registered Signal K devices",
    default: false,
    description:
      "Read last-known addresses from the server's registered device list. " +
      "Off by default: those entries go stale when a device is reflashed " +
      "or renamed, so they are a weak hint at best.",
  }),
  staticHosts: Type.Array(Type.String(), {
    title: "Extra device addresses",
    default: [],
    description:
      "Hostnames or IPs (optionally host:port) to probe directly, for " +
      "devices mDNS cannot reach — a different VLAN, or a routed subnet.",
  }),
  pollIntervalS: Type.Integer({
    title: "Poll interval",
    default: 60,
    minimum: 15,
    maximum: 3600,
    description: "How often each known device is asked how it is doing.",
  }),
  offlineAfterS: Type.Integer({
    title: "Offline after",
    default: 180,
    minimum: 30,
    maximum: 86400,
    description:
      "A device with no successful probe for this long is shown as offline. " +
      "Offline is a state, not an error — the last known details are kept.",
  }),
  forgetAfterH: Type.Integer({
    title: "Forget device after",
    default: 720,
    minimum: 1,
    description:
      "Drop a device from the list entirely after this many hours offline.",
  }),
};

// `default: {}` on every section is load-bearing: without an object-level
// default, Value.Default never materialises a missing section and every
// partial config would fail validation wholesale.
export const DiscoverySchema = Type.Object(discoveryProperties, {
  title: "Discovery",
  default: {},
});

export const AuthSchema = Type.Object(
  {
    fleetKey: Type.String({
      title: "Fleet API key",
      default: "",
      description:
        "One key for every espOS device on this boat. Devices that ask for " +
        "a key are contacted with it; devices that use a different key can " +
        "be given their own below. Leave empty if no device has a key set.",
    }),
    autoProvision: Type.Boolean({
      title: "Set the fleet key on open devices",
      default: false,
      description:
        "When a device has no key at all, write the fleet key to it " +
        "automatically. Off by default — this changes the device, and " +
        "afterwards its own web UI asks for the key too.",
    }),
  },
  { title: "Device authentication", default: {} },
);

export const RegistrySchema = Type.Object(
  {
    indexUrl: Type.String({
      title: "Registry index URL",
      default: DEFAULT_REGISTRY_INDEX,
      description:
        "Where the list of firmware projects comes from. The copy fetched " +
        "last is kept and used when the boat is offline.",
    }),
    extraIndexUrls: Type.Array(Type.String(), {
      title: "Additional registries",
      default: [],
      description:
        "Further index URLs merged into the store, for private or " +
        "experimental project lists.",
    }),
    refreshH: Type.Integer({
      title: "Refresh interval",
      default: 12,
      minimum: 1,
      maximum: 168,
      description: "How often to look for registry changes, in hours.",
    }),
    includePrerelease: Type.Boolean({
      title: "Offer beta releases",
      default: false,
      description: "Include prereleases when working out what is available.",
    }),
  },
  { title: "Project registry", default: {} },
);

export const MirrorSchema = Type.Object(
  {
    enabled: Type.Boolean({
      title: "Mirror firmware on this server",
      default: true,
      description:
        "Download firmware while the boat has internet and serve it to " +
        "devices locally, so updates work at anchor. With this off, devices " +
        "are pointed at GitHub directly and need internet themselves.",
    }),
    keepVersions: Type.Integer({
      title: "Versions to keep per project",
      default: 3,
      minimum: 1,
      maximum: 20,
      description:
        "Older downloads are deleted beyond this, except a version some " +
        "device is currently running.",
    }),
    maxCacheMb: Type.Integer({
      title: "Firmware cache limit",
      default: 2048,
      minimum: 128,
      description:
        "Megabytes of firmware to keep on disk. A download that would " +
        "exceed this is refused rather than filling the card.",
    }),
    cacheMergedImages: Type.Boolean({
      title: "Also keep full-flash images",
      default: false,
      description:
        "Full-flash images are only needed for USB flashing and are large " +
        "(15 MB and up). Off by default: they are fetched when the flasher " +
        "actually asks for one.",
    }),
  },
  { title: "Firmware mirror", default: {} },
);

export const OtaSchema = Type.Object(
  {
    channel: Type.Union([Type.Literal("stable"), Type.Literal("beta")], {
      title: "Update channel",
      default: "stable",
      description: "Which channel devices are offered updates from.",
    }),
    maxConcurrent: Type.Integer({
      title: "Simultaneous updates",
      default: 1,
      minimum: 1,
      maximum: 4,
      description:
        "Updates run one at a time by default. Several devices pulling " +
        "firmware over the same boat wifi is how a fleet update goes wrong.",
    }),
    autoConfirm: Type.Boolean({
      title: "Confirm automatically after reboot",
      default: true,
      description:
        "Confirm a new image once the device comes back and reports the " +
        "expected version. Without confirmation the device rolls itself " +
        "back — which is the safe default, just slower.",
    }),
    confirmGraceS: Type.Integer({
      title: "Wait before confirming",
      default: 120,
      minimum: 30,
      maximum: 600,
      description:
        "How long a rebooted device must look healthy before its new image " +
        "is confirmed.",
    }),
    installTimeoutS: Type.Integer({
      title: "Install timeout",
      default: 600,
      minimum: 60,
      maximum: 3600,
      description:
        "Give up watching an update after this long. The device's own " +
        "rollback timer still protects it.",
    }),
  },
  { title: "Updates", default: {} },
);

export const SettingsSchema = Type.Object({
  discovery: DiscoverySchema,
  auth: AuthSchema,
  registry: RegistrySchema,
  mirror: MirrorSchema,
  ota: OtaSchema,
});

export type DiscoverySettings = Static<typeof DiscoverySchema>;
export type AuthSettings = Static<typeof AuthSchema>;
export type RegistrySettings = Static<typeof RegistrySchema>;
export type MirrorSettings = Static<typeof MirrorSchema>;
export type OtaSettings = Static<typeof OtaSchema>;
export type ManagerSettings = Static<typeof SettingsSchema>;

export function defaultSettings(): ManagerSettings {
  // Value.Default, not Value.Create: Create would take each section's
  // object-level `default: {}` verbatim instead of descending into the
  // per-field defaults.
  const value = Value.Clean(SettingsSchema, Value.Default(SettingsSchema, {}));
  if (!Value.Check(SettingsSchema, value)) {
    throw new Error("SettingsSchema defaults do not satisfy the schema");
  }
  return value;
}

/**
 * Merge raw plugin config over the defaults. Signal K does not seed schema
 * defaults into saved configurations (a never-configured plugin is started
 * with `{}`), and hand-edited config files can hold anything — an invalid
 * field falls back to its default individually, the rest of the config
 * survives.
 */
export function applyDefaults(raw: unknown): ManagerSettings {
  const candidate = Value.Clean(
    SettingsSchema,
    Value.Convert(
      SettingsSchema,
      Value.Default(SettingsSchema, Value.Clone(raw ?? {})),
    ),
  );
  if (Value.Check(SettingsSchema, candidate)) return candidate;

  const fallback = defaultSettings();
  if (typeof candidate !== "object" || candidate === null) return fallback;
  const repaired = candidate as Record<string, unknown>;
  for (const error of Value.Errors(SettingsSchema, repaired)) {
    // Reset the top-level section owning the errored path to its defaults.
    const field = error.path.split("/")[1];
    if (field !== undefined && field in fallback) {
      repaired[field] = fallback[field as keyof ManagerSettings];
    }
  }
  // Root-level errors (a missing section) have no path segment to repair —
  // fill any still-missing top-level keys from the defaults.
  for (const key of Object.keys(fallback) as (keyof ManagerSettings)[]) {
    if (!(key in repaired)) repaired[key] = fallback[key];
  }
  return Value.Check(SettingsSchema, repaired) ? repaired : fallback;
}
