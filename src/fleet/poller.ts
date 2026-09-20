/**
 * The poll loop: browse, probe, derive reachability, repeat.
 *
 * Self-scheduling with setTimeout rather than setInterval, so a slow cycle
 * (a boat wifi with three unreachable devices and an 8 s timeout each) can
 * never overlap itself into a pile-up.
 */

import { KeyStore } from "../device/auth.js";
import { probeDevice } from "../device/probe.js";
import { MdnsDiscovery, type MdnsDiscoveryOptions } from "../discovery/mdns.js";
import {
  DEFAULT_DEVICE_PORT,
  mergeSightings,
  parseHostEntry,
} from "../discovery/merge.js";
import type { DiscoverySighting } from "../types.js";
import type { DiscoverySettings } from "../config.js";
import { FleetState } from "./state.js";

export interface PollerOptions {
  fleet: FleetState;
  keys: KeyStore;
  settings: DiscoverySettings;
  /** Signal K's debug/error sinks. */
  log: (message: string) => void;
  onError: (message: string) => void;
  /** Called after every cycle, for status line and delta publication. */
  onCycle?: () => void;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Injectable so tests never open a multicast socket. */
  createMdns?: (options: MdnsDiscoveryOptions) => {
    start(): Promise<void>;
    stop(): Promise<void>;
    rescan(): Promise<void>;
  };
}

/** How many id-less hosts to resolve per cycle, so one bad host cannot stall. */
const UNRESOLVED_PER_CYCLE = 4;

/**
 * How long to let mDNS answer before the first poll. Devices on a quiet
 * network typically respond within a second; three seconds is generous
 * without making the plugin feel unresponsive when enabled.
 */
const FIRST_CYCLE_DELAY_MS = 3000;

/**
 * Marks an id the plugin invented for a device it reached but cannot name.
 * Chosen not to collide with a real espOS short id, which is four lowercase
 * hex digits.
 */
export const PROVISIONAL_PREFIX = "addr:";

/** A stable, provisional id for a device known only by address. */
export function provisionalId(address: string, port: number): string {
  return `${PROVISIONAL_PREFIX}${address}:${port}`;
}

/** True for an id the plugin invented rather than read from a device. */
export function isProvisionalId(id: string): boolean {
  return id.startsWith(PROVISIONAL_PREFIX);
}

export class FleetPoller {
  private readonly fleet: FleetState;
  private readonly keys: KeyStore;
  private readonly now: () => number;
  private settings: DiscoverySettings;
  private mdns?: {
    start(): Promise<void>;
    stop(): Promise<void>;
    rescan(): Promise<void>;
  };
  private timer?: NodeJS.Timeout;
  private running = false;
  private cycling = false;
  /** Sightings accumulated since the last cycle. */
  private inbox: DiscoverySighting[] = [];
  /** TXT hints per device id, carried from mDNS into the probe. */
  private readonly hints = new Map<
    string,
    { espos?: string; target?: string; board?: string }
  >();

  constructor(private readonly options: PollerOptions) {
    this.fleet = options.fleet;
    this.keys = options.keys;
    this.settings = options.settings;
    this.now = options.now ?? Date.now;
  }

  updateSettings(settings: DiscoverySettings): void {
    this.settings = settings;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.settings.mdns) {
      const factory =
        this.options.createMdns ??
        ((opts: MdnsDiscoveryOptions) => new MdnsDiscovery(opts));
      this.mdns = factory({
        onSighting: (sighting) => {
          this.inbox.push(sighting);
          if (sighting.id !== undefined && sighting.txt !== undefined) {
            this.hints.set(sighting.id, {
              espos: sighting.txt.espos,
              target: sighting.txt.target,
              board: sighting.txt.board,
            });
          }
        },
        onError: (error) => {
          this.options.onError(`mDNS: ${String(error)}`);
        },
      });
      try {
        await this.mdns.start();
      } catch (error) {
        // Losing mDNS is a degraded state, not a dead plugin: static hosts
        // and already-known devices keep working.
        this.options.onError(`mDNS unavailable: ${String(error)}`);
        this.mdns = undefined;
      }
    }

    // Give mDNS a moment to answer before the first cycle. A browse started
    // milliseconds ago has heard nothing yet, and a cycle run right now would
    // report "no devices found" to a user who has three — which reads as a
    // broken plugin rather than an empty network. Static hosts and previously
    // known devices are unaffected by the wait.
    this.timer = setTimeout(() => {
      void this.cycle();
    }, FIRST_CYCLE_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.mdns?.stop();
    this.mdns = undefined;
    this.inbox = [];
  }

  /** Force an immediate re-browse and poll. */
  async rescan(): Promise<void> {
    await this.mdns?.rescan();
    await this.cycle();
  }

  private schedule(): void {
    if (!this.running) return;
    // ±10% jitter so several servers on one network do not synchronise.
    const base = this.settings.pollIntervalS * 1000;
    const delay = base * (0.9 + Math.random() * 0.2);
    this.timer = setTimeout(() => {
      void this.cycle();
    }, delay);
    // Deliberately NOT unref'd. An unref'd timer stops firing as soon as
    // nothing else holds the event loop, which inside a Signal K server
    // happens to be masked by its HTTP listener — so the poll loop would
    // appear to work in production and silently stop in any harness. stop()
    // clears the timer, which is what actually lets the process exit.
  }

  /** One full cycle. Never throws; a failure is a logged, recoverable state. */
  async cycle(): Promise<void> {
    if (!this.running || this.cycling) return;
    this.cycling = true;
    try {
      await this.runCycle();
    } catch (error) {
      this.options.onError(`poll cycle failed: ${String(error)}`);
    } finally {
      this.cycling = false;
      this.options.onCycle?.();
      this.schedule();
    }
  }

  private staticSightings(now: number): DiscoverySighting[] {
    return this.settings.staticHosts
      .map((entry) => parseHostEntry(entry))
      .filter(
        (parsed): parsed is { host: string; port: number } => parsed !== null,
      )
      .map(({ host, port }) => ({
        source: "static" as const,
        seenAt: now,
        host,
        addresses: [host],
        port,
      }));
  }

  private async runCycle(): Promise<void> {
    const now = this.now();
    this.keys.beginCycle();

    const sightings = [...this.inbox, ...this.staticSightings(now)];
    this.inbox = [];

    const previous = new Map(
      this.fleet.list().map((record) => [record.identity.id, record.identity]),
    );
    const { identities, unresolved, warnings } = mergeSightings(
      sightings,
      previous,
    );
    this.fleet.applyIdentities(identities, now);
    this.fleet.setWarnings(warnings);

    // Probe every known device.
    for (const record of this.fleet.list()) {
      const result = await probeDevice({
        identity: record.identity,
        keys: this.keys,
        hints: this.hints.get(record.identity.id),
        fetchImpl: this.options.fetchImpl,
        now: this.now,
      });

      if (result.ok && result.snapshot !== undefined) {
        // Promote the address that answered so the next cycle tries it first.
        if (result.address !== undefined) {
          const addresses = record.identity.addresses;
          const index = addresses.indexOf(result.address);
          if (index > 0) {
            addresses.splice(index, 1);
            addresses.unshift(result.address);
          }
        }
        this.fleet.recordSuccess(
          record.identity.id,
          result.snapshot,
          result.auth,
          this.now(),
        );
        if (result.lockedOutUntil !== undefined) {
          this.fleet.setAuth(
            record.identity.id,
            "locked-out",
            result.lockedOutUntil,
          );
        }
      } else {
        this.fleet.recordFailure(
          record.identity.id,
          result.error ?? "unreachable",
        );
      }
    }

    // Learn the ids of hosts that announced without one (or were typed in).
    await this.resolveUnknownHosts(unresolved.slice(0, UNRESOLVED_PER_CYCLE));

    // A device first reached by address and later identified over mDNS would
    // otherwise appear twice. The real id wins.
    this.dropSupersededProvisionals();

    this.fleet.refreshReachability(
      {
        pollIntervalS: this.settings.pollIntervalS,
        offlineAfterS: this.settings.offlineAfterS,
      },
      this.settings.forgetAfterH,
      this.now(),
    );
    this.fleet.markPolled();
  }

  /**
   * Drop any provisional entry whose address is now claimed by a properly
   * identified device, so one board never shows up as two.
   */
  private dropSupersededProvisionals(): void {
    const records = this.fleet.list();
    const realAddresses = new Set(
      records
        .filter((record) => !isProvisionalId(record.identity.id))
        .flatMap((record) => record.identity.addresses),
    );
    for (const record of records) {
      if (!isProvisionalId(record.identity.id)) continue;
      if (
        record.identity.addresses.some((address) => realAddresses.has(address))
      ) {
        this.fleet.forget(record.identity.id);
      }
    }
  }

  /**
   * A host with no id in its announcement — a static host the user typed, or
   * an mDNS record whose TXT lacked `id` — is probed to see whether an espOS
   * device answers there.
   *
   * Verified on 0.7.x and 0.9.x firmware: NO REST endpoint reports the short
   * id or the MAC (`/system/ping` and `/system/info` carry neither, and
   * `/api/v1/net` does not exist), so the id cannot be learned over HTTP. An
   * mDNS announcement is the only source.
   *
   * So a confirmed device that we cannot name gets a provisional id derived
   * from its address. It appears in the fleet immediately and works for
   * everything except OTA; when its mDNS record does arrive, the real id
   * takes over and the provisional entry is dropped.
   */
  private async resolveUnknownHosts(
    sightings: DiscoverySighting[],
  ): Promise<void> {
    for (const sighting of sightings) {
      const address = sighting.addresses?.[0] ?? sighting.host;
      if (address === undefined) continue;
      const port = sighting.port ?? DEFAULT_DEVICE_PORT;
      const provisional = provisionalId(address, port);

      // Already known by a real id at this address? Nothing to do.
      const claimed = this.fleet
        .list()
        .some(
          (record) =>
            !record.identity.id.startsWith(PROVISIONAL_PREFIX) &&
            record.identity.addresses.includes(address),
        );
      if (claimed) {
        this.fleet.forget(provisional);
        continue;
      }

      const result = await probeDevice({
        identity: {
          id: provisional,
          addresses: [address],
          port,
          sources: {},
        },
        keys: this.keys,
        fetchImpl: this.options.fetchImpl,
        now: this.now,
      });
      if (!result.ok || result.snapshot === undefined) continue;

      const now = this.now();
      this.fleet.applyIdentities(
        new Map([
          [
            provisional,
            {
              id: provisional,
              hostname: sighting.host?.replace(/\.local\.?$/i, ""),
              addresses: [address],
              port,
              sources: { [sighting.source]: now },
            },
          ],
        ]),
        now,
      );
      this.fleet.recordSuccess(provisional, result.snapshot, result.auth, now);
      this.options.log(
        `reached ${address}: ${result.snapshot.app} ` +
          `${result.snapshot.version} (no mDNS id yet)`,
      );
    }
  }
}
