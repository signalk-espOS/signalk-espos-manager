/**
 * Write the fleet key to a device that has none (`auth.autoProvision`).
 *
 * Only a device whose public /system/ping says `auth: false` is touched: a
 * device with any key of its own already chose one, and overwriting it would
 * lock out whoever set it. The write itself needs no credential, because an
 * open device accepts PUT /config from anyone on the network -- which is the
 * exposure this setting exists to close.
 */

import type { DeviceClient } from "./client.js";

/** espOS accepts 8-64 characters for httpd.api_key. */
export function fleetKeyUsable(key: string): boolean {
  return key.length >= 8 && key.length <= 64;
}

export type ProvisionOutcome =
  | { result: "provisioned" }
  | { result: "skipped"; reason: string }
  | { result: "failed"; reason: string };

export async function provisionFleetKey(
  client: DeviceClient,
  fleetKey: string,
): Promise<ProvisionOutcome> {
  if (!fleetKeyUsable(fleetKey)) {
    return {
      result: "skipped",
      reason: "the fleet key must be 8 to 64 characters",
    };
  }
  // Re-ask right before writing: the poll that reported this device open may
  // be a minute old, and someone may have set a key in its web UI since.
  let ping;
  try {
    ping = await client.ping();
  } catch (error) {
    return { result: "failed", reason: errorText(error) };
  }
  if (ping.authRequired) {
    return { result: "skipped", reason: "the device already has a key" };
  }
  try {
    const { changed } = await client.putConfig({
      httpd: { api_key: fleetKey },
    });
    if (!changed.includes("httpd.api_key")) {
      return {
        result: "failed",
        reason: "the device accepted the write but reports no key change",
      };
    }
  } catch (error) {
    return { result: "failed", reason: errorText(error) };
  }
  return { result: "provisioned" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
