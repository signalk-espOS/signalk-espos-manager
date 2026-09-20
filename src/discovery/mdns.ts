/**
 * mDNS discovery of `_espos._tcp` devices.
 *
 * `bonjour-service` is pure JavaScript (its only deps are `multicast-dns` and
 * `fast-deep-equal`), which matters: the Signal K app store installs plugins
 * with `--ignore-scripts`, so anything needing a native build would install
 * "successfully" and then fail at runtime.
 *
 * The browser is behind an interface so tests can drive synthetic services
 * without touching real multicast.
 */

import type { DiscoverySighting } from "../types.js";

/** The subset of a bonjour-service `Service` we rely on. */
export interface MdnsService {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
}

export interface MdnsBrowser {
  start(): void;
  stop(): void;
  /** Re-issue the query without tearing the browser down. */
  update(): void;
}

export type MdnsSighting = (sighting: DiscoverySighting) => void;

function txtString(
  txt: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = txt[key];
  if (typeof value === "string" && value !== "") return value;
  // multicast-dns can hand back Buffers for TXT values.
  if (value instanceof Uint8Array && value.length > 0) {
    return Buffer.from(value).toString("utf8");
  }
  return undefined;
}

/** True for an IPv4 dotted quad. */
function isIpv4(address: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

/**
 * Turn one advertised service into a sighting.
 *
 * Deliberately ignores the TXT `auth` key: espOS hardcodes it to "0"
 * (components/espos_net/src/mdns.c), so a keyed device still advertises
 * auth=0. Only `GET /api/v1/system/ping` answers that question honestly.
 */
export function sightingFromService(
  service: MdnsService,
  now: number,
): DiscoverySighting {
  const txt = service.txt ?? {};
  const addresses = (service.addresses ?? []).filter(isIpv4);
  return {
    source: "mdns",
    seenAt: now,
    id: txtString(txt, "id"),
    host: service.host ?? service.name,
    addresses,
    port: service.port ?? 80,
    txt: {
      v: txtString(txt, "v"),
      app: txtString(txt, "app"),
      espos: txtString(txt, "espos"),
      target: txtString(txt, "target"),
      board: txtString(txt, "board"),
      api: txtString(txt, "api"),
    },
  };
}

export interface MdnsDiscoveryOptions {
  onSighting: MdnsSighting;
  onError?: (error: unknown) => void;
  now?: () => number;
}

/**
 * Live mDNS browser. Constructed lazily so importing this module never opens
 * a socket — and `stop()` must destroy the Bonjour instance, or a plugin
 * reload leaks a multicast socket (the classic failure here).
 */
export class MdnsDiscovery {
  private bonjour?: { destroy(): void };
  private browser?: MdnsBrowser;
  private readonly now: () => number;

  constructor(private readonly options: MdnsDiscoveryOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.browser !== undefined) return;
    const { Bonjour } = await import("bonjour-service");
    const instance = new Bonjour();
    this.bonjour = instance;
    const browser = instance.find({ type: "espos", protocol: "tcp" });
    const handle = (service: MdnsService): void => {
      try {
        this.options.onSighting(sightingFromService(service, this.now()));
      } catch (error) {
        this.options.onError?.(error);
      }
    };
    browser.on("up", handle);
    // A device that changes its TXT (a new firmware version after an OTA, or
    // the auth flag once espOS stops hardcoding it) re-announces rather than
    // going down and up. These two events pass (newService, existingService)
    // — the first argument is the current state, which is what we want.
    browser.on("txt-update", (updated: MdnsService) => {
      handle(updated);
    });
    browser.on("srv-update", (updated: MdnsService) => {
      handle(updated);
    });
    // Deliberately NOT subscribing to "down": an mDNS goodbye is lossy on a
    // boat wifi, and reachability is the poller's judgement, not a packet's.
    this.browser = browser as unknown as MdnsBrowser;
  }

  /**
   * Re-query the network without waiting for the next announcement. Uses the
   * browser's own `update()` rather than restarting it: tearing the socket
   * down and back up loses every already-discovered service.
   */
  async rescan(): Promise<void> {
    if (this.browser === undefined) {
      await this.start();
      return;
    }
    this.browser.update();
  }

  async stop(): Promise<void> {
    try {
      this.browser?.stop();
    } catch {
      // A browser that never started cannot fail to stop.
    }
    this.browser = undefined;
    try {
      this.bonjour?.destroy();
    } catch {
      // Same.
    }
    this.bonjour = undefined;
  }
}
