/**
 * The in-memory fleet: one DeviceRecord per known device, plus the pure rules
 * for deriving reachability from timestamps.
 *
 * Reachability is derived, never assigned by an event. An mDNS goodbye, a
 * failed probe or a missing announcement are all inputs; the only question
 * that matters is "when did we last successfully talk to it", and that is a
 * timestamp comparison.
 */

import type {
  DeviceId,
  DeviceIdentity,
  DeviceRecord,
  DeviceSnapshot,
  Reachability,
} from "../types.js";

export interface ReachabilityWindows {
  /** Seconds between polls; a device is stale past 1.5x this. */
  pollIntervalS: number;
  /** Seconds without a successful probe before the device is offline. */
  offlineAfterS: number;
}

/**
 * Work out how current our knowledge of a device is.
 *
 * `unreachable` is deliberately distinct from `offline`: a device that
 * answers TCP but fails every probe is a different problem (wrong key, broken
 * firmware, half-open wifi) from one that is simply not there, and they need
 * opposite fixes.
 */
export function deriveReachability(
  record: Pick<
    DeviceRecord,
    "lastOkProbeAt" | "lastSeenAt" | "consecutiveFailures"
  >,
  windows: ReachabilityWindows,
  now: number,
): Reachability {
  const { lastOkProbeAt, lastSeenAt, consecutiveFailures } = record;

  if (lastOkProbeAt === undefined) {
    // Never successfully probed. If something is announcing it, the device is
    // there but we cannot use it; otherwise it is simply absent.
    if (consecutiveFailures >= 3) return "unreachable";
    return now - lastSeenAt <= windows.offlineAfterS * 1000
      ? "unreachable"
      : "offline";
  }

  const sinceOk = now - lastOkProbeAt;
  if (sinceOk <= windows.pollIntervalS * 1500) return "online";
  if (sinceOk >= windows.offlineAfterS * 1000) {
    // Failing repeatedly while still being announced means "there but
    // broken", which is worth saying differently from "gone".
    return consecutiveFailures >= 3 &&
      now - lastSeenAt <= windows.offlineAfterS * 1000
      ? "unreachable"
      : "offline";
  }
  return "stale";
}

/** Should this device be dropped from the list entirely? */
export function shouldForget(
  record: Pick<DeviceRecord, "lastSeenAt" | "lastOkProbeAt">,
  forgetAfterH: number,
  now: number,
): boolean {
  const last = Math.max(record.lastSeenAt, record.lastOkProbeAt ?? 0);
  return now - last > forgetAfterH * 3600 * 1000;
}

/** Mutable fleet registry. Pure data plus change notification. */
export class FleetState {
  private readonly devices = new Map<DeviceId, DeviceRecord>();
  private readonly listeners = new Set<() => void>();
  /** Non-fatal oddities worth showing in the UI (id collisions and such). */
  private warnings: string[] = [];

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not stop the others.
      }
    }
  }

  get size(): number {
    return this.devices.size;
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()].sort((a, b) =>
      a.identity.id.localeCompare(b.identity.id),
    );
  }

  get(id: DeviceId): DeviceRecord | undefined {
    return this.devices.get(id);
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  setWarnings(warnings: string[]): void {
    this.warnings = [...warnings];
  }

  /** Fold merged identities in, creating records for devices we had not seen. */
  applyIdentities(
    identities: Map<DeviceId, DeviceIdentity>,
    now: number,
  ): void {
    for (const [id, identity] of identities) {
      const existing = this.devices.get(id);
      const lastSighting = Math.max(
        0,
        ...Object.values(identity.sources).filter(
          (value): value is number => typeof value === "number",
        ),
      );
      if (existing === undefined) {
        this.devices.set(id, {
          identity,
          reachability: "offline",
          auth: "unknown",
          lastSeenAt: lastSighting === 0 ? now : lastSighting,
          consecutiveFailures: 0,
        });
      } else {
        existing.identity = identity;
        if (lastSighting > existing.lastSeenAt) {
          existing.lastSeenAt = lastSighting;
        }
      }
    }
    this.notify();
  }

  /** Record a successful probe. */
  recordSuccess(
    id: DeviceId,
    snapshot: DeviceSnapshot,
    auth: DeviceRecord["auth"],
    now: number,
  ): void {
    const record = this.devices.get(id);
    if (record === undefined) return;
    record.snapshot = snapshot;
    record.auth = auth;
    record.lastOkProbeAt = now;
    record.lastSeenAt = now;
    record.consecutiveFailures = 0;
    record.lastError = undefined;
    this.notify();
  }

  /**
   * Record a failed probe. Note this does NOT clear the last good snapshot:
   * an offline device should still show which firmware it was running, so an
   * update can be queued for when it comes back.
   */
  recordFailure(id: DeviceId, error: string): void {
    const record = this.devices.get(id);
    if (record === undefined) return;
    record.consecutiveFailures += 1;
    record.lastError = error;
    // lastSeenAt is deliberately untouched: a failed probe is not a sighting,
    // and moving it would keep a dead device looking freshly seen forever.
    this.notify();
  }

  setAuth(id: DeviceId, auth: DeviceRecord["auth"], until?: number): void {
    const record = this.devices.get(id);
    if (record === undefined) return;
    record.auth = auth;
    record.lockedOutUntil = until;
    this.notify();
  }

  /** Recompute reachability for every device and drop the long-gone ones. */
  refreshReachability(
    windows: ReachabilityWindows,
    forgetAfterH: number,
    now: number,
  ): void {
    for (const [id, record] of this.devices) {
      if (shouldForget(record, forgetAfterH, now)) {
        this.devices.delete(id);
        continue;
      }
      record.reachability = deriveReachability(record, windows, now);
    }
    this.notify();
  }

  forget(id: DeviceId): boolean {
    const removed = this.devices.delete(id);
    if (removed) this.notify();
    return removed;
  }

  /** True once at least one poll cycle has completed. */
  private polled = false;

  markPolled(): void {
    this.polled = true;
  }

  /** One-line summary for the plugin status area. */
  summary(): string {
    const all = this.list();
    if (all.length === 0) {
      // "Looking" and "looked and found nothing" are different things to
      // tell a user who is watching the status line right after enabling.
      return this.polled
        ? "no espOS devices found on the network"
        : "looking for espOS devices...";
    }
    const online = all.filter((d) => d.reachability === "online").length;
    const needKey = all.filter((d) => d.auth === "needs-key").length;
    const parts = [`${all.length} device${all.length === 1 ? "" : "s"}`];
    parts.push(`${online} online`);
    if (needKey > 0) parts.push(`${needKey} need a key`);
    return parts.join(", ");
  }
}
