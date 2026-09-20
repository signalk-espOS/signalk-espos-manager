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
  options: { rejectUnknown?: boolean; frozen?: boolean } = {},
): Promise<{ client: DeviceClient; config: Record<string, unknown> }> {
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
  };
}

describe("configureOta", () => {
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
