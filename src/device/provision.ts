/**
 * Write the fleet key to a device that has none (`auth.autoProvision`).
 *
 * Only a device whose public /system/ping says `auth: false` is touched: a
 * device with any key of its own already chose one, and overwriting it would
 * lock out whoever set it. The write itself needs no credential, because an
 * open device accepts PUT /config from anyone on the network -- which is the
 * exposure this setting exists to close.
 */

import { DeviceUnreachableError, type DeviceClient } from "./client.js";

/**
 * espOS accepts 8-64 bytes for httpd.api_key. Checked on the trimmed key,
 * because that is what KeyStore authenticates with afterwards.
 */
export function fleetKeyUsable(key: string): boolean {
  const bytes = Buffer.byteLength(key.trim(), "utf8");
  return bytes >= 8 && bytes <= 64;
}

export type ProvisionOutcome =
  | { result: "provisioned" }
  | { result: "skipped"; reason: string }
  | { result: "failed"; reason: string }
  /** Did not answer: worth trying again on a later cycle. */
  | { result: "unreachable"; reason: string };

/**
 * `client` must carry no key: a device that gained one since the ping then
 * answers 401 to a request with no credential, instead of counting a wrong
 * key towards its 5-in-60 s lockout.
 */
export async function provisionFleetKey(
  client: DeviceClient,
  rawKey: string,
): Promise<ProvisionOutcome> {
  const fleetKey = rawKey.trim();
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
    return failure(error);
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
    return failure(error);
  }
  return { result: "provisioned" };
}

function failure(error: unknown): ProvisionOutcome {
  const reason = error instanceof Error ? error.message : String(error);
  return error instanceof DeviceUnreachableError
    ? { result: "unreachable", reason }
    : { result: "failed", reason };
}
