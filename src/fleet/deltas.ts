/**
 * Publish a little of what we know into the Signal K data model, so a
 * dashboard can show "two devices need updating" without an admin login.
 *
 * Deliberately a handful of values per device, not the whole record: the data
 * model is for consumers, and the detail belongs in the plugin's own API.
 */

import type { Path, PathValue, ServerAPI } from "@signalk/server-api";
import type { DeviceRecord } from "../types.js";

/** Signal K path segments must not contain dots or spaces. */
function sanitize(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, "-");
}

export function publishFleetDeltas(
  app: ServerAPI,
  pluginId: string,
  devices: DeviceRecord[],
): void {
  const values: PathValue[] = [];

  for (const device of devices) {
    const key = sanitize(device.identity.id);
    const base = `espos-manager.${key}`;
    values.push({
      path: `${base}.online` as Path,
      value: device.reachability === "online",
    });
    if (device.snapshot?.version !== undefined) {
      values.push({
        path: `${base}.firmwareVersion` as Path,
        value: device.snapshot.version,
      });
    }
    if (device.snapshot?.app !== undefined) {
      values.push({
        path: `${base}.project` as Path,
        value: device.snapshot.app,
      });
    }
    values.push({
      path: `${base}.updateAvailable` as Path,
      value: device.update !== undefined,
    });
  }

  values.push({
    path: "espos-manager.deviceCount" as Path,
    value: devices.length,
  });
  values.push({
    path: "espos-manager.updatesAvailable" as Path,
    value: devices.filter((device) => device.update !== undefined).length,
  });

  if (values.length === 0) return;
  app.handleMessage(pluginId, { updates: [{ values }] });
}
