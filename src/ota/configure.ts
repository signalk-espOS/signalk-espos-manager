/**
 * Point a device at this server's firmware mirror.
 *
 * Both live devices on the boat were found with:
 *
 *   manifest_src  = "url"
 *   manifest_url  = ""
 *   manifest_path = "/plugins/signalk-espos-updates/manifest.json"
 *
 * Three separate problems in one config. The path names a plugin that never
 * shipped; `/plugins/*` is admin-gated so a device holding a device token
 * cannot read it anyway; and because `manifest_src` defaults to `url` with an
 * empty `manifest_url`, the device is not even looking at that path — it is
 * looking nowhere. Writing the path alone would fix nothing, so both fields
 * are always written together.
 */

import { DeviceUnreachableError, type DeviceClient } from "../device/client.js";
import type { AppName, Channel } from "../types.js";
import { manifestPathFor, manifestUrlFits } from "../mirror/manifest.js";

export interface ConfigureOtaOptions {
  client: DeviceClient;
  app: AppName;
  channel: Channel;
  /** Public base path of the mirror, e.g. /signalk-espos-manager/fw. */
  publicBase: string;
  /**
   * How this device reaches the server, as scheme://host[:port]. Used only to
   * check the assembled URL fits the device's 168-byte buffer before writing.
   */
  origin?: string;
  /** Leave auto-install alone unless explicitly set. */
  autoInstall?: boolean;
  /**
   * Wait before the one retry after the device did not answer. A device
   * listed as online may be mid-reboot -- just flashed, or restarting after a
   * config change -- and answers a few seconds later.
   */
  retryDelayMs?: number;
}

export interface ConfigureOtaResult {
  manifestPath: string;
  /**
   * Config keys the accepted write reports changing. Empty when an earlier
   * write took effect but its reply was lost, so there was nothing left to
   * write; `applied` is the authority on the resulting config.
   */
  changed: string[];
  /** The device needs a restart for the change to take effect. */
  restartRequired: boolean;
  /** What the device reports now, read back after the write. */
  applied: {
    manifestSrc?: string;
    manifestPath?: string;
    manifestUrl?: string;
    channel?: string;
  };
}

const DEFAULT_RETRY_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A last attempt: a device that still does not answer gets the advice. */
async function lastAttempt<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof DeviceUnreachableError)) throw error;
    throw new Error(
      `${error.message} — if it has just been flashed or restarted, give it ` +
        `a few seconds and try again`,
      { cause: error },
    );
  }
}

async function retryOnceIfUnreachable<T>(
  request: () => Promise<T>,
  delayMs: number,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof DeviceUnreachableError)) throw error;
  }
  await sleep(delayMs);
  return lastAttempt(request);
}

/**
 * Write the OTA source config, then confirm the device took it.
 *
 * `PUT /api/v1/config` answers with the list of keys it actually changed and
 * whether a restart is needed, and rejects an unknown key with 400 naming the
 * path. Both are stronger evidence than a bare 200, so the result is checked
 * against what was asked for rather than assumed — and then read back, because
 * a key already holding the right value is correctly absent from `changed`.
 */
export async function configureOta(
  options: ConfigureOtaOptions,
): Promise<ConfigureOtaResult> {
  const path = manifestPathFor(options.app, options.publicBase);

  if (options.origin !== undefined) {
    const fits = manifestUrlFits(options.origin, path);
    if (!fits.ok) {
      // Better to refuse than to write a value the device will truncate into
      // something that fetches the wrong thing, or nothing.
      throw new Error(`cannot point this device at the mirror: ${fits.reason}`);
    }
  }

  const ota: Record<string, unknown> = {
    manifest_src: "signalk",
    manifest_path: path,
    channel: options.channel,
  };
  if (options.autoInstall !== undefined) {
    ota.auto_install = options.autoInstall;
  }

  // Requests are retried only when the device did not answer at all. An HTTP
  // error is the device's considered answer; asking again would only repeat
  // it.
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const holdsRequested = (config: Record<string, unknown>): boolean => {
    const current = (config.ota ?? {}) as Record<string, unknown>;
    return Object.entries(ota).every(([key, value]) => current[key] === value);
  };

  let write: { changed: string[]; restartRequired: boolean };
  let seen: Record<string, unknown> | undefined;
  try {
    write = await options.client.putConfig({ ota });
  } catch (error) {
    if (!(error instanceof DeviceUnreachableError)) throw error;
    await sleep(retryDelayMs);
    // The write may have taken effect with only its reply lost. Look before
    // sending it again, so a change that landed is not repeated.
    seen = await retryOnceIfUnreachable(
      () => options.client.getConfig(),
      retryDelayMs,
    );
    if (holdsRequested(seen)) {
      write = { changed: [], restartRequired: false };
    } else {
      write = await lastAttempt(() => options.client.putConfig({ ota }));
      seen = undefined; // read before this write, so stale now
    }
  }
  // A key that already held the right value is legitimately absent from
  // `changed`, so the write report alone cannot confirm the outcome — read the
  // config back and compare against what was asked for.
  const after =
    seen ??
    (await retryOnceIfUnreachable(
      () => options.client.getConfig(),
      retryDelayMs,
    ));
  const applied = (after.ota ?? {}) as Record<string, unknown>;
  const appliedPath =
    typeof applied.manifest_path === "string"
      ? applied.manifest_path
      : undefined;
  const appliedSrc =
    typeof applied.manifest_src === "string" ? applied.manifest_src : undefined;

  if (appliedSrc !== "signalk" || appliedPath !== path) {
    throw new Error(
      `the device did not accept the update source: it reports ` +
        `manifest_src=${String(appliedSrc)} manifest_path=${String(appliedPath)}`,
    );
  }

  return {
    manifestPath: path,
    changed: write.changed,
    restartRequired: write.restartRequired,
    applied: {
      manifestSrc: appliedSrc,
      manifestPath: appliedPath,
      manifestUrl:
        typeof applied.manifest_url === "string"
          ? applied.manifest_url
          : undefined,
      channel:
        typeof applied.channel === "string" ? applied.channel : undefined,
    },
  };
}

/**
 * True when a device's OTA config points somewhere it cannot actually read.
 *
 * Used to flag the devices in the field that still carry the stale default, so
 * the UI can offer a one-click repair rather than leaving an operator to
 * wonder why a device never finds an update.
 */
export function needsOtaRepair(
  manifestSrc: string | undefined,
  manifestPath: string | undefined,
  manifestUrl: string | undefined,
  expectedPath: string,
): { needed: boolean; reason?: string } {
  if (manifestSrc === "signalk" && manifestPath === expectedPath) {
    return { needed: false };
  }
  if (manifestSrc === "url" && (manifestUrl ?? "") === "") {
    return {
      needed: true,
      reason: "this device is not looking for updates anywhere",
    };
  }
  if ((manifestPath ?? "").startsWith("/plugins/")) {
    return {
      needed: true,
      reason:
        "this device looks for updates under /plugins/, which requires an " +
        "administrator login it does not have",
    };
  }
  if (manifestSrc === "url") {
    return {
      needed: true,
      reason: `this device looks for updates at ${String(manifestUrl)}`,
    };
  }
  if ((manifestPath ?? "") === "") {
    return {
      needed: true,
      reason: "this device has no update source configured",
    };
  }
  return {
    needed: true,
    reason: `this device looks for updates at ${String(manifestPath)}`,
  };
}
