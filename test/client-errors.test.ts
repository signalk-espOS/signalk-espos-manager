/**
 * How the device client reports a device that never answered.
 *
 * Node's fetch says "fetch failed" for every network failure and hides the
 * reason in `cause`. That bare text reached the UI when "Fix this" was clicked
 * on a panel still booting after a flash, and told the operator nothing.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DeviceClient, DeviceUnreachableError } from "../src/device/client.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("DeviceClient network failures", () => {
  it("names the socket error of a device that is not listening", async () => {
    const client = new DeviceClient({
      address: "127.0.0.1",
      port: await freePort(),
    });
    const error: unknown = await client.getConfig().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceUnreachableError);
    expect((error as DeviceUnreachableError).code).toBe("ECONNREFUSED");
    expect((error as Error).message).toMatch(
      /did not answer \/config \(ECONNREFUSED\)/,
    );
  });

  it("reports a device that accepted but never replied as a timeout", async () => {
    const server = createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const client = new DeviceClient({
        address: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        timeoutMs: 50,
      });
      const error: unknown = await client.getConfig().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DeviceUnreachableError);
      expect((error as DeviceUnreachableError).code).toBe("timeout");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
