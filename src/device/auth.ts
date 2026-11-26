/**
 * Device key storage and the attempt policy.
 *
 * The policy exists because of how espOS throttles: five wrong keys within
 * 60 seconds earns a 30-second lockout, and — verified in the firmware's
 * auth_policy.c — *setting a new key does not clear the throttle*. So a
 * plugin that tries the fleet key, then each stored key, then retries next
 * cycle, will lock a device out permanently and have no way back.
 *
 * Hence: at most one key attempt per device per cycle, no automatic
 * rotation through candidate keys, and a hard stop while locked out.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeviceId } from "../types.js";

/** Seconds to stay quiet after a 429 when the device does not say. */
const DEFAULT_LOCKOUT_S = 30;

interface StoredKey {
  key: string;
  setAt: number;
  /**
   * "fleet": a previous fleet key the device was left on when the fleet key
   * changed, kept until it can be moved to the current one.
   */
  source: "fleet" | "manual";
}

interface KeyFile {
  version: 1;
  keys: Record<DeviceId, StoredKey>;
}

export interface KeyStoreOptions {
  /** Plugin data directory; the file lands in <dataDir>/keys.json. */
  dataDir: string;
  now?: () => number;
}

/**
 * Per-device keys on disk plus the fleet key from config.
 *
 * Keys never leave this object: the HTTP API exposes `hasKey` and nothing
 * more, so a compromised admin session cannot read them back out.
 */
export class KeyStore {
  private readonly path: string;
  private readonly now: () => number;
  private keys: Record<DeviceId, StoredKey> = {};
  private fleet = "";
  /** Cached in-flight read, so concurrent callers share one load. */
  private loading?: Promise<void>;
  /** Device -> epoch ms until which no authenticated call may be made. */
  private readonly lockouts = new Map<DeviceId, number>();
  /** Device -> cycle token of the last attempt, so we try at most once. */
  private readonly attempted = new Set<DeviceId>();
  /**
   * Device -> the keys it answered 401 to, so none is sent again, each with
   * the refusal's sequence number. Kept per key: a late refusal of an old
   * key must not replace that of the current one.
   */
  private readonly refused = new Map<DeviceId, Map<string, number>>();
  private refusals = 0;
  /** Device -> the key it last accepted. */
  private readonly accepted = new Map<DeviceId, string>();

  constructor(options: KeyStoreOptions) {
    this.path = join(options.dataDir, "keys.json");
    this.now = options.now ?? Date.now;
  }

  /**
   * Read the stored keys, at most once.
   *
   * The in-flight promise is cached rather than a boolean flag being set
   * before the await: with a flag, a second caller returns immediately while
   * the first read is still pending, and a setKeyFor() in that window writes
   * a key that the arriving disk contents then overwrite — silently losing a
   * key the user had just entered.
   */
  async load(): Promise<void> {
    this.loading ??= this.readFromDisk();
    return this.loading;
  }

  private async readFromDisk(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        typeof raw === "object" &&
        raw !== null &&
        "keys" in raw &&
        typeof (raw as KeyFile).keys === "object"
      ) {
        this.keys = (raw as KeyFile).keys;
      }
    } catch {
      // No file yet, or unreadable — start empty rather than failing start().
      this.keys = {};
    }
  }

  setFleetKey(key: string): void {
    this.fleet = key.trim();
  }

  /** The fleet key in use; "" when there is none. */
  get fleetKey(): string {
    return this.fleet;
  }

  /** The previous fleet key this device is still on, if it is. */
  pinnedFleetKey(id: DeviceId): string | undefined {
    const stored = this.keys[id];
    return stored?.source === "fleet" && stored.key !== ""
      ? stored.key
      : undefined;
  }

  /** The key to use for a device: its own if stored, else the fleet key. */
  keyFor(id: DeviceId): string | undefined {
    const own = this.keys[id]?.key;
    if (own !== undefined && own !== "") return own;
    return this.fleet !== "" ? this.fleet : undefined;
  }

  hasKey(id: DeviceId): boolean {
    return this.keyFor(id) !== undefined;
  }

  /** True when this device has its own key rather than using the fleet one. */
  hasOwnKey(id: DeviceId): boolean {
    const own = this.keys[id]?.key;
    return own !== undefined && own !== "";
  }

  async setKeyFor(
    id: DeviceId,
    key: string,
    source: "fleet" | "manual" = "manual",
  ): Promise<void> {
    await this.load();
    this.keys[id] = { key, setAt: this.now(), source };
    await this.persist();
    // A newly supplied key deserves a fresh attempt, but the device's own
    // throttle may still be running — that is its decision, not ours.
    this.attempted.delete(id);
  }

  async removeKeyFor(id: DeviceId): Promise<void> {
    await this.load();
    if (this.keys[id] === undefined) return;
    delete this.keys[id];
    await this.persist();
  }

  private async persist(): Promise<void> {
    const payload: KeyFile = { version: 1, keys: this.keys };
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    // 0600: these are credentials for hardware on the boat.
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  /** Note a 429 and stay quiet until the device says we may return. */
  markLockedOut(id: DeviceId, retryAfterS?: number): number {
    const until = this.now() + (retryAfterS ?? DEFAULT_LOCKOUT_S) * 1000;
    this.lockouts.set(id, until);
    return until;
  }

  lockedOutUntil(id: DeviceId): number | undefined {
    const until = this.lockouts.get(id);
    if (until === undefined) return undefined;
    if (until <= this.now()) {
      this.lockouts.delete(id);
      return undefined;
    }
    return until;
  }

  /**
   * May we make an authenticated call to this device right now?
   *
   * False while locked out, and false if we already tried this cycle —
   * the two rules that together make a permanent lockout impossible.
   */
  canAttempt(id: DeviceId): boolean {
    if (this.lockedOutUntil(id) !== undefined) return false;
    if (this.attempted.has(id)) return false;
    return this.hasKey(id);
  }

  /** Record that this device's one attempt for the cycle has been used. */
  noteAttempt(id: DeviceId): void {
    this.attempted.add(id);
  }

  /** Called once per poll cycle: everyone gets one attempt again. */
  beginCycle(): void {
    this.attempted.clear();
  }

  /** Mark taken before a probe, for {@link noteSuccess}. */
  refusalMark(): number {
    return this.refusals;
  }

  /**
   * A working key clears the lockout bookkeeping for that device. With
   * `since` (a {@link refusalMark} taken before the request), a refusal of
   * the same key recorded while the request was in flight stands: the device
   * refused it later than it accepted it.
   */
  noteSuccess(id: DeviceId, key?: string, since?: number): void {
    this.lockouts.delete(id);
    if (key === undefined) return;
    const refusedAt = this.refused.get(id)?.get(key);
    if (since !== undefined && refusedAt !== undefined && refusedAt > since) {
      return;
    }
    this.refused.get(id)?.delete(key);
    this.accepted.set(id, key);
  }

  /**
   * The device answered 401 to `key`: the one that was sent, which a key
   * change while the request was in flight can have made a different one
   * from the current key.
   */
  noteRefused(id: DeviceId, key: string): void {
    if (this.accepted.get(id) === key) this.accepted.delete(id);
    let keys = this.refused.get(id);
    if (keys === undefined) this.refused.set(id, (keys = new Map()));
    keys.set(key, ++this.refusals);
  }

  /** Has the device accepted `key` before? */
  keyAccepted(id: DeviceId, key: string): boolean {
    return this.accepted.get(id) === key;
  }

  /**
   * The key to send on another plugin's behalf, if it may be sent now: not
   * while the device is locked out, and not a key it already refused. Each
   * refusal is a strike towards the device's lockout, and a mirror polling
   * once a second would earn one within seconds. A different key (a new
   * fleet key, one entered by hand) is sent again.
   */
  keyToSend(id: DeviceId): string | undefined {
    if (this.lockedOutUntil(id) !== undefined) return undefined;
    const key = this.keyFor(id);
    if (key === undefined || this.refused.get(id)?.has(key) === true) {
      return undefined;
    }
    return key;
  }
}
