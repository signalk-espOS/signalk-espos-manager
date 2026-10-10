/**
 * Generating, replacing and removing the fleet key from the webapp: no device
 * that worked with the old key may end up unreachable.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyStore } from "../src/device/auth.js";
import { DeviceClient } from "../src/device/client.js";
import {
  changeFleetKey,
  generateFleetKey,
  moveToFleetKey,
} from "../src/device/fleetKey.js";
import { fleetKeyUsable } from "../src/device/provision.js";
import { SettingsSchema, applyDefaults } from "../src/config.js";
import type { AuthState, DeviceRecord, Reachability } from "../src/types.js";

const servers: Server[] = [];
let dataDir: string;

beforeEach(async () => {
  ports = {};
  dataDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "espos-fk-"));
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  await rm(dataDir, { recursive: true, force: true });
});

/** An espOS device with a key, accepting PUT /config httpd.api_key. */
async function startDevice(initialKey: string): Promise<{
  port: number;
  key: () => string;
}> {
  let apiKey = initialKey;
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (apiKey !== "" && req.headers.authorization !== `Bearer ${apiKey}`) {
      send(401, { error: "unauthorized" });
      return;
    }
    if (req.url === "/api/v1/config" && req.method === "PUT") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const next = (JSON.parse(body) as { httpd?: { api_key?: string } })
          .httpd?.api_key;
        const changed = next !== undefined && next !== apiKey;
        if (next !== undefined) apiKey = next;
        send(200, { changed: changed ? ["httpd.api_key"] : [] });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, key: () => apiKey };
}

let keys: KeyStore;
let ports: Record<string, number>;

/** As the service builds it: the key the plugin currently uses for the id. */
const clientFor = (id: string) =>
  new DeviceClient({
    address: "127.0.0.1",
    port: ports[id] ?? 1,
    key: keys.keyFor(id),
    timeoutMs: 500,
  });

async function keyStore(fleet: string): Promise<KeyStore> {
  keys = new KeyStore({ dataDir });
  await keys.load();
  keys.setFleetKey(fleet);
  return keys;
}

function record(
  id: string,
  port: number,
  auth: AuthState = "authorized",
  reachability: Reachability = "online",
): DeviceRecord {
  ports[id] = port;
  return {
    identity: { id, addresses: ["127.0.0.1"], port, sources: {} },
    reachability,
    auth,
    lastSeenAt: 0,
    consecutiveFailures: 0,
  };
}

describe("generateFleetKey", () => {
  it("makes a key espOS accepts, different every time", () => {
    const a = generateFleetKey();
    expect(fleetKeyUsable(a)).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateFleetKey()).not.toBe(a);
  });
});

describe("changeFleetKey", () => {
  it("moves an online device to the new key and saves it", async () => {
    const device = await startDevice("old-fleet-key");
    await keyStore("old-fleet-key");
    const saved: string[] = [];
    const result = await changeFleetKey({
      keys,
      devices: [record("a", device.port)],
      newKey: "new-fleet-key",
      save: async (key) => {
        saved.push(key);
      },
      clientFor,
    });
    expect(result).toEqual({ updated: ["a"], kept: [] });
    expect(device.key()).toBe("new-fleet-key");
    expect(saved).toEqual(["new-fleet-key"]);
    expect(keys.hasOwnKey("a")).toBe(false);
    expect(keys.keyFor("a")).toBe("new-fleet-key");
  });

  it("keeps the old key for a device it cannot reach", async () => {
    await keyStore("old-fleet-key");
    const result = await changeFleetKey({
      keys,
      devices: [record("gone", 1, "authorized", "offline")],
      newKey: "new-fleet-key",
      save: async () => {},
      clientFor,
    });
    expect(result).toEqual({ updated: [], kept: ["gone"] });
    expect(keys.keyFor("gone")).toBe("old-fleet-key");
  });

  it("keeps the old key when the write fails", async () => {
    await keyStore("old-fleet-key");
    // Online by the last poll, but nothing listens there any more.
    const result = await changeFleetKey({
      keys,
      devices: [record("flaky", 1)],
      newKey: "new-fleet-key",
      save: async () => {},
      clientFor,
    });
    expect(result.kept).toEqual(["flaky"]);
    expect(keys.keyFor("flaky")).toBe("old-fleet-key");
  });

  it("never writes to a device with its own key, a refusing one or an open one", async () => {
    const own = await startDevice("owners-key");
    const refused = await startDevice("something-else");
    await keyStore("old-fleet-key");
    await keys.setKeyFor("own", "owners-key");
    const result = await changeFleetKey({
      keys,
      devices: [
        record("own", own.port),
        record("refused", refused.port, "needs-key"),
        record("open", 1, "open"),
      ],
      newKey: "new-fleet-key",
      save: async () => {},
      clientFor,
    });
    // The refusing device was already tried with the old key every cycle;
    // pinned, it still is, and is never sent a write with a key it refuses.
    expect(result).toEqual({ updated: [], kept: ["refused"] });
    expect(own.key()).toBe("owners-key");
    expect(keys.keyFor("own")).toBe("owners-key");
    expect(refused.key()).toBe("something-else");
    expect(keys.hasOwnKey("open")).toBe(false);
  });

  it("removing the key opens no device", async () => {
    const device = await startDevice("old-fleet-key");
    await keyStore("old-fleet-key");
    const saved: string[] = [];
    const result = await changeFleetKey({
      keys,
      devices: [record("a", device.port)],
      newKey: "",
      save: async (key) => {
        saved.push(key);
      },
      clientFor,
    });
    expect(result).toEqual({ updated: [], kept: ["a"] });
    expect(device.key()).toBe("old-fleet-key");
    expect(saved).toEqual([""]);
    expect(keys.keyFor("a")).toBe("old-fleet-key");
    expect(keys.keyFor("new-device")).toBeUndefined();
  });

  it("pins before saving, so a failed save strands nobody", async () => {
    const device = await startDevice("old-fleet-key");
    await keyStore("old-fleet-key");
    await expect(
      changeFleetKey({
        keys,
        devices: [record("a", device.port)],
        newKey: "new-fleet-key",
        save: () => Promise.reject(new Error("disk full")),
        clientFor,
      }),
    ).rejects.toThrow("disk full");
    expect(device.key()).toBe("old-fleet-key");
    expect(keys.keyFor("a")).toBe("old-fleet-key");
  });

  it("pins a device whose state is not known yet, such as after a restart", async () => {
    await keyStore("old-fleet-key");
    const result = await changeFleetKey({
      keys,
      devices: [record("fresh", 1, "unknown", "offline")],
      newKey: "new-fleet-key",
      save: async () => {},
      clientFor,
    });
    expect(result).toEqual({ updated: [], kept: ["fresh"] });
    expect(keys.keyFor("fresh")).toBe("old-fleet-key");
  });

  it("moves a device left behind once it answers again", async () => {
    const device = await startDevice("old-fleet-key");
    await keyStore("old-fleet-key");
    await changeFleetKey({
      keys,
      devices: [record("a", device.port, "authorized", "offline")],
      newKey: "new-fleet-key",
      save: async () => {},
      clientFor,
    });
    expect(device.key()).toBe("old-fleet-key");
    const later = await moveToFleetKey({
      keys,
      devices: [record("a", device.port)],
      clientFor,
    });
    expect(later).toEqual({ updated: ["a"], kept: [] });
    expect(device.key()).toBe("new-fleet-key");
    expect(keys.hasOwnKey("a")).toBe(false);
  });

  it("gives a key set after a removal to the devices that kept the old one", async () => {
    const device = await startDevice("old-fleet-key");
    await keyStore("old-fleet-key");
    const options = {
      keys,
      devices: [record("a", device.port)],
      save: async () => {},
      clientFor,
    };
    await changeFleetKey({ ...options, newKey: "" });
    const result = await changeFleetKey({ ...options, newKey: "third-key-1" });
    expect(result).toEqual({ updated: ["a"], kept: [] });
    expect(device.key()).toBe("third-key-1");
  });

  it("refuses a key espOS would not accept", async () => {
    await keyStore("");
    await expect(
      changeFleetKey({
        keys,
        devices: [],
        newKey: "short",
        save: async () => {},
        clientFor,
      }),
    ).rejects.toThrow(/8 to 64/);
  });
});

describe("fleet key in the settings form", () => {
  it("is not required, so the Admin UI saves without one", () => {
    const auth = (
      SettingsSchema as unknown as {
        properties: { auth: { required?: string[] } };
      }
    ).properties.auth;
    expect(auth.required ?? []).not.toContain("fleetKey");
    expect(applyDefaults({ auth: {} }).auth.fleetKey).toBe("");
  });
});
