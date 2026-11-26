/**
 * Requests to espOS devices on behalf of other plugins, with the device's key.
 *
 * The manager holds every device's key (the fleet key, or one of its own) and
 * never hands one out: the HTTP API reports only whether a key is set. A
 * plugin that talks to a panel -- the HMI designer pushing a layout -- would
 * otherwise need the user to type the same key a second time. Instead it
 * asks the manager to send the request, and the manager adds the key.
 *
 * Plugins share one Node process, so the hook is a global, the way
 * signalk-container offers `__signalk_containerManager`. Look it up on every
 * call: it appears when the manager starts and goes when it stops.
 *
 * ```ts
 * const broker = (globalThis as { __signalk_esposManager?: EsposDeviceBroker })
 *   .__signalk_esposManager
 * const res = (await broker?.request(url, init)) ?? (await fetch(url, init))
 * ```
 */
import type { DeviceRecord } from "../types.js";

export const BROKER_GLOBAL = "__signalk_esposManager";

export interface DeviceRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface EsposDeviceBroker {
  /** Bumped when a change to this interface would break a caller. */
  readonly version: 1;
  /**
   * Send `url` with the key of the espOS device it names, matched by its
   * address or hostname (`espos-ab12` or `espos-ab12.local`) against the
   * devices the manager has found.
   *
   * Resolves to undefined when the URL names no device the manager knows;
   * the caller then sends the request itself. Otherwise it is fetch(): the
   * device's answer whatever its status, or a rejection when the device
   * does not answer. The key is left out, and the device answers 401, while
   * the device is throttling key attempts (a 429 naming
   * `too_many_attempts`), and after it answered 401 to the key until the
   * manager's own probe sees the device accept it or a different key is
   * set. A key the device has not accepted yet is tested by one request at a
   * time; a device without a key gets none. An Authorization header the
   * caller set is kept.
   */
  request(url: string, init?: DeviceRequestInit): Promise<Response | undefined>;
}

function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/** The device a URL points at, or undefined when it is none of ours. */
export function deviceForUrl(
  devices: readonly DeviceRecord[],
  url: string,
): DeviceRecord | undefined {
  let host: string;
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
  if (host === "") return undefined;
  const bare = host.replace(/\.local$/, "");
  return devices.find(
    (d) =>
      d.identity.addresses.some((a) => normalizeHost(a) === host) ||
      (d.identity.hostname !== undefined &&
        normalizeHost(d.identity.hostname).replace(/\.local$/, "") === bare),
  );
}

export interface BrokerDeps {
  /** False once this broker was withdrawn; it then answers undefined. */
  isCurrent: () => boolean;
  devices: () => readonly DeviceRecord[];
  keyToSend: (id: string) => string | undefined;
  keyAccepted: (id: string, key: string) => boolean;
  noteRefused: (id: string, key: string) => void;
  markLockedOut: (id: string, retryAfterS?: number) => void;
  fetchImpl?: typeof fetch;
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * espOS's key throttle, rather than a 429 of the endpoint's own -- the panel
 * answers one while a screenshot is in flight. Read from a clone, so the
 * caller still gets the body.
 */
async function isAuthThrottle(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as unknown;
    return (
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).error === "too_many_attempts"
    );
  } catch {
    return false;
  }
}

function waitOrAbort(
  pending: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) return pending.then(() => undefined);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

export function createBroker(deps: BrokerDeps): EsposDeviceBroker {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Device -> the request testing a key the device has not accepted yet.
  // Others wait for its answer instead of sending the same untested key:
  // a panel mirror asks several times a second, and each wrong key is a
  // strike towards the device's lockout.
  const testing = new Map<string, Promise<void>>();

  /**
   * The key to send, and when it is untested the function that ends this
   * request's test. The claim is taken before the first await, so requests
   * made in the same tick queue behind it rather than all sending the key.
   */
  const claimKey = async (
    id: string,
    signal?: AbortSignal,
  ): Promise<{ key?: string; done?: () => void }> => {
    for (;;) {
      const key = deps.keyToSend(id);
      if (key === undefined || deps.keyAccepted(id, key)) return { key };
      const pending = testing.get(id);
      if (pending === undefined) {
        let done: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          done = resolve;
        });
        testing.set(id, gate);
        return {
          key,
          done: () => {
            if (testing.get(id) === gate) testing.delete(id);
            done();
          },
        };
      }
      // Abort-aware: a request whose caller gave up stops waiting, and
      // leaves the gate with the request that holds it.
      await waitOrAbort(pending, signal);
    }
  };

  return {
    version: 1,
    async request(url, init = {}) {
      if (!deps.isCurrent()) return undefined;
      const device = deviceForUrl(deps.devices(), url);
      if (device === undefined) return undefined;
      const id = device.identity.id;
      const headers: Record<string, string> = { ...init.headers };
      const callerAuth = Object.keys(headers).some(
        (k) => k.toLowerCase() === "authorization",
      );
      // An open device takes no key and counts no strikes, so its requests
      // neither carry one nor queue behind a key test.
      const claim =
        callerAuth || device.auth === "open"
          ? {}
          : await claimKey(id, init.signal);
      const key = claim.key;
      if (key !== undefined) headers.Authorization = `Bearer ${key}`;
      try {
        const response = await fetchImpl(url, {
          method: init.method ?? "GET",
          headers,
          body: init.body,
          signal: init.signal,
        });
        if (key !== undefined) {
          if (response.status === 401) deps.noteRefused(id, key);
          else if (response.status === 429 && (await isAuthThrottle(response)))
            deps.markLockedOut(id, retryAfter(response));
          // A 2xx is no proof: a public endpoint (/api/v1/system/ping,
          // /hello) answers any key. Only the poller's protected probe marks
          // a key accepted, so until then requests keep testing it one by
          // one.
        }
        return response;
      } finally {
        claim.done?.();
      }
    },
  };
}
