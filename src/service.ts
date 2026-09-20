/**
 * The long-lived service object: owns the fleet, the key store and the poll
 * loop, and reports what it knows to the Signal K status line and data model.
 */

import type { ServerAPI } from "@signalk/server-api";
import { join } from "node:path";
import type { ManagerSettings } from "./config.js";
import { PLUGIN_ID, PUBLIC_FW_BASE } from "./config.js";
import { KeyStore } from "./device/auth.js";
import { FleetPoller } from "./fleet/poller.js";
import { FleetState } from "./fleet/state.js";
import { publishFleetDeltas } from "./fleet/deltas.js";
import { FirmwareStore } from "./mirror/store.js";
import {
  ensureFirmwareLink,
  verifyMountServed,
  type MirrorMode,
} from "./mirror/publish.js";

export class ManagerService {
  readonly fleet = new FleetState();
  private keys?: KeyStore;
  private poller?: FleetPoller;
  private settings?: ManagerSettings;
  private started = false;
  private store?: FirmwareStore;
  private mirror: { mode: MirrorMode; reason?: string } = {
    mode: "upstream",
    reason: "not started",
  };

  constructor(private readonly app: ServerAPI) {}

  get isRunning(): boolean {
    return this.started;
  }

  getSettings(): ManagerSettings | undefined {
    return this.settings;
  }

  async start(settings: ManagerSettings): Promise<void> {
    // A config change restarts us; make that idempotent rather than layering
    // a second poll loop on top of the first.
    if (this.started) await this.stop();
    this.settings = settings;
    this.started = true;

    try {
      const dataDir = this.app.getDataDirPath();
      this.keys = new KeyStore({ dataDir });
      await this.keys.load();
      this.keys.setFleetKey(settings.auth.fleetKey);

      if (settings.mirror.enabled) {
        await this.startMirror(dataDir, settings);
      } else {
        this.mirror = {
          mode: "upstream",
          reason: "the firmware mirror is switched off in the settings",
        };
      }

      this.poller = new FleetPoller({
        fleet: this.fleet,
        keys: this.keys,
        settings: settings.discovery,
        log: (message) => {
          this.app.debug(message);
        },
        onError: (message) => {
          // A discovery hiccup is a logged event, not a red plugin.
          this.app.debug(message);
        },
        onCycle: () => {
          this.report();
        },
      });
      await this.poller.start();
    } catch (error) {
      this.app.setPluginError(
        `startup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.poller?.stop();
    this.poller = undefined;
    this.keys = undefined;
  }

  /** Force an immediate mDNS re-query and poll. */
  async rescan(): Promise<void> {
    await this.poller?.rescan();
  }

  getKeys(): KeyStore | undefined {
    return this.keys;
  }

  getStore(): FirmwareStore | undefined {
    return this.store;
  }

  /** Whether firmware is served from here or devices are sent to GitHub. */
  getMirrorStatus(): { mode: MirrorMode; reason?: string; publicBase: string } {
    return { ...this.mirror, publicBase: PUBLIC_FW_BASE };
  }

  /**
   * Bring up the firmware cache and its public mount.
   *
   * The mount is verified over HTTP rather than on disk: a correct symlink
   * still fails if the server mounted this package before the link existed, or
   * if something in front of it rewrites the path, and a device fetching a 404
   * is exactly the failure this check exists to catch. A failure here is a
   * degraded mode, never a dead plugin.
   */
  private async startMirror(
    dataDir: string,
    settings: ManagerSettings,
  ): Promise<void> {
    this.store = new FirmwareStore({
      root: join(dataDir, "fw"),
      maxBytes: settings.mirror.maxCacheMb * 1024 * 1024,
      keepVersions: settings.mirror.keepVersions,
      log: (message) => {
        this.app.debug(message);
      },
    });

    const linked = await ensureFirmwareLink({
      dataDir,
      log: (message) => {
        this.app.debug(message);
      },
    });
    if (linked.mode === "upstream") {
      this.mirror = linked;
      this.app.debug(`firmware mirror unavailable: ${String(linked.reason)}`);
      return;
    }

    // Write a probe file and fetch it back through the server's own URL.
    //
    // NOT a dotfile: serve-static ignores dotfiles by default, so a
    // ".mount-probe" 404s even when the mount is working perfectly — verified
    // by serving the same bytes under both names against signalk-server
    // 2.32.0 (dotted 404, undotted 200). A probe that reports a healthy mirror
    // as broken is worse than no probe.
    const probeName = "mount-probe.txt";
    const probeBody = `espos-manager ${Date.now()}`;
    try {
      await this.store.writeProbe(probeName, probeBody);
    } catch (error) {
      this.mirror = { mode: "upstream", reason: String(error) };
      return;
    }

    const origin = this.serverOrigin();
    const verified = await verifyMountServed(async (relative) => {
      const response = await fetch(`${origin}${PUBLIC_FW_BASE}/${relative}`);
      if (!response.ok) return false;
      return (await response.text()).trim() === probeBody;
    }, probeName);

    this.mirror = verified;
    if (verified.mode === "mirror") {
      this.app.debug(`firmware mirror serving at ${origin}${PUBLIC_FW_BASE}`);
    } else {
      this.app.debug(
        `firmware mirror not reachable: ${String(verified.reason)} — devices ` +
          `will be pointed at their upstream release instead`,
      );
    }
  }

  /** This server's own base URL, for the mount probe. */
  private serverOrigin(): string {
    const config = (
      this.app as unknown as {
        config?: { settings?: { port?: number } };
      }
    ).config;
    const port = config?.settings?.port ?? 3000;
    // Deliberately plain http on loopback even when the server also serves
    // https: a self-signed certificate — the common case on a boat, via
    // signalk-ssl — would fail verification for reasons that have nothing to
    // do with whether the mount serves, and the probe would then report a
    // working mirror as broken. The plain listener keeps running alongside.
    return `http://127.0.0.1:${port}`;
  }

  /** Status line plus deltas, after every cycle. */
  private report(): void {
    try {
      this.app.setPluginStatus(this.fleet.summary());
      publishFleetDeltas(this.app, PLUGIN_ID, this.fleet.list());
    } catch (error) {
      this.app.debug(`reporting failed: ${String(error)}`);
    }
  }
}
