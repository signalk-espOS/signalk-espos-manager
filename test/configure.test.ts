/**
 * Tests for pointing a device at the mirror.
 *
 * The starting state in these tests is the one found on both live devices:
 * manifest_src "url", an empty manifest_url, and a manifest_path naming a
 * plugin that never shipped under the admin-gated /plugins/ prefix.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceClient } from "../src/device/client.js";
import { configureOta, needsOtaRepair } from "../src/ota/configure.js";
import { PUBLIC_FW_BASE } from "../src/config.js";

const STALE_PATH = "/plugins/signalk-espos-updates/manifest.json";
const EXPECTED_PATH = "/signalk-espos-manager/fw/cockpit/manifest.json";

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

/** A device whose config PUT merges, like espos_config_import_json does. */
async function startConfigDevice(
  options: {
    rejectUnknown?: boolean;
    frozen?: boolean;
    putStatus?: number;
  } = {},
): Promise<{
  client: DeviceClient;
  config: Record<string, unknown>;
  port: number;
  puts: () => number;
}> {
  let puts = 0;
  const config: Record<string, unknown> = {
    ota: {
      manifest_src: "url",
      manifest_url: "",
      manifest_path: STALE_PATH,
      channel: "stable",
      auto_check: true,
      auto_install: false,
    },
  };

  server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/v1/config" && req.method === "GET") {
      send(200, config);
      return;
    }
    if (req.url === "/api/v1/config" && req.method === "PUT") {
      puts += 1;
      if (options.putStatus !== undefined) {
        send(options.putStatus, {
          error: "validation",
          path: "ota.manifest_src",
          message: "unknown key",
        });
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const incoming = JSON.parse(body) as Record<
          string,
          Record<string, unknown>
        >;
        const changed: string[] = [];
        for (const [ns, values] of Object.entries(incoming)) {
          const current = (config[ns] ?? {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(values)) {
            if (options.rejectUnknown === true && !(key in current)) {
              send(400, {
                error: "validation",
                path: `${ns}.${key}`,
                message: "unknown key",
              });
              return;
            }
            if (current[key] !== value) {
              if (options.frozen !== true) current[key] = value;
              changed.push(`${ns}.${key}`);
            }
          }
          config[ns] = current;
        }
        send(200, { changed, restart_required: false });
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
    config,
    port,
    puts: () => puts,
  };
}

/**
 * fetch as Node reports a device that is not listening yet: a TypeError
 * "fetch failed" with the socket error in `cause`. Fails `times` calls, then
 * behaves normally.
 */
function refusingFetch(times: number): typeof fetch {
  return refusingCalls(new Set(Array.from({ length: times }, (_, i) => i + 1)));
}

/** Refuses exactly the numbered calls (1-based), answers the rest. */
function refusingCalls(refused: Set<number>): typeof fetch {
  let call = 0;
  return (input, init) => {
    call += 1;
    if (refused.has(call)) {
      const cause = Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
      return Promise.reject(new TypeError("fetch failed", { cause }));
    }
    return fetch(input, init);
  };
}

describe("configureOta", () => {
  it("points a device whose board resolves at that board's manifest", async () => {
    const { client, config } = await startConfigDevice();
    const result = await configureOta({
      client,
      app: "cockpit",
      channel: "stable",
      publicBase: PUBLIC_FW_BASE,
      boardId: "waveshare-p4-touch-7b",
    });
    const path =
      "/signalk-espos-manager/fw/cockpit/manifest-waveshare-p4-touch-7b.json";
    expect(result.manifestPath).toBe(path);
    expect((config.ota as Record<string, unknown>).manifest_path).toBe(path);
  });

  it("writes both the source and the path, and confirms them", async () => {
    // Writing the path alone would fix nothing: with manifest_src "url" the
    // device is not consulting the path at all.
    const { client, config } = await startConfigDevice();
    const result = await configureOta({
      client,
      app: "cockpit",
      channel: "stable",
      publicBase: PUBLIC_FW_BASE,
      origin: "http://192.168.0.148",
    });

    expect(result.manifestPath).toBe(EXPECTED_PATH);
    expect(result.applied.manifestSrc).toBe("signalk");
    expect(result.applied.manifestPath).toBe(EXPECTED_PATH);
    expect(result.changed).toContain("ota.manifest_src");
    expect(result.changed).toContain("ota.manifest_path");

    const ota = config.ota as Record<string, unknown>;
    expect(ota.manifest_src).toBe("signalk");
    expect(ota.manifest_path).toBe(EXPECTED_PATH);
  });

  it("leaves auto_install alone unless asked", async () => {
    const { client, config } = await startConfigDevice();
    await configureOta({
      client,
      app: "cockpit",
      channel: "stable",
      publicBase: PUBLIC_FW_BASE,
    });
    expect((config.ota as Record<string, unknown>).auto_install).toBe(false);
  });

  it("sets auto_install when explicitly requested", async () => {
    const { client, config } = await startConfigDevice();
    await configureOta({
      client,
      app: "cockpit",
      channel: "stable",
      publicBase: PUBLIC_FW_BASE,
      autoInstall: true,
    });
    expect((config.ota as Record<string, unknown>).auto_install).toBe(true);
  });

  it("reports a device that silently ignored the write", async () => {
    // A 200 is not evidence the value landed, so the read-back is the check.
    const { client } = await startConfigDevice({ frozen: true });
    await expect(
      configureOta({
        client,
        app: "cockpit",
        channel: "stable",
        publicBase: PUBLIC_FW_BASE,
      }),
    ).rejects.toThrow(/did not accept the update source/);
  });

  it("refuses when the URL would not fit the device's buffer", async () => {
    const { client } = await startConfigDevice();
    await expect(
      configureOta({
        client,
        app: "cockpit",
        channel: "stable",
        publicBase: `/${"x".repeat(140)}`,
        origin: "http://a-long-hostname.example.invalid:30000",
      }),
    ).rejects.toThrow(/cannot point this device at the mirror/);
  });

  it("surfaces a validation rejection rather than reporting success", async () => {
    const { client } = await startConfigDevice({ rejectUnknown: true });
    // channel/manifest_src/manifest_path all exist, so this one should pass;
    // the guard is that an unknown key would 400 and we would not swallow it.
    await expect(
      configureOta({
        client,
        app: "cockpit",
        channel: "stable",
        publicBase: PUBLIC_FW_BASE,
      }),
    ).resolves.toMatchObject({ manifestPath: EXPECTED_PATH });
  });
});

describe("configureOta against a device that is still booting", () => {
  it("retries once when the device did not answer, then succeeds", async () => {
    // Simulates the case seen on the boat: "Fix this" clicked on a panel
    // still booting after a web-flash, where the one attempt was refused.
    const { port, config, puts } = await startConfigDevice();
    const client = new DeviceClient({
      address: "127.0.0.1",
      port,
      fetchImpl: refusingFetch(1),
    });
    const result = await configureOta({
      client,
      app: "cockpit",
      channel: "stable",
      publicBase: PUBLIC_FW_BASE,
      retryDelayMs: 0,
    });
    expect(result.applied.manifestSrc).toBe("signalk");
    expect(result.changed).toContain("ota.manifest_src");
    expect(puts()).toBe(1); // the refused attempt never reached the device
    expect((config.ota as Record<string, unknown>).manifest_src).toBe(
      "signalk",
    );
  });

  it("does not resend a write that landed but lost its reply", async () => {
    const { port, puts } = await startConfigDevice();
    let call = 0;
    const client = new DeviceClient({
      address: "127.0.0.1",
      port,
      fetchImpl: async (input, init) => {
        call += 1;
        const response = await fetch(input, init);
        if (call === 1) {
          // The device applied the PUT; the reply never arrived.
          await response.text();
          const cause = Object.assign(new Error("socket hang up"), {
            code: "ECONNRESET",
          });
          throw new TypeError("fetch failed", { cause });
        }
        return response;
      },
    });
    const result = await configureOta({
      client,
      app: "cockpit",
      channel: "stable",
      publicBase: PUBLIC_FW_BASE,
      retryDelayMs: 0,
    });
    expect(puts()).toBe(1);
    expect(result.changed).toEqual([]);
    expect(result.applied.manifestSrc).toBe("signalk");
  });

  it("retries only the read-back when the write already landed", async () => {
    // Re-sending the write would find nothing left to change and report an
    // empty `changed`, hiding what the first write actually did.
    const { port, puts } = await startConfigDevice();
    const client = new DeviceClient({
      address: "127.0.0.1",
      port,
      fetchImpl: refusingCalls(new Set([2])), // the GET after the PUT
    });
    const result = await configureOta({
      client,
      app: "cockpit",
      channel: "stable",
      publicBase: PUBLIC_FW_BASE,
      retryDelayMs: 0,
    });
    expect(puts()).toBe(1);
    expect(result.changed).toContain("ota.manifest_src");
    expect(result.applied.manifestSrc).toBe("signalk");
  });

  it("names the cause and what to do when the retry fails too", async () => {
    const { port } = await startConfigDevice();
    const client = new DeviceClient({
      address: "127.0.0.1",
      port,
      fetchImpl: refusingFetch(10),
    });
    await expect(
      configureOta({
        client,
        app: "cockpit",
        channel: "stable",
        publicBase: PUBLIC_FW_BASE,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/did not answer.*ECONNREFUSED.*few seconds/);
  });

  it("does not retry a device that answered with an error", async () => {
    // An HTTP error is the device's considered answer; asking again only
    // repeats it and doubles the wait before the operator sees it.
    const { client, puts } = await startConfigDevice({ putStatus: 400 });
    await expect(
      configureOta({
        client,
        app: "cockpit",
        channel: "stable",
        publicBase: PUBLIC_FW_BASE,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/HTTP 400.*unknown key/);
    expect(puts()).toBe(1);
  });
});

describe("needsOtaRepair", () => {
  it("flags the stale default found on the live devices", () => {
    const result = needsOtaRepair("url", STALE_PATH, "", EXPECTED_PATH);
    expect(result.needed).toBe(true);
    // The empty manifest_url is the more accurate complaint: with src "url"
    // and no URL, the device is not looking anywhere at all.
    expect(result.reason).toMatch(/not looking for updates anywhere/);
  });

  it("flags an admin-gated path the device cannot read", () => {
    const result = needsOtaRepair(
      "signalk",
      STALE_PATH,
      undefined,
      EXPECTED_PATH,
    );
    expect(result.needed).toBe(true);
    expect(result.reason).toMatch(/administrator login/);
  });

  it("is satisfied once the device points at us", () => {
    expect(
      needsOtaRepair("signalk", EXPECTED_PATH, "", EXPECTED_PATH).needed,
    ).toBe(false);
  });

  it("reports a device aimed at some other URL", () => {
    const result = needsOtaRepair(
      "url",
      "",
      "http://192.168.0.148:8090/manifest.json",
      EXPECTED_PATH,
    );
    expect(result.needed).toBe(true);
    expect(result.reason).toContain("8090");
  });

  it("reports a device pointing at another public path", () => {
    const result = needsOtaRepair(
      "signalk",
      "/other-plugin/manifest.json",
      undefined,
      EXPECTED_PATH,
    );
    expect(result.needed).toBe(true);
    expect(result.reason).toContain("/other-plugin/manifest.json");
  });
});
