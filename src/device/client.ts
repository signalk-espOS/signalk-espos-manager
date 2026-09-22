/**
 * Typed HTTP client for one espOS device.
 *
 * Two rules encoded here, both learned from the firmware rather than guessed:
 *
 * 1. `GET /api/v1/system/ping` is public and returns `{app, version, auth}`.
 *    It is the ONLY trustworthy answer to "does this device need a key" — the
 *    mDNS `auth` TXT key is hardcoded to 0 in espOS and lies.
 * 2. Five wrong keys in 60 s earns a 30 s lockout, and setting a new key does
 *    NOT clear the throttle. So a key is tried at most once per cycle and
 *    never rotated through automatically.
 */

import type { OtaStatus, SystemInfo } from "../types.js";
import { parseOtaStatus, parsePing, parseSystemInfo } from "./parse.js";

export interface PingResult {
  app: string;
  version: string;
  authRequired: boolean;
}

export class DeviceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds the device asked us to wait, when it said. */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "DeviceHttpError";
  }
}

export interface DeviceClientOptions {
  address: string;
  port?: number;
  /** Bearer key, when the device has one set. */
  key?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8000;

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export class DeviceClient {
  private readonly base: string;
  private readonly key?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeviceClientOptions) {
    const port = options.port ?? 80;
    const host = options.address.includes(":")
      ? `[${options.address}]`
      : options.address;
    this.base = `http://${host}${port === 80 ? "" : `:${port}`}/api/v1`;
    this.key = options.key;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(
    path: string,
    init?: { method?: string; body?: unknown; authenticated?: boolean },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (init?.authenticated !== false && this.key !== undefined) {
        headers.Authorization = `Bearer ${this.key}`;
      }
      // espOS rejects a body without this; harmless on GET.
      if (init?.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method: init?.method ?? "GET",
        headers,
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        // espOS answers a rejected config with {"error","path","message"} --
        // an unknown key, which is what firmware too old for a setting says.
        // That is the whole explanation, and discarding it leaves a bare
        // "HTTP 400" to be guessed at. Best-effort: a device that answers
        // with no body, or with something that is not JSON, still gets the
        // plain status.
        let detail = "";
        try {
          const body = (await response.json()) as unknown;
          if (typeof body === "object" && body !== null) {
            const b = body as Record<string, unknown>;
            const msg = typeof b["message"] === "string" ? b["message"] : "";
            const where = typeof b["path"] === "string" ? b["path"] : "";
            if (msg !== "") {
              detail = where === "" ? `: ${msg}` : `: ${where} \u2014 ${msg}`;
            }
          }
        } catch {
          // No body, or not JSON. The status is all we have.
        }
        throw new DeviceHttpError(
          `device answered HTTP ${response.status} for ${path}${detail}`,
          response.status,
          retryAfterSeconds(response),
        );
      }
      if (response.status === 204) return undefined;
      const text = await response.text();
      if (text.trim() === "") return undefined;
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Public probe. Never sends the key, so it works even when auth is broken. */
  async ping(): Promise<PingResult> {
    return parsePing(
      await this.request("/system/ping", { authenticated: false }),
    );
  }

  async systemInfo(): Promise<SystemInfo> {
    return parseSystemInfo(await this.request("/system/info"));
  }

  async otaStatus(): Promise<OtaStatus> {
    return parseOtaStatus(await this.request("/ota/status"));
  }

  /** Ask the device to re-read its manifest. Returns immediately (202). */
  async otaCheck(): Promise<void> {
    await this.request("/ota/check", { method: "POST", body: {} });
  }

  /**
   * Install a specific image. Always pass an explicit URL rather than `{}`:
   * `{}` installs whatever the device's own last check found, which depends
   * on it having checked OUR manifest.
   */
  async otaInstall(url: string): Promise<void> {
    await this.request("/ota", { method: "POST", body: { url } });
  }

  async otaConfirm(): Promise<void> {
    await this.request("/ota/confirm", { method: "POST", body: {} });
  }

  async otaRollback(): Promise<void> {
    await this.request("/ota/rollback", { method: "POST", body: {} });
  }

  /** Full device configuration, namespace by namespace. */
  async getConfig(): Promise<Record<string, unknown>> {
    const raw = await this.request("/config");
    return typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  }

  /**
   * Merge configuration into the device.
   *
   * espOS calls `espos_config_import_json(..., ignore_unknown=false, ...)`, so
   * this merges the namespaces given rather than replacing the config — but an
   * unrecognised key fails the whole request with 400 and the offending path.
   * The response says exactly what changed, which is better evidence than a
   * 200 and a read-back.
   */
  async putConfig(
    config: Record<string, unknown>,
  ): Promise<{ changed: string[]; restartRequired: boolean }> {
    const raw = await this.request("/config", { method: "PUT", body: config });
    const body =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    const changed = Array.isArray(body.changed)
      ? body.changed.filter((v): v is string => typeof v === "string")
      : [];
    return {
      changed,
      restartRequired: body.restart_required === true,
    };
  }
}
