/**
 * Tests for writing the fleet key to open devices (auth.autoProvision).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceClient } from "../src/device/client.js";
import { fleetKeyUsable, provisionFleetKey } from "../src/device/provision.js";

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
  }
});

/** An espOS device that is open until httpd.api_key is written. */
async function startDevice(initialKey = ""): Promise<{
  client: DeviceClient;
  key: () => string;
  puts: () => number;
}> {
  let apiKey = initialKey;
  let puts = 0;
  server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/v1/system/ping") {
      send(200, { app: "cockpit", version: "1.5.0", auth: apiKey !== "" });
      return;
    }
    if (apiKey !== "" && req.headers.authorization !== `Bearer ${apiKey}`) {
      send(401, { error: "unauthorized" });
      return;
    }
    if (req.url === "/api/v1/config" && req.method === "PUT") {
      puts += 1;
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const next = (JSON.parse(body) as { httpd?: { api_key?: string } })
          .httpd?.api_key;
        const changed = next !== undefined && next !== apiKey;
        if (next !== undefined) apiKey = next;
        send(200, {
          changed: changed ? ["httpd.api_key"] : [],
          restart_required: false,
        });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => {
    server?.listen(0, "127.0.0.1", r);
  });
  const { port } = server.address() as AddressInfo;
  return {
    client: new DeviceClient({ address: "127.0.0.1", port }),
    key: () => apiKey,
    puts: () => puts,
  };
}

describe("provisionFleetKey", () => {
  it("writes the fleet key to an open device", async () => {
    const device = await startDevice();
    const outcome = await provisionFleetKey(device.client, "boat-fleet-key");
    expect(outcome).toEqual({ result: "provisioned" });
    expect(device.key()).toBe("boat-fleet-key");
  });

  it("never overwrites a key someone already set", async () => {
    // Overwriting would lock out whoever chose it, and the poll that saw the
    // device open may be stale by the time the write goes out.
    const device = await startDevice("owners-own-key");
    const outcome = await provisionFleetKey(device.client, "boat-fleet-key");
    expect(outcome.result).toBe("skipped");
    expect(device.puts()).toBe(0);
    expect(device.key()).toBe("owners-own-key");
  });

  it("refuses a key espOS would not accept", async () => {
    const device = await startDevice();
    const outcome = await provisionFleetKey(device.client, "short");
    expect(outcome.result).toBe("skipped");
    expect(device.puts()).toBe(0);
    expect(fleetKeyUsable("x".repeat(64))).toBe(true);
    expect(fleetKeyUsable("x".repeat(65))).toBe(false);
  });

  it("reports an unreachable device as failed, not provisioned", async () => {
    const client = new DeviceClient({
      address: "127.0.0.1",
      port: 1,
      timeoutMs: 500,
    });
    const outcome = await provisionFleetKey(client, "boat-fleet-key");
    expect(outcome.result).toBe("failed");
  });
});
