/**
 * Probe and auth-policy tests against a real HTTP server.
 *
 * The lockout cases are the reason this file exists. espOS locks a device out
 * after five wrong keys in 60 s, and setting a new key does not clear the
 * throttle — so "try the fleet key, then each stored key" would brick our own
 * access to a device permanently. These tests prove we try once and stop.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyStore } from "../src/device/auth.js";
import { probeDevice } from "../src/device/probe.js";
import type { DeviceIdentity } from "../src/types.js";
import { startFakeDevice, type FakeDevice } from "./helpers/fakeDevice.js";

let dataDir: string;
let device: FakeDevice | undefined;

beforeEach(async () => {
  // Scratch dir under the user's dev tmp, never the RAM-backed /tmp.
  dataDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "espos-keys-"));
});

afterEach(async () => {
  await device?.close();
  device = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

function identityFor(d: FakeDevice, id = "2be9"): DeviceIdentity {
  return {
    id,
    addresses: [d.address],
    port: d.port,
    sources: { mdns: Date.now() },
  };
}

async function freshKeys(): Promise<KeyStore> {
  const keys = new KeyStore({ dataDir });
  await keys.load();
  keys.beginCycle();
  return keys;
}

describe("probeDevice against an open device", () => {
  it("reads everything without a key", async () => {
    device = await startFakeDevice({ app: "cockpit", version: "1.2.0" });
    const result = await probeDevice({
      identity: identityFor(device),
      keys: await freshKeys(),
      hints: { espos: "0.10.0", target: "esp32p4" },
    });

    expect(result.ok).toBe(true);
    expect(result.auth).toBe("open");
    expect(result.snapshot?.app).toBe("cockpit");
    expect(result.snapshot?.authRequired).toBe(false);
    expect(result.snapshot?.info?.chip).toBe("esp32p4");
    expect(result.snapshot?.ota?.state).toBe("idle");
    // The espOS version comes from mDNS, because /system/info omits it.
    expect(result.snapshot?.esposVersion).toBe("0.10.0");
  });

  it("never sends an Authorization header to an open device", async () => {
    device = await startFakeDevice();
    const keys = await freshKeys();
    keys.setFleetKey("a-key-we-should-not-send");
    await probeDevice({ identity: identityFor(device), keys });
    expect(device.authAttempts).toBe(0);
  });

  it("tries the next address when the first does not answer", async () => {
    device = await startFakeDevice();
    const identity = identityFor(device);
    // 192.0.2.1 is TEST-NET-1: guaranteed unroutable.
    identity.addresses = ["192.0.2.1", device.address];
    const result = await probeDevice({
      identity,
      keys: await freshKeys(),
      timeoutMs: 1500,
    });
    expect(result.ok).toBe(true);
    // The address that answered is reported so it can be promoted.
    expect(result.address).toBe(device.address);
  });

  it("fails cleanly when no address answers", async () => {
    const result = await probeDevice({
      identity: {
        id: "dead",
        addresses: ["192.0.2.1"],
        port: 9,
        sources: {},
      },
      keys: await freshKeys(),
      timeoutMs: 800,
    });
    expect(result.ok).toBe(false);
    expect(result.auth).toBe("unknown");
    expect(result.error).toBeDefined();
  });
});

describe("probeDevice against a keyed device", () => {
  it("uses the fleet key and reads the protected endpoints", async () => {
    device = await startFakeDevice({ key: "secret-key" });
    const keys = await freshKeys();
    keys.setFleetKey("secret-key");

    const result = await probeDevice({ identity: identityFor(device), keys });
    expect(result.auth).toBe("authorized");
    expect(result.snapshot?.authRequired).toBe(true);
    expect(result.snapshot?.info?.cores).toBe(2);
  });

  it("prefers a device's own key over the fleet key", async () => {
    device = await startFakeDevice({ key: "device-specific" });
    const keys = await freshKeys();
    keys.setFleetKey("wrong-fleet-key");
    await keys.setKeyFor("2be9", "device-specific");
    keys.beginCycle();

    const result = await probeDevice({ identity: identityFor(device), keys });
    expect(result.auth).toBe("authorized");
  });

  it("reports needs-key and does NOT retry with another key", async () => {
    device = await startFakeDevice({ key: "the-right-key" });
    const keys = await freshKeys();
    keys.setFleetKey("the-wrong-key");

    const result = await probeDevice({ identity: identityFor(device), keys });
    expect(result.auth).toBe("needs-key");
    // Exactly one authenticated request: the whole point of the policy.
    expect(device.authAttempts).toBe(1);
  });

  it("spends only one auth attempt per cycle however often it is probed", async () => {
    device = await startFakeDevice({ key: "the-right-key" });
    const keys = await freshKeys();
    keys.setFleetKey("the-wrong-key");
    const identity = identityFor(device);

    await probeDevice({ identity, keys });
    await probeDevice({ identity, keys });
    await probeDevice({ identity, keys });

    expect(device.authAttempts).toBe(1);

    // A new cycle grants exactly one more.
    keys.beginCycle();
    await probeDevice({ identity, keys });
    expect(device.authAttempts).toBe(2);
  });

  it("reports an untested key as unknown, not authorized", async () => {
    // Review finding: a held-but-unproven key was reported as "authorized",
    // which shows a green device whose key the next OTA may well refuse.
    device = await startFakeDevice({ key: "the-right-key" });
    const keys = await freshKeys();
    keys.setFleetKey("the-right-key");
    const identity = identityFor(device);

    const first = await probeDevice({ identity, keys });
    expect(first.auth).toBe("authorized"); // proven by a successful call

    // A successful probe makes two authenticated calls (system/info and
    // ota/status), so count them before the second probe rather than assuming
    // one request per cycle.
    const afterFirst = device.authAttempts;

    // Second probe in the same cycle: the attempt is spent, so nothing has
    // been proven this time round and no further request is made.
    const second = await probeDevice({ identity, keys });
    expect(second.auth).toBe("unknown");
    expect(device.authAttempts).toBe(afterFirst);
  });

  it("still says needs-key when no key is held at all", async () => {
    device = await startFakeDevice({ key: "some-key" });
    const keys = await freshKeys();
    const identity = identityFor(device);
    // No fleet key, no device key: one probe spends nothing and reports need.
    const result = await probeDevice({ identity, keys });
    expect(result.auth).toBe("needs-key");
    expect(device.authAttempts).toBe(0);
  });

  it("backs off on 429 and stays quiet until the lockout expires", async () => {
    device = await startFakeDevice({
      key: "k",
      throttleAfter: 0, // every authenticated call is throttled
      retryAfterS: 30,
    });
    const keys = await freshKeys();
    keys.setFleetKey("k");
    const identity = identityFor(device);

    const first = await probeDevice({ identity, keys });
    expect(first.auth).toBe("locked-out");
    expect(first.lockedOutUntil).toBeGreaterThan(Date.now());
    expect(device.authAttempts).toBe(1);

    // Even in a brand-new cycle, a locked-out device is left alone.
    keys.beginCycle();
    const second = await probeDevice({ identity, keys });
    expect(second.auth).toBe("locked-out");
    expect(device.authAttempts).toBe(1);

    // ...but ping still runs, so the device is not reported as gone.
    expect(second.ok).toBe(true);
    expect(second.snapshot?.version).toBeDefined();
  });

  it("resumes once the lockout has passed", async () => {
    let clock = 1_000_000;
    device = await startFakeDevice({ key: "k" });
    const keys = new KeyStore({ dataDir, now: () => clock });
    await keys.load();
    keys.setFleetKey("k");
    keys.markLockedOut("2be9", 30);

    expect(keys.canAttempt("2be9")).toBe(false);
    clock += 31_000;
    keys.beginCycle();
    expect(keys.canAttempt("2be9")).toBe(true);
  });
});

describe("KeyStore persistence", () => {
  it("survives a reload and keeps per-device keys separate", async () => {
    const first = new KeyStore({ dataDir });
    await first.load();
    await first.setKeyFor("2be9", "key-a");
    await first.setKeyFor("6f19", "key-b");

    const second = new KeyStore({ dataDir });
    await second.load();
    expect(second.keyFor("2be9")).toBe("key-a");
    expect(second.keyFor("6f19")).toBe("key-b");
    expect(second.hasOwnKey("2be9")).toBe(true);
  });

  it("falls back to the fleet key for a device with none of its own", async () => {
    const keys = await freshKeys();
    keys.setFleetKey("fleet");
    expect(keys.keyFor("unkn")).toBe("fleet");
    expect(keys.hasOwnKey("unkn")).toBe(false);
  });

  it("reports no key when neither is set", async () => {
    const keys = await freshKeys();
    expect(keys.keyFor("2be9")).toBeUndefined();
    expect(keys.hasKey("2be9")).toBe(false);
    expect(keys.canAttempt("2be9")).toBe(false);
  });

  it("starts empty rather than throwing when the file is corrupt", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dataDir, "keys.json"), "{not json");
    const keys = new KeyStore({ dataDir });
    await keys.load();
    expect(keys.keyFor("2be9")).toBeUndefined();
  });

  it("does not lose a key written while the first load is still pending", async () => {
    // Review finding: the boolean guard was set before the await, so a
    // concurrent setKeyFor could be overwritten by the arriving disk contents.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dataDir, "keys.json"),
      JSON.stringify({
        version: 1,
        keys: { old1: { key: "from-disk", setAt: 1, source: "manual" } },
      }),
    );
    const keys = new KeyStore({ dataDir });
    const loading = keys.load(); // deliberately not awaited yet
    const writing = keys.setKeyFor("2be9", "just-typed");
    await Promise.all([loading, writing]);

    expect(keys.keyFor("2be9")).toBe("just-typed");
    expect(keys.keyFor("old1")).toBe("from-disk");
  });

  it("removes a key on request", async () => {
    const keys = await freshKeys();
    await keys.setKeyFor("2be9", "gone-soon");
    await keys.removeKeyFor("2be9");
    expect(keys.hasOwnKey("2be9")).toBe(false);
  });
});
