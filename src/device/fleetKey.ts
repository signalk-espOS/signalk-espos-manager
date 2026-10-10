/**
 * Generating, replacing and removing the fleet key from the webapp.
 *
 * A device that may hold the old fleet key must not be stranded by the
 * change. Before anything else each one is given the old key as its own
 * stored key (a "fleet" pin), so the poller keeps reaching it with a key it
 * accepts. A pinned device is then moved to the current fleet key -- right
 * away when it is online, otherwise on a later poll cycle once it answers --
 * and the pin is dropped so it falls back to the fleet key. With no fleet key
 * the pins simply stay: removing the key never opens a device.
 */

import { randomBytes } from "node:crypto";
import type { DeviceRecord } from "../types.js";
import type { KeyStore } from "./auth.js";
import { DeviceHttpError, type DeviceClient } from "./client.js";
import { fleetKeyUsable } from "./provision.js";

/**
 * 24 random bytes as base64url: 32 characters, inside espOS's 8-64 byte
 * limit, and nothing a URL, a JSON string or a shell would need escaped.
 */
export function generateFleetKey(): string {
  return randomBytes(24).toString("base64url");
}

export interface FleetKeyChange {
  /** Devices that now hold the current fleet key. */
  updated: string[];
  /** Devices still on a previous key, pinned so they stay reachable. */
  kept: string[];
}

export interface MoveOptions {
  keys: KeyStore;
  devices: DeviceRecord[];
  /** A client carrying the key the plugin uses for this device. */
  clientFor: (id: string) => DeviceClient | undefined;
}

export interface ChangeFleetKeyOptions extends MoveOptions {
  /** "" removes the fleet key. */
  newKey: string;
  /** Persist the new key to the plugin configuration. */
  save: (key: string) => Promise<void>;
}

export async function changeFleetKey(
  options: ChangeFleetKeyOptions,
): Promise<FleetKeyChange> {
  const { keys, devices, save } = options;
  const oldKey = keys.fleetKey;
  const newKey = options.newKey.trim();
  if (newKey !== "" && !fleetKeyUsable(newKey)) {
    throw new Error("the fleet key must be 8 to 64 bytes");
  }
  if (newKey === oldKey) return { updated: [], kept: [] };

  // Every device that may hold the old key, not just one proven to this
  // cycle: auth starts "unknown" after a restart, and a device that is
  // offline or locked out right now can still be on it. An open device has
  // no key to lose. One that refused the old key was already being tried
  // with it every cycle, so pinning changes nothing for it.
  if (oldKey !== "") {
    for (const device of devices) {
      const id = device.identity.id;
      if (device.auth === "open" || keys.hasOwnKey(id)) continue;
      await keys.setKeyFor(id, oldKey, "fleet");
    }
  }

  await save(newKey);
  keys.setFleetKey(newKey);
  return moveToFleetKey(options);
}

/**
 * Give every pinned device that is online and accepts its pinned key the
 * current fleet key, then drop its pin. Called right after a change and on
 * every poll cycle, so a device offline during the change catches up.
 */
export async function moveToFleetKey(
  options: MoveOptions,
): Promise<FleetKeyChange> {
  const { keys, devices, clientFor } = options;
  const fleet = keys.fleetKey;
  const pinned = devices.filter(
    (d) => keys.pinnedFleetKey(d.identity.id) !== undefined,
  );
  const outcomes = await Promise.all(
    pinned.map(async (device): Promise<boolean> => {
      const id = device.identity.id;
      if (fleet === "") return false;
      if (keys.pinnedFleetKey(id) === fleet) {
        await keys.removeKeyFor(id);
        return true;
      }
      // Only a device whose pinned key worked on the last poll: a write with
      // a key it refuses would count towards its 5-in-60 s lockout.
      if (
        device.reachability !== "online" ||
        device.auth !== "authorized" ||
        keys.lockedOutUntil(id) !== undefined
      ) {
        return false;
      }
      const client = clientFor(id);
      if (client === undefined) return false;
      try {
        const { changed } = await client.putConfig({
          httpd: { api_key: fleet },
        });
        if (!changed.includes("httpd.api_key")) return false;
      } catch (error) {
        if (error instanceof DeviceHttpError && error.status === 429) {
          keys.markLockedOut(id, error.retryAfterS);
        }
        return false;
      }
      await keys.removeKeyFor(id);
      return true;
    }),
  );
  const updated: string[] = [];
  const kept: string[] = [];
  pinned.forEach((device, i) => {
    (outcomes[i] === true ? updated : kept).push(device.identity.id);
  });
  return { updated, kept };
}
