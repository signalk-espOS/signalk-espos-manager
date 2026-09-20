/**
 * One probe cycle against one device: ping (public) then, if we are allowed
 * to, the protected endpoints.
 *
 * The ordering matters. `ping` is public and cheap and tells us whether a key
 * is needed at all, so it runs first and never spends an auth attempt. Only
 * then do we decide whether to use the one authenticated call this device is
 * allowed this cycle.
 */

import type { AuthState, DeviceIdentity, DeviceSnapshot } from "../types.js";
import { DeviceClient, DeviceHttpError } from "./client.js";
import type { KeyStore } from "./auth.js";

export interface ProbeResult {
  ok: boolean;
  /** The address that answered, so it can be promoted for next time. */
  address?: string;
  snapshot?: DeviceSnapshot;
  auth: AuthState;
  lockedOutUntil?: number;
  error?: string;
}

export interface ProbeOptions {
  identity: DeviceIdentity;
  keys: KeyStore;
  /** mDNS TXT values, which carry facts /system/info does not report. */
  hints?: { espos?: string; target?: string; board?: string };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Probe a device across its candidate addresses, stopping at the first that
 * answers. Returns the state to fold into the fleet, never throws.
 */
export async function probeDevice(options: ProbeOptions): Promise<ProbeResult> {
  const { identity, keys } = options;
  const now = options.now ?? Date.now;
  const addresses =
    identity.addresses.length > 0
      ? identity.addresses
      : identity.hostname !== undefined
        ? [`${identity.hostname}.local`]
        : [];

  if (addresses.length === 0) {
    return { ok: false, auth: "unknown", error: "no address known" };
  }

  let lastError = "unreachable";

  for (const address of addresses) {
    const publicClient = new DeviceClient({
      address,
      port: identity.port,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });

    let ping;
    try {
      ping = await publicClient.ping();
    } catch (error) {
      lastError = message(error);
      continue; // Try the next address.
    }

    const snapshot: DeviceSnapshot = {
      probedAt: now(),
      app: ping.app,
      version: ping.version,
      authRequired: ping.authRequired,
      // /system/info does not report the espOS version — only mDNS does.
      esposVersion: options.hints?.espos,
      target: options.hints?.target,
      board: options.hints?.board,
    };

    if (!ping.authRequired) {
      // Open device: the protected endpoints are readable without a key.
      const open = new DeviceClient({
        address,
        port: identity.port,
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      });
      await enrich(snapshot, open);
      return { ok: true, address, snapshot, auth: "open" };
    }

    // The device wants a key.
    const lockedUntil = keys.lockedOutUntil(identity.id);
    if (lockedUntil !== undefined) {
      return {
        ok: true,
        address,
        snapshot,
        auth: "locked-out",
        lockedOutUntil: lockedUntil,
      };
    }
    if (!keys.canAttempt(identity.id)) {
      return {
        ok: true,
        address,
        snapshot,
        auth: keys.hasKey(identity.id) ? "authorized" : "needs-key",
      };
    }

    // This is the device's one authenticated attempt for this cycle.
    keys.noteAttempt(identity.id);
    const authed = new DeviceClient({
      address,
      port: identity.port,
      key: keys.keyFor(identity.id),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    try {
      snapshot.info = await authed.systemInfo();
      snapshot.ota = await authed.otaStatus();
      keys.noteSuccess(identity.id);
      return { ok: true, address, snapshot, auth: "authorized" };
    } catch (error) {
      if (error instanceof DeviceHttpError) {
        if (error.status === 429) {
          const until = keys.markLockedOut(identity.id, error.retryAfterS);
          return {
            ok: true,
            address,
            snapshot,
            auth: "locked-out",
            lockedOutUntil: until,
            error: "device is throttling us after failed key attempts",
          };
        }
        if (error.status === 401 || error.status === 403) {
          // Do NOT try another key. That is how a device gets locked out.
          return {
            ok: true,
            address,
            snapshot,
            auth: "needs-key",
            error: "the stored key was rejected",
          };
        }
      }
      // Reachable, answered ping, but the protected call failed for some
      // other reason — still a live device, just less is known about it.
      return {
        ok: true,
        address,
        snapshot,
        auth: "authorized",
        error: message(error),
      };
    }
  }

  return { ok: false, auth: "unknown", error: lastError };
}

/** Best-effort extras; a failure here must not fail the probe. */
async function enrich(
  snapshot: DeviceSnapshot,
  client: DeviceClient,
): Promise<void> {
  try {
    snapshot.info = await client.systemInfo();
  } catch {
    // Older or busy firmware; ping already told us it is alive.
  }
  try {
    snapshot.ota = await client.otaStatus();
  } catch {
    // Same.
  }
}
