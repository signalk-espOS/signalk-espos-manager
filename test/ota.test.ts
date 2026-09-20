/**
 * OTA job and queue tests, against a scriptable HTTP device.
 *
 * The two cases that matter most are the ones a naive implementation gets
 * wrong: a device that stops answering because it is rebooting (expected, not a
 * failure) and a device that rolls itself back (a failure that must never be
 * retried automatically).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceClient } from "../src/device/client.js";
import { OtaJob, type JobView } from "../src/ota/job.js";
import { OtaOrchestrator } from "../src/ota/orchestrator.js";

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
  }
});

interface Script {
  /** Successive /ota/status replies. The last one repeats. */
  statuses: Record<string, unknown>[];
  /** Successive /system/ping replies; a null entry means "refuse to answer". */
  pings: (Record<string, unknown> | null)[];
  installStatus?: number;
  confirmCalls?: number;
}

async function startDevice(script: Script): Promise<{
  client: DeviceClient;
  script: Script;
  statusIndex: () => number;
}> {
  let statusIndex = 0;
  let pingIndex = 0;
  script.confirmCalls = 0;

  server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";

    if (url === "/api/v1/system/ping") {
      const entry = script.pings[Math.min(pingIndex, script.pings.length - 1)];
      pingIndex += 1;
      if (entry === null) {
        // Simulate a device that is rebooting: connection dies.
        req.destroy();
        return;
      }
      send(200, entry);
      return;
    }
    if (url === "/api/v1/ota" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        send(script.installStatus ?? 202, {});
      });
      return;
    }
    if (url === "/api/v1/ota/confirm" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        script.confirmCalls = (script.confirmCalls ?? 0) + 1;
        send(200, {});
      });
      return;
    }
    if (url === "/api/v1/ota/status") {
      const entry =
        script.statuses[Math.min(statusIndex, script.statuses.length - 1)];
      statusIndex += 1;
      if (entry === undefined) {
        req.destroy();
        return;
      }
      send(200, entry);
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
    script,
    statusIndex: () => statusIndex,
  };
}

type JobOptionsArg = ConstructorParameters<typeof OtaJob>[0];

function jobOptions(
  client: DeviceClient,
  over: Partial<JobOptionsArg> = {},
): JobOptionsArg {
  return {
    deviceId: "2be9",
    client,
    fromVersion: "1.1.0",
    toVersion: "1.2.0",
    url: "/signalk-espos-manager/fw/cockpit/1.2.0/ota.bin",
    timeoutMs: 60_000,
    confirmGraceMs: 0,
    autoConfirm: true,
    pollMs: 1,
    // No real waiting in tests.
    sleep: async () => {},
    ...over,
  };
}

describe("OtaJob", () => {
  it("runs a whole update through to confirmed", async () => {
    const device = await startDevice({
      statuses: [
        { state: "downloading", progress: { received: 1000, total: 4000 } },
        { state: "downloading", progress: { received: 3000, total: 4000 } },
        { state: "verifying", progress: { received: 4000, total: 4000 } },
        { state: "ready" },
        // After the reboot: pending confirmation.
        { state: "idle", running: { version: "1.2.0", pending_verify: true } },
      ],
      pings: [
        { app: "cockpit", version: "1.1.0", auth: false },
        null, // rebooting
        { app: "cockpit", version: "1.2.0", auth: false },
      ],
    });

    const seen: JobView[] = [];
    const job = new OtaJob(
      jobOptions(device.client, {
        onChange: (v: JobView) => seen.push({ ...v }),
      }),
    );
    const view = await job.run();

    expect(view.state).toBe("done");
    expect(device.script.confirmCalls).toBe(1);
    // The operator can see it progressed rather than jumping to done.
    const states = seen.map((v) => v.state);
    expect(states).toContain("installing");
    expect(states).toContain("rebooting");
    expect(states).toContain("confirming");
    const withProgress = seen.filter((v) => v.progress !== undefined);
    expect(withProgress.length).toBeGreaterThan(0);
    expect(withProgress.at(-1)?.progress?.totalBytes).toBe(4000);
  });

  it("treats the reboot gap as expected, not as a failure", async () => {
    // A naive implementation reports every successful update as broken here.
    const device = await startDevice({
      statuses: [{ state: "ready" }],
      pings: [
        { app: "cockpit", version: "1.1.0", auth: false },
        null,
        null,
        null,
        { app: "cockpit", version: "1.2.0", auth: false },
      ],
    });
    const view = await new OtaJob(jobOptions(device.client)).run();
    expect(view.state).toBe("done");
    expect(view.error).toBeUndefined();
  });

  it("reports a rollback and does not retry it", async () => {
    const device = await startDevice({
      statuses: [
        { state: "ready" },
        {
          state: "idle",
          running: { version: "1.1.0", rolled_back: true },
        },
      ],
      pings: [
        { app: "cockpit", version: "1.1.0", auth: false },
        null,
        { app: "cockpit", version: "1.1.0", auth: false },
      ],
    });
    const view = await new OtaJob(jobOptions(device.client)).run();
    expect(view.state).toBe("rolled-back");
    expect(view.error).toMatch(/rolled back/);
    expect(view.error).toMatch(/not be retried automatically/);
    // Never confirmed an image that did not run.
    expect(device.script.confirmCalls).toBe(0);
  });

  it("surfaces the device's own failure message", async () => {
    // The device distinguishes a rejected signature from a bad download, and
    // its wording is more useful than anything we could invent.
    const device = await startDevice({
      statuses: [
        {
          state: "failed",
          last_error:
            "image rejected: bad signature or corrupt (ESP_ERR_OTA_VALIDATE_FAILED)",
        },
      ],
      pings: [{ app: "cockpit", version: "1.1.0", auth: false }],
    });
    const view = await new OtaJob(jobOptions(device.client)).run();
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/image rejected/);
  });

  it("adopts an update already in flight instead of failing on 409", async () => {
    // A plugin restart mid-update must not lose track of it.
    const device = await startDevice({
      installStatus: 409,
      statuses: [
        { state: "downloading", progress: { received: 10, total: 100 } },
        { state: "ready" },
        { state: "idle", running: { version: "1.2.0", pending_verify: false } },
      ],
      pings: [
        { app: "cockpit", version: "1.1.0", auth: false },
        null,
        { app: "cockpit", version: "1.2.0", auth: false },
      ],
    });
    const view = await new OtaJob(jobOptions(device.client)).run();
    expect(view.state).toBe("done");
  });

  it("reports a device that came back on the old version", async () => {
    const device = await startDevice({
      statuses: [
        { state: "ready" },
        { state: "idle", running: { version: "1.1.0", rolled_back: false } },
      ],
      pings: [
        { app: "cockpit", version: "1.1.0", auth: false },
        null,
        { app: "cockpit", version: "1.1.0", auth: false },
      ],
    });
    const view = await new OtaJob(jobOptions(device.client)).run();
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/still running 1\.1\.0/);
  });

  it("leaves the image pending when auto-confirm is off", async () => {
    const device = await startDevice({
      statuses: [
        { state: "ready" },
        { state: "idle", running: { version: "1.2.0", pending_verify: true } },
      ],
      pings: [
        { app: "cockpit", version: "1.1.0", auth: false },
        null,
        { app: "cockpit", version: "1.2.0", auth: false },
      ],
    });
    const view = await new OtaJob(
      jobOptions(device.client, {
        autoConfirm: false,
        confirmGraceMs: 600_000,
      }),
    ).run();
    // The device's own timer will roll it back if nobody acts; surface the
    // deadline rather than hiding it.
    expect(view.state).toBe("confirming");
    expect(view.confirmBy).toBeGreaterThan(0);
    expect(device.script.confirmCalls).toBe(0);
  });

  it("does not confirm an image the device already confirmed itself", async () => {
    const device = await startDevice({
      statuses: [
        { state: "ready" },
        { state: "idle", running: { version: "1.2.0", pending_verify: false } },
      ],
      pings: [
        { app: "cockpit", version: "1.1.0", auth: false },
        null,
        { app: "cockpit", version: "1.2.0", auth: false },
      ],
    });
    const view = await new OtaJob(jobOptions(device.client)).run();
    expect(view.state).toBe("done");
    expect(device.script.confirmCalls).toBe(0);
  });

  it("gives up when the device never comes back", async () => {
    let clock = 0;
    const device = await startDevice({
      statuses: [{ state: "ready" }],
      pings: [{ app: "cockpit", version: "1.1.0", auth: false }, null],
    });
    const view = await new OtaJob(
      jobOptions(device.client, {
        timeoutMs: 5000,
        now: () => clock,
        sleep: async () => {
          clock += 1000;
        },
      }),
    ).run();
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/did not come back/);
  });
});

describe("OtaOrchestrator", () => {
  /**
   * Orchestrator jobs run on a controlled clock with a short timeout, so a
   * test can never leave a real 60-second polling job running against a
   * closed server.
   */
  function fakeJobOptions(deviceId: string, client: DeviceClient) {
    let clock = 0;
    return {
      ...jobOptions(client, {
        timeoutMs: 3000,
        now: () => clock,
        sleep: async () => {
          clock += 500;
        },
      }),
      deviceId,
    };
  }

  it("refuses a second job for the same device", async () => {
    const device = await startDevice({
      statuses: [{ state: "downloading", progress: { received: 1, total: 9 } }],
      pings: [{ app: "cockpit", version: "1.1.0", auth: false }],
    });
    const orch = new OtaOrchestrator({ maxConcurrent: 1 });
    const first = orch.enqueue(fakeJobOptions("2be9", device.client));
    const second = orch.enqueue(fakeJobOptions("2be9", device.client));
    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(second.reason).toMatch(/already running or queued/);
  });

  it("pauses the queue after a job fails", async () => {
    // One bad build must not walk through the whole boat.
    const device = await startDevice({
      statuses: [{ state: "failed", last_error: "image rejected" }],
      pings: [{ app: "cockpit", version: "1.1.0", auth: false }],
    });
    const orch = new OtaOrchestrator({ maxConcurrent: 1 });
    orch.enqueue(fakeJobOptions("2be9", device.client));
    orch.enqueue(fakeJobOptions("6f19", device.client));
    orch.enqueue(fakeJobOptions("ca6a", device.client));

    // Let the first job run to completion.
    await new Promise<void>((r) => setTimeout(r, 200));

    expect(orch.isPaused).toBe(true);
    expect(orch.getPausedReason()).toMatch(/held/);
    const views = orch.list();
    expect(views.find((v) => v.deviceId === "2be9")?.state).toBe("failed");
    // The rest are still queued, not attempted.
    expect(views.filter((v) => v.state === "queued").length).toBe(2);
  });

  it("cannot cancel a job that has already started", async () => {
    // Hold the job inside its first poll so it is provably running when
    // cancel() is called. A timing-based wait raced the controlled clock and
    // found the job already finished.
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const device = await startDevice({
      statuses: [
        { state: "downloading", progress: { received: 1, total: 99 } },
      ],
      pings: [{ app: "cockpit", version: "1.1.0", auth: false }],
    });
    const orch = new OtaOrchestrator({ maxConcurrent: 1 });
    let polls = 0;
    orch.enqueue({
      ...fakeJobOptions("2be9", device.client),
      sleep: async () => {
        polls += 1;
        if (polls === 1) await holding;
      },
    });
    await new Promise<void>((r) => setTimeout(r, 20));
    const result = orch.cancel("2be9");
    release();
    expect(result.cancelled).toBe(false);
    expect(result.reason).toMatch(/cannot be cancelled/);
  });

  it("cancels a job that is still queued", async () => {
    const device = await startDevice({
      statuses: [
        { state: "downloading", progress: { received: 1, total: 99 } },
      ],
      pings: [{ app: "cockpit", version: "1.1.0", auth: false }],
    });
    const orch = new OtaOrchestrator({ maxConcurrent: 1 });
    orch.enqueue(fakeJobOptions("2be9", device.client));
    orch.enqueue(fakeJobOptions("6f19", device.client));
    const result = orch.cancel("6f19");
    expect(result.cancelled).toBe(true);
    expect(orch.isBusy("6f19")).toBe(false);
  });

  it("runs several jobs at once when allowed to", async () => {
    // Review finding: drain() awaited each job, so the queue was serial
    // whatever maxConcurrent said — the default of 1 hid it.
    const device = await startDevice({
      statuses: [
        { state: "ready" },
        { state: "idle", running: { version: "1.2.0", pending_verify: false } },
      ],
      pings: [
        { app: "cockpit", version: "1.1.0", auth: false },
        null,
        { app: "cockpit", version: "1.2.0", auth: false },
      ],
    });
    const orch = new OtaOrchestrator({ maxConcurrent: 3 });
    for (const id of ["2be9", "6f19", "ca6a"]) {
      orch.enqueue(fakeJobOptions(id, device.client));
    }
    // One microtask turn is enough for drain() to have started all three.
    await new Promise<void>((r) => setTimeout(r, 0));
    const started = orch.list().filter((v) => v.state !== "queued");
    expect(started.length).toBe(3);
  });

  it("still runs one at a time by default", async () => {
    // The serial default is a safety property, not a performance choice.
    const device = await startDevice({
      statuses: [
        { state: "downloading", progress: { received: 1, total: 99 } },
      ],
      pings: [{ app: "cockpit", version: "1.1.0", auth: false }],
    });
    const orch = new OtaOrchestrator({ maxConcurrent: 1 });
    for (const id of ["2be9", "6f19"]) {
      orch.enqueue(fakeJobOptions(id, device.client));
    }
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(orch.list().filter((v) => v.state === "queued").length).toBe(1);
  });

  it("reports nothing to cancel for an unknown device", async () => {
    const orch = new OtaOrchestrator({ maxConcurrent: 1 });
    expect(orch.cancel("zzzz").cancelled).toBe(false);
  });
});
