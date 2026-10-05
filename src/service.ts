/**
 * The long-lived service object: owns the fleet, the key store and the poll
 * loop, and reports what it knows to the Signal K status line and data model.
 */

import type { ServerAPI } from "@signalk/server-api";
import os from "node:os";
import { join } from "node:path";
import type { ManagerSettings } from "./config.js";
import { PLUGIN_ID, PUBLIC_FW_BASE } from "./config.js";
import { KeyStore } from "./device/auth.js";
import { FleetPoller } from "./fleet/poller.js";
import { FleetState } from "./fleet/state.js";
import { publishFleetDeltas } from "./fleet/deltas.js";
import { FirmwareStore } from "./mirror/store.js";
import { RegistryClient, type IndexResult } from "./registry/client.js";
import { OtaOrchestrator } from "./ota/orchestrator.js";
import type { JobView } from "./ota/job.js";
import { DeviceClient } from "./device/client.js";
import { fleetKeyUsable, provisionFleetKey } from "./device/provision.js";
import {
  boardIdFromReport,
  matchDevice,
  projectForApp,
} from "./registry/resolve.js";
import type { RegistryProject } from "./registry/types.js";
import {
  filenameFromUrl,
  firmwareUrlFor,
  generateManifest,
  isReleaseVersion,
  planManifests,
} from "./mirror/manifest.js";
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
  /** Devices auto-provisioning gave up on; one try each per plugin start. */
  private provisionTried = new Set<string>();
  private provisioning = false;
  private provisionKeyWarned = false;
  /** Bumped by stop(), so a provisioning run from before it stands down. */
  private generation = 0;
  private store?: FirmwareStore;
  private registry?: RegistryClient;
  private registryState?: IndexResult;
  private readonly manifestWrites = new Map<string, Promise<void>>();
  private orchestrator?: OtaOrchestrator;
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

      this.orchestrator = new OtaOrchestrator({
        maxConcurrent: settings.ota.maxConcurrent,
        log: (message) => {
          this.app.debug(message);
        },
        onChange: () => {
          this.report();
        },
      });

      this.registry = new RegistryClient({
        cacheDir: join(dataDir, "cache"),
        indexUrl: settings.registry.indexUrl,
        extraIndexUrls: settings.registry.extraIndexUrls,
        log: (message) => {
          this.app.debug(message);
        },
      });

      if (settings.mirror.enabled) {
        await this.startMirror(dataDir, settings);
        void this.refreshManifests();
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
          void this.provisionOpenDevices();
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
    this.generation += 1;
    this.provisioning = false;
    this.provisionKeyWarned = false;
    this.provisionTried.clear();
    // Pause before discarding: a queued job left running would keep polling a
    // device, and calling report() on a stopped plugin, long after the user
    // disabled it. A job already writing flash is deliberately NOT interrupted
    // — the device is mid-update and stopping now is worse than letting it
    // finish; it is simply no longer watched.
    this.orchestrator?.pause("the plugin was stopped");
    this.orchestrator = undefined;
    await this.poller?.stop();
    this.poller = undefined;
    this.keys = undefined;
    this.store = undefined;
    this.registry = undefined;
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

  getRegistry(): RegistryClient | undefined {
    return this.registry;
  }

  getOrchestrator(): OtaOrchestrator | undefined {
    return this.orchestrator;
  }

  /** The registry as last read, including whether it came from cache. */
  async getIndex(force = false): Promise<IndexResult> {
    const client = this.registry;
    if (client === undefined) {
      return {
        index: { schema: 1, projects: [] },
        stale: true,
        reason: "the plugin is not running",
        warnings: [],
      };
    }
    const maxAgeMs = (this.settings?.registry.refreshH ?? 12) * 3600 * 1000;
    this.registryState = await client.getIndex({ maxAgeMs, force });
    return this.registryState;
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

  /**
   * `auth.autoProvision`: give every open device the fleet key. Runs after a
   * poll cycle, never alongside another run. A device that refused is tried
   * once per plugin start -- it would refuse every minute, and the log line
   * saying why is enough; one that did not answer is tried again next cycle.
   */
  private async provisionOpenDevices(): Promise<void> {
    const settings = this.settings;
    const keys = this.keys;
    if (
      !this.started ||
      this.provisioning ||
      settings === undefined ||
      keys === undefined ||
      !settings.auth.autoProvision
    ) {
      return;
    }
    if (!fleetKeyUsable(settings.auth.fleetKey)) {
      if (!this.provisionKeyWarned) {
        this.provisionKeyWarned = true;
        this.app.debug(
          "auto-provisioning is on but the fleet key is not 8-64 bytes; " +
            "no device was changed",
        );
      }
      return;
    }
    const generation = this.generation;
    this.provisioning = true;
    let changed = false;
    try {
      for (const device of this.fleet.list()) {
        // A stop() or settings change mid-run must not keep writing the old key.
        if (!this.started || generation !== this.generation) return;
        const id = device.identity.id;
        if (device.auth !== "open" || device.reachability !== "online")
          continue;
        // Its stored key would win in keyFor(), locking us out of it.
        if (keys.hasOwnKey(id) || this.provisionTried.has(id)) continue;
        const address = device.identity.addresses[0];
        if (address === undefined) continue;
        const client = new DeviceClient({
          address,
          port: device.identity.port,
        });
        const outcome = await provisionFleetKey(
          client,
          settings.auth.fleetKey,
          () => this.started && generation === this.generation,
        );
        // Cancelled mid-write: not a refusal, so leave it untried.
        if (!this.started || generation !== this.generation) return;
        if (outcome.result === "provisioned") {
          changed = true;
          this.app.debug(`${id}: fleet key set on an open device`);
        } else {
          if (outcome.result !== "unreachable") this.provisionTried.add(id);
          this.app.debug(`${id}: fleet key not set: ${outcome.reason}`);
        }
      }
    } catch (error) {
      this.app.debug(`auto-provisioning failed: ${String(error)}`);
    } finally {
      if (generation === this.generation) this.provisioning = false;
    }
    // The next poll reads the device's new auth state; report only so the
    // log and status reflect a run that changed something.
    if (changed && this.started && generation === this.generation) {
      this.report();
    }
  }

  /** A client for one device, with its key attached when we have one. */
  clientFor(id: string): DeviceClient | undefined {
    const device = this.fleet.get(id);
    const address = device?.identity.addresses[0];
    if (device === undefined || address === undefined) return undefined;
    return new DeviceClient({
      address,
      port: device.identity.port,
      key: this.keys?.keyFor(id),
    });
  }

  /**
   * Mirror the firmware a device needs, publish a manifest for it, and queue
   * the install.
   *
   * The image is downloaded here rather than by the device from GitHub, which
   * is the whole point of the mirror: the update then works at anchor. The
   * manifest is written too, so a device configured with
   * `manifest_src = signalk` also finds the same build on its own schedule.
   */
  async startUpdate(
    id: string,
    options: { confirmDowngrade?: boolean } = {},
  ): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
    job?: JobView;
  }> {
    const settings = this.settings;
    const device = this.fleet.get(id);
    const orch = this.orchestrator;
    const store = this.store;
    if (settings === undefined || orch === undefined) {
      return { ok: false, status: 503, error: "the plugin is not running" };
    }
    if (device === undefined) {
      return { ok: false, status: 404, error: `no device ${id}` };
    }
    const snapshot = device.snapshot;
    if (snapshot === undefined) {
      return {
        ok: false,
        error: "this device has not been reached yet — wait for the next poll",
      };
    }
    if (orch.isBusy(id)) {
      return {
        ok: false,
        error: "an update is already running for this device",
      };
    }

    const { index } = await this.getIndex();
    const project = projectForApp(index, snapshot.app);
    if (project === undefined) {
      return {
        ok: false,
        error: `no registry project provides "${snapshot.app}"`,
      };
    }
    const match = matchDevice(project, {
      app: snapshot.app,
      target: snapshot.target,
      board: snapshot.board,
      runningVersion: snapshot.version,
      channel: settings.ota.channel,
      keyFp: snapshot.ota?.running?.keyFp,
      includePrerelease: settings.registry.includePrerelease,
    });
    if (match.build === undefined) {
      return { ok: false, error: match.reason ?? "no update is available" };
    }
    if (match.requiresUsb === true) {
      return {
        ok: false,
        error:
          match.reason ??
          "this update cannot be installed over the air — it needs a USB cable",
      };
    }
    // A device running an unreleased build compares below its own release, so
    // installing "newer" firmware is a downgrade in practice. Require an
    // explicit acknowledgement rather than deciding for the operator.
    if (
      !isReleaseVersion(snapshot.version) &&
      options.confirmDowngrade !== true
    ) {
      return {
        ok: false,
        error:
          `this device is running ${snapshot.version}, which is not a released ` +
          `version — installing ${match.build.version} may replace a newer ` +
          `build with an older one. Confirm to proceed.`,
      };
    }

    const build = match.build;
    let url = build.otaUrl;

    if (store !== undefined && this.mirror.mode === "mirror") {
      const filename = filenameFromUrl(build.otaUrl);
      try {
        await store.ensure({
          url: build.otaUrl,
          app: snapshot.app,
          version: build.version,
          filename,
          expectedBytes: build.otaBytes,
          sha256: build.otaSha256,
        });
        url = firmwareUrlFor(
          snapshot.app,
          build.version,
          filename,
          PUBLIC_FW_BASE,
        );
        await this.writeManifestsFor(project);
      } catch (error) {
        // Mirroring failed: fall back to the upstream URL, which needs the
        // device to have internet but is better than refusing outright.
        this.app.debug(
          `could not mirror ${filename}: ${String(error)} — pointing the ` +
            `device at the upstream release instead`,
        );
      }
    }

    const client = this.clientFor(id);
    if (client === undefined) {
      return { ok: false, error: "no address known for this device" };
    }

    const queued = orch.enqueue({
      deviceId: id,
      client,
      fromVersion: snapshot.version,
      toVersion: build.version,
      url: url.startsWith("/")
        ? `${this.originReachableFrom(device.identity.addresses[0])}${url}`
        : url,
      timeoutMs: settings.ota.installTimeoutS * 1000,
      confirmGraceMs: settings.ota.confirmGraceS * 1000,
      autoConfirm: settings.ota.autoConfirm,
      log: (message) => {
        this.app.debug(message);
      },
    });
    if (!queued.queued) {
      return { ok: false, error: queued.reason };
    }
    return { ok: true, job: orch.get(id) };
  }

  /**
   * Regenerate an application's manifests from whatever is cached for it: the
   * board-agnostic one and one per declared board. Every one is rewritten,
   * even when empty, so a manifest written before an image moved to a
   * per-board file cannot keep offering it.
   */
  private writeManifestsFor(project: RegistryProject): Promise<void> {
    // One regeneration per app at a time: the start-up refresh and an update
    // both write the same files through the same temporary path, and a plan
    // taken before the other's download landed must not overwrite its result.
    const previous = this.manifestWrites.get(project.app) ?? Promise.resolve();
    const next = previous.then(() => this.regenerateManifests(project));
    const tail = next.catch(() => undefined);
    this.manifestWrites.set(project.app, tail);
    void tail.then(() => {
      if (this.manifestWrites.get(project.app) === tail) {
        this.manifestWrites.delete(project.app);
      }
    });
    return next;
  }

  private async regenerateManifests(project: RegistryProject): Promise<void> {
    const store = this.store;
    if (store === undefined) return;
    const cached = (await store.list()).filter((f) => f.app === project.app);
    const plan = planManifests(project, cached, PUBLIC_FW_BASE);
    const outputs: [string | undefined, typeof plan.app][] = [
      [undefined, plan.app],
      ...plan.boards.entries(),
    ];
    for (const [boardId, builds] of outputs) {
      const { json, warnings } = generateManifest(project.app, builds);
      for (const warning of warnings) this.app.debug(warning);
      try {
        await store.writeManifest(project.app, json, boardId);
      } catch (error) {
        // A board id is registry content; one the store refuses must not
        // keep the other boards' manifests stale, nor fail the update that
        // asked for them.
        this.app.debug(
          `could not write the ${project.app} manifest for board ` +
            `${String(boardId)}: ${String(error)}`,
        );
      }
    }
    // A board the registry dropped or renamed keeps no manifest: a device
    // still pointed at it would otherwise go on being offered what it lists.
    for (const boardId of await store.manifestBoards(project.app)) {
      if (plan.boards.has(boardId)) continue;
      try {
        await store.removeManifest(project.app, boardId);
      } catch (error) {
        this.app.debug(
          `could not remove the ${project.app} manifest for board ` +
            `${boardId}: ${String(error)}`,
        );
      }
    }
  }

  /**
   * Rewrite every mirrored application's manifests against the current index.
   *
   * Run at start so a manifest written by an earlier version of this plugin,
   * or against an older index, does not keep offering what it no longer
   * should until the next plugin-driven update. Also loads the index the
   * fleet view resolves boards with.
   */
  private async refreshManifests(): Promise<void> {
    const store = this.store;
    if (store === undefined || this.mirror.mode !== "mirror") return;
    try {
      const { index } = await this.getIndex();
      const apps = new Set((await store.list()).map((f) => f.app));
      for (const app of apps) {
        const project = projectForApp(index, app);
        if (project !== undefined) await this.writeManifestsFor(project);
      }
    } catch (error) {
      this.app.debug(
        `could not refresh the update manifests: ${String(error)}`,
      );
    }
  }

  /**
   * The registry's id for the board a device reports, from the index already
   * held. Undefined when it reports none or nobody claims it, which means
   * "the application's manifest"; null when no index has been fetched yet,
   * so a caller can tell "no board" from "cannot say".
   */
  boardIdFor(
    app: string | undefined,
    reported: string | undefined,
  ): string | undefined | null {
    if (app === undefined) return undefined;
    const index = this.registryState?.index;
    if (index === undefined) return null;
    return boardIdFromReport(projectForApp(index, app)?.boards, reported);
  }

  /**
   * A base URL for THIS server that the given device can actually reach.
   *
   * serverOrigin() is loopback, which is right for our own mount probe and
   * catastrophic in a firmware URL: a device resolving 127.0.0.1 looks at
   * itself and finds nothing. The address is therefore derived from the route
   * the device already uses to reach us — the local interface address on the
   * same network as the device — so the URL works from where the device sits.
   */
  private originReachableFrom(deviceAddress: string | undefined): string {
    const config = (
      this.app as unknown as { config?: { settings?: { port?: number } } }
    ).config;
    const port = config?.settings?.port ?? 3000;
    const host = localAddressFor(deviceAddress);
    return `http://${host}:${port}`;
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

export { filenameFromUrl };

/**
 * The address of the local interface that shares a network with `peer`.
 *
 * A device on the boat LAN must be handed the server's LAN address, not
 * loopback and not a container-internal address. Matching on the longest
 * shared prefix picks the right interface on a host with several (a boat
 * server commonly has both wifi and ethernet).
 */
export function localAddressFor(
  peer: string | undefined,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string {
  const candidates: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      candidates.push(entry.address);
    }
  }
  if (candidates.length === 0) return "127.0.0.1";
  if (peer === undefined) return candidates[0] ?? "127.0.0.1";

  const peerParts = peer.split(".");
  let best = candidates[0] ?? "127.0.0.1";
  let bestScore = -1;
  for (const candidate of candidates) {
    const parts = candidate.split(".");
    let score = 0;
    while (
      score < 4 &&
      parts[score] !== undefined &&
      parts[score] === peerParts[score]
    ) {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
