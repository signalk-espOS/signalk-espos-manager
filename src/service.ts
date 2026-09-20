/**
 * The long-lived service object: owns the fleet, the key store and the poll
 * loop, and reports what it knows to the Signal K status line and data model.
 */

import type { ServerAPI } from "@signalk/server-api";
import type { ManagerSettings } from "./config.js";
import { PLUGIN_ID } from "./config.js";
import { KeyStore } from "./device/auth.js";
import { FleetPoller } from "./fleet/poller.js";
import { FleetState } from "./fleet/state.js";
import { publishFleetDeltas } from "./fleet/deltas.js";

export class ManagerService {
  readonly fleet = new FleetState();
  private keys?: KeyStore;
  private poller?: FleetPoller;
  private settings?: ManagerSettings;
  private started = false;

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
