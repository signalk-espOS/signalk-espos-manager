/**
 * Demo mode: three virtual devices for a public showcase, shown to anyone and
 * changed by no one. Nothing on the network is looked for or contacted
 * beyond the registry index.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";

const pollerStarted = vi.fn();
vi.mock("../src/fleet/poller.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/fleet/poller.js")>();
  return {
    ...original,
    FleetPoller: class {
      start(): Promise<void> {
        pollerStarted();
        return Promise.resolve();
      }
      stop(): Promise<void> {
        return Promise.resolve();
      }
      rescan(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

const { applyDefaults, DEFAULT_REGISTRY_INDEX } =
  await import("../src/config.js");
const { ManagerService } = await import("../src/service.js");
const { registerRoutes, DEMO_REFUSAL } = await import("../src/api/routes.js");
const { DEMO_DEVICES, demoRecord, demoVersion } =
  await import("../src/demo/fixtures.js");
type PluginRouter = import("../src/api/routes.js").PluginRouter;
type RegistryIndex = import("../src/registry/types.js").RegistryIndex;

const release = (version: string) => ({
  version,
  tag: `v${version}`,
  channel: "stable" as const,
  builds: [
    { target: "esp32p4", otaUrl: `https://example.invalid/p4-${version}.bin` },
    { target: "esp32c5", otaUrl: `https://example.invalid/c5-${version}.bin` },
  ],
});
const project = (id: string, app: string, targets: string[]) => ({
  id,
  app,
  name: id,
  repo: `example/${id}`,
  targets,
  signingKeyId: "00112233aabbccdd",
  releases: [release("1.2.0"), release("1.1.0"), release("1.0.0")],
});
const INDEX: RegistryIndex = {
  schema: 1,
  projects: [
    project("cockpit", "cockpit", ["esp32p4"]),
    project("ble-gateway", "ble_gateway", ["esp32c5"]),
    project("zigbee-coordinator", "zigbee_coordinator", ["esp32c5"]),
  ],
};

type Handler = (
  req: { params?: Record<string, string>; body?: unknown },
  res: unknown,
) => unknown;

let dataDir: string;
const fetched: string[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "espos-demo-"));
  fetched.length = 0;
  pollerStarted.mockClear();
  vi.stubGlobal("fetch", (url: string | URL) => {
    fetched.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(INDEX), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dataDir, { recursive: true, force: true });
});

async function startDemo(demo = true) {
  const app = {
    debug: () => undefined,
    error: () => undefined,
    setPluginStatus: () => undefined,
    setPluginError: () => undefined,
    handleMessage: () => undefined,
    getDataDirPath: () => dataDir,
  };
  const service = new ManagerService(app as unknown as ServerAPI);
  await service.start(
    applyDefaults({ demo, dayNight: { publishMode: false } }),
  );
  // Seeded from the fetched index once it arrives.
  await vi.waitFor(() => {
    if (demo) {
      expect(service.fleet.get("espos-engine-room")?.update).toBeDefined();
    }
  });

  const handlers = new Map<string, Handler>();
  const add = (method: string) => (path: string, handler: Handler) =>
    handlers.set(`${method} ${path}`, handler);
  const router = {
    get: add("GET"),
    post: add("POST"),
    delete: add("DELETE"),
  } as unknown as PluginRouter;
  registerRoutes(router, () => service);
  const call = (route: string, params?: Record<string, string>) =>
    new Promise<{ status: number; body: unknown }>((resolve) => {
      let status = 200;
      const res = {
        status(code: number) {
          status = code;
          return res;
        },
        json(reply: unknown) {
          resolve({ status, body: reply });
          return res;
        },
      };
      const handler = handlers.get(route);
      if (handler === undefined) throw new Error(`no route ${route}`);
      handler({ params, body: {} }, res);
    });
  return { service, call, handlers };
}

describe("demo fixtures", () => {
  it("run the newest release, one the release before, with an update offered", () => {
    const records = DEMO_DEVICES.map((d) =>
      demoRecord(d, INDEX, undefined, 0, 1000),
    );
    expect(records.map((r) => r.snapshot?.version)).toEqual([
      "1.2.0",
      "1.1.0",
      "1.2.0",
    ]);
    expect(records.map((r) => r.update?.toVersion)).toEqual([
      undefined,
      "1.2.0",
      undefined,
    ]);
    for (const record of records) {
      expect(record.reachability).toBe("online");
      expect(record.project).toBeDefined();
      // Documentation range and locally administered MACs only.
      expect(record.identity.addresses[0]).toMatch(/^192\.0\.2\./);
      expect(record.identity.mac).toMatch(/^02:/);
    }
  });

  it("fall back to a version when the index has none", () => {
    expect(demoVersion({ schema: 1, projects: [] }, DEMO_DEVICES[0]!)).toBe(
      "1.0.0",
    );
  });
});

describe("demo mode", () => {
  it("shows the fleet at once, before the registry answers", async () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    const service = new ManagerService({
      debug: () => undefined,
      error: () => undefined,
      setPluginStatus: () => undefined,
      setPluginError: () => undefined,
      handleMessage: () => undefined,
      getDataDirPath: () => dataDir,
    } as unknown as ServerAPI);
    await service.start(
      applyDefaults({ demo: true, dayNight: { publishMode: false } }),
    );
    expect(service.fleet.size).toBe(3);
    await service.stop();
  });

  it("contacts nothing but the registry index", async () => {
    const { service } = await startDemo();
    expect(pollerStarted).not.toHaveBeenCalled();
    expect(new Set(fetched)).toEqual(new Set([DEFAULT_REGISTRY_INDEX]));
    expect(service.clientFor("espos-cockpit")).toBeUndefined();
    await service.stop();
    // The fixtures do not outlive demo mode.
    expect(service.fleet.size).toBe(0);
  });

  it("says so, and serves the fleet to readers", async () => {
    const { call, service } = await startDemo();
    expect((await call("GET /api/mode")).body).toEqual({ demo: true });
    const fleet = (await call("GET /api/fleet")).body as {
      devices: { id: string }[];
      summary: { updatesAvailable: number };
    };
    expect(fleet.devices.map((d) => d.id).sort()).toEqual([
      "espos-cockpit",
      "espos-engine-room",
      "espos-zigbee",
    ]);
    expect(fleet.summary.updatesAvailable).toBe(1);
    const cop = await call("GET /api/fleet/:id/coprocessor", {
      id: "espos-cockpit",
    });
    expect(cop.status).toBe(200);
    await service.stop();
  });

  it("refuses every write, administrators included", async () => {
    const { handlers, call, service } = await startDemo();
    const writes = [...handlers.keys()].filter((k) => !k.startsWith("GET "));
    expect(writes.length).toBeGreaterThan(10);
    for (const route of writes) {
      const reply = await call(route, { id: "espos-cockpit" });
      expect(reply, route).toEqual({
        status: 403,
        body: { error: DEMO_REFUSAL },
      });
    }
    await service.stop();
  });

  it("is off by default, and then nothing changes", async () => {
    const { call, service } = await startDemo(false);
    expect((await call("GET /api/mode")).body).toEqual({ demo: false });
    expect(pollerStarted).toHaveBeenCalledOnce();
    expect(applyDefaults({}).demo).toBe(false);
    await service.stop();
  });
});
