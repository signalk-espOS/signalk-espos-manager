/**
 * Fleet-state and poller tests.
 *
 * Two of these are regressions for bugs found only by running the plugin
 * against the real network rather than by reading the code:
 *
 * 1. The first cycle ran before mDNS had answered, so a user with three
 *    devices was told none were found.
 * 2. The poll timer was unref'd, which stops it firing whenever nothing else
 *    holds the event loop — masked inside a Signal K server by its HTTP
 *    listener, so it would have failed only in harnesses and quiet processes.
 */

import { describe, expect, it } from "vitest";
import {
  deriveReachability,
  FleetState,
  shouldForget,
} from "../src/fleet/state.js";
import { isProvisionalId, provisionalId } from "../src/fleet/poller.js";
import type { DeviceIdentity, DeviceSnapshot } from "../src/types.js";

const WINDOWS = { pollIntervalS: 60, offlineAfterS: 180 };
const NOW = 1_758_400_000_000;

function identity(id: string, address = "192.168.0.167"): DeviceIdentity {
  return { id, addresses: [address], port: 80, sources: { mdns: NOW } };
}

function snapshot(version = "1.2.0"): DeviceSnapshot {
  return {
    probedAt: NOW,
    app: "cockpit",
    version,
    authRequired: false,
  };
}

describe("deriveReachability", () => {
  it("is online just after a successful probe", () => {
    expect(
      deriveReachability(
        { lastOkProbeAt: NOW - 1000, lastSeenAt: NOW, consecutiveFailures: 0 },
        WINDOWS,
        NOW,
      ),
    ).toBe("online");
  });

  it("goes stale past 1.5 poll intervals", () => {
    expect(
      deriveReachability(
        {
          lastOkProbeAt: NOW - 100_000, // 100 s > 90 s, < 180 s
          lastSeenAt: NOW - 100_000,
          consecutiveFailures: 1,
        },
        WINDOWS,
        NOW,
      ),
    ).toBe("stale");
  });

  it("goes offline past the offline window", () => {
    expect(
      deriveReachability(
        {
          lastOkProbeAt: NOW - 400_000,
          lastSeenAt: NOW - 400_000,
          consecutiveFailures: 1,
        },
        WINDOWS,
        NOW,
      ),
    ).toBe("offline");
  });

  it("is unreachable, not offline, when it is announced but never answers", () => {
    // "There but broken" and "gone" need opposite fixes, so they must not
    // collapse into one state.
    expect(
      deriveReachability(
        { lastOkProbeAt: undefined, lastSeenAt: NOW, consecutiveFailures: 4 },
        WINDOWS,
        NOW,
      ),
    ).toBe("unreachable");
  });

  it("is offline when never probed and long unseen", () => {
    expect(
      deriveReachability(
        {
          lastOkProbeAt: undefined,
          lastSeenAt: NOW - 400_000,
          consecutiveFailures: 0,
        },
        WINDOWS,
        NOW,
      ),
    ).toBe("offline");
  });
});

describe("shouldForget", () => {
  it("keeps a recently seen device", () => {
    expect(shouldForget({ lastSeenAt: NOW - 1000 }, 720, NOW)).toBe(false);
  });

  it("drops a device unseen beyond the window", () => {
    expect(
      shouldForget({ lastSeenAt: NOW - 721 * 3600 * 1000 }, 720, NOW),
    ).toBe(true);
  });

  it("counts a successful probe as being seen", () => {
    expect(
      shouldForget({ lastSeenAt: 0, lastOkProbeAt: NOW - 1000 }, 720, NOW),
    ).toBe(false);
  });
});

describe("FleetState", () => {
  it("distinguishes 'looking' from 'found nothing'", () => {
    // Regression: the status line said "no devices found" before the first
    // cycle had run, which reads as a broken plugin.
    const fleet = new FleetState();
    expect(fleet.summary()).toMatch(/looking/i);
    fleet.markPolled();
    expect(fleet.summary()).toMatch(/no espOS devices found/i);
  });

  it("summarises a populated fleet", () => {
    const fleet = new FleetState();
    fleet.applyIdentities(new Map([["2be9", identity("2be9")]]), NOW);
    fleet.recordSuccess("2be9", snapshot(), "open", NOW);
    fleet.refreshReachability(WINDOWS, 720, NOW);
    expect(fleet.summary()).toBe("1 device, 1 online");
  });

  it("counts devices that need a key", () => {
    const fleet = new FleetState();
    fleet.applyIdentities(
      new Map([
        ["2be9", identity("2be9")],
        ["6f19", identity("6f19", "192.168.0.118")],
      ]),
      NOW,
    );
    fleet.recordSuccess("2be9", snapshot(), "open", NOW);
    fleet.recordSuccess("6f19", snapshot(), "needs-key", NOW);
    fleet.refreshReachability(WINDOWS, 720, NOW);
    expect(fleet.summary()).toMatch(/1 need a key/);
  });

  it("keeps the last good snapshot when a probe fails", () => {
    // An offline device must still show which firmware it was running, so an
    // update can be queued for when it returns.
    const fleet = new FleetState();
    fleet.applyIdentities(new Map([["2be9", identity("2be9")]]), NOW);
    fleet.recordSuccess("2be9", snapshot("1.2.0"), "open", NOW);
    fleet.recordFailure("2be9", "connect ECONNREFUSED");

    const record = fleet.get("2be9");
    expect(record?.snapshot?.version).toBe("1.2.0");
    expect(record?.consecutiveFailures).toBe(1);
    expect(record?.lastError).toMatch(/ECONNREFUSED/);
  });

  it("does not treat a failed probe as a sighting", () => {
    const fleet = new FleetState();
    fleet.applyIdentities(new Map([["2be9", identity("2be9")]]), NOW);
    const before = fleet.get("2be9")?.lastSeenAt;
    fleet.recordFailure("2be9", "timeout");
    expect(fleet.get("2be9")?.lastSeenAt).toBe(before);
  });

  it("drops a device that has been gone too long", () => {
    const fleet = new FleetState();
    fleet.applyIdentities(
      new Map([["2be9", { ...identity("2be9"), sources: { mdns: 1 } }]]),
      1,
    );
    fleet.refreshReachability(WINDOWS, 1, NOW);
    expect(fleet.get("2be9")).toBeUndefined();
  });

  it("notifies listeners and can be unsubscribed", () => {
    const fleet = new FleetState();
    let calls = 0;
    const off = fleet.onChange(() => {
      calls += 1;
    });
    fleet.applyIdentities(new Map([["2be9", identity("2be9")]]), NOW);
    expect(calls).toBe(1);
    off();
    fleet.applyIdentities(new Map([["2be9", identity("2be9")]]), NOW);
    expect(calls).toBe(1);
  });

  it("survives a listener that throws", () => {
    const fleet = new FleetState();
    fleet.onChange(() => {
      throw new Error("boom");
    });
    let reached = false;
    fleet.onChange(() => {
      reached = true;
    });
    expect(() => {
      fleet.applyIdentities(new Map([["2be9", identity("2be9")]]), NOW);
    }).not.toThrow();
    expect(reached).toBe(true);
  });
});

describe("provisional ids", () => {
  it("marks a device known only by address", () => {
    // Verified on 0.7.x/0.9.x firmware: no REST endpoint reports the short id
    // or the MAC, so a static host cannot be named until mDNS says so.
    const id = provisionalId("10.0.0.5", 80);
    expect(isProvisionalId(id)).toBe(true);
    expect(id).toContain("10.0.0.5");
  });

  it("does not mistake a real espOS id for a provisional one", () => {
    expect(isProvisionalId("2be9")).toBe(false);
  });
});
