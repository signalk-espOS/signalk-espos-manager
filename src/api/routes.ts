/**
 * The webapp-facing HTTP API.
 *
 * Everything here lives under `/plugins/signalk-espos-manager/*`, which the
 * Signal K server gates to administrators. That is correct for a tool that
 * reconfigures and reflashes hardware — and it is exactly why the firmware
 * manifest a DEVICE fetches must not live here (a device holds a device
 * token, not an admin one). That goes under the public webapp mount instead.
 */

import type { ManagerService } from "../service.js";
import { PLUGIN_ID, PUBLIC_FW_BASE } from "../config.js";
import { configureOta } from "../ota/configure.js";
import { matchDevice, projectForApp } from "../registry/resolve.js";
import { summariseReleaseNotes } from "../mirror/manifest.js";
import { DeviceClient } from "../device/client.js";
import { serializeDevice, serializeFleet } from "./serialize.js";

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

interface RequestLike {
  params?: Record<string, string>;
  body?: unknown;
}

type Handler = (req: RequestLike, res: ResponseLike) => unknown;

export interface PluginRouter {
  get(path: string, handler: Handler): unknown;
  post(path: string, handler: Handler): unknown;
  delete(path: string, handler: Handler): unknown;
  /** Permission registrar (Signal K >= 2.x); feature-detect before use. */
  access?(level: "readonly" | "readwrite"): PluginRouter;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerRoutes(
  router: PluginRouter,
  getService: () => ManagerService,
): void {
  // registerWithRouter outlives stop(), so every handler that needs a running
  // plugin says 503 rather than acting on a stopped one.
  const guard =
    (handler: Handler): Handler =>
    (req, res) => {
      if (!getService().isRunning) {
        return res.status(503).json({ error: `${PLUGIN_ID} is not running` });
      }
      return handler(req, res);
    };

  const readonly =
    typeof router.access === "function" ? router.access("readonly") : router;

  // GET /api/fleet — the device list behind the Fleet page.
  readonly.get(
    "/api/fleet",
    guard((_req, res) => {
      const service = getService();
      return res.json(
        serializeFleet(
          service.fleet.list(),
          service.fleet.getWarnings(),
          service.getKeys(),
        ),
      );
    }),
  );

  // GET /api/fleet/:id — one device in full.
  readonly.get(
    "/api/fleet/:id",
    guard((req, res) => {
      const id = req.params?.id ?? "";
      const service = getService();
      const device = service.fleet.get(id);
      if (device === undefined) {
        return res.status(404).json({ error: `no device ${id}` });
      }
      return res.json(serializeDevice(device, service.getKeys()));
    }),
  );

  // POST /api/discovery/rescan — re-query mDNS and poll now.
  router.post(
    "/api/discovery/rescan",
    guard((_req, res) => {
      void (async () => {
        try {
          await getService().rescan();
          res.json({ ok: true, devices: getService().fleet.size });
        } catch (error) {
          res.status(500).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // POST /api/fleet/:id/key — store a key for one device and try it once.
  router.post(
    "/api/fleet/:id/key",
    guard((req, res) => {
      void (async () => {
        const id = req.params?.id ?? "";
        const body =
          typeof req.body === "object" && req.body !== null
            ? (req.body as Record<string, unknown>)
            : {};
        const key = typeof body.key === "string" ? body.key.trim() : "";
        if (key === "") {
          res.status(400).json({ error: "a key is required" });
          return;
        }
        const service = getService();
        const keys = service.getKeys();
        if (keys === undefined) {
          res.status(503).json({ error: "key store unavailable" });
          return;
        }
        const lockedUntil = keys.lockedOutUntil(id);
        if (lockedUntil !== undefined) {
          // Saying this plainly beats silently queueing an attempt that the
          // device will refuse anyway.
          res.status(409).json({
            error: "device is locked out after failed key attempts",
            retryAt: new Date(lockedUntil).toISOString(),
          });
          return;
        }
        try {
          await keys.setKeyFor(id, key);
          await service.rescan();
          res.json({ ok: true, auth: service.fleet.get(id)?.auth });
        } catch (error) {
          res.status(500).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // GET /api/mirror — what firmware is cached and whether devices can reach it.
  readonly.get(
    "/api/mirror",
    guard((_req, res) => {
      void (async () => {
        try {
          const service = getService();
          const status = service.getMirrorStatus();
          const store = service.getStore();
          const files = store === undefined ? [] : await store.list();
          res.json({
            ...status,
            cachedBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
            files: files.map((f) => ({
              app: f.app,
              version: f.version,
              filename: f.filename,
              sizeBytes: f.sizeBytes,
            })),
          });
        } catch (error) {
          res.status(500).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // GET /api/registry — the project list behind the Store page.
  readonly.get(
    "/api/registry",
    guard((_req, res) => {
      void (async () => {
        try {
          const result = await getService().getIndex();
          res.json({
            projects: result.index.projects,
            updated: result.index.updated,
            stale: result.stale,
            fetchedAt:
              result.fetchedAt === undefined
                ? undefined
                : new Date(result.fetchedAt).toISOString(),
            reason: result.reason,
            warnings: result.warnings,
          });
        } catch (error) {
          res.status(500).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // POST /api/registry/refresh — re-read the registry now.
  router.post(
    "/api/registry/refresh",
    guard((_req, res) => {
      void (async () => {
        try {
          const result = await getService().getIndex(true);
          res.json({
            ok: !result.stale,
            projects: result.index.projects.length,
            stale: result.stale,
            reason: result.reason,
          });
        } catch (error) {
          res.status(502).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // GET /api/fleet/:id/available — what this device could be updated to.
  readonly.get(
    "/api/fleet/:id/available",
    guard((req, res) => {
      void (async () => {
        try {
          const id = req.params?.id ?? "";
          const service = getService();
          const device = service.fleet.get(id);
          if (device === undefined) {
            res.status(404).json({ error: `no device ${id}` });
            return;
          }
          const app = device.snapshot?.app;
          if (app === undefined) {
            res.json({
              reason: "this device has not reported which firmware it runs yet",
            });
            return;
          }
          const { index } = await service.getIndex();
          const project = projectForApp(index, app);
          if (project === undefined) {
            res.json({
              reason: `no registry project provides "${app}"`,
            });
            return;
          }
          const settings = service.getSettings();
          const match = matchDevice(project, {
            app,
            target: device.snapshot?.target,
            board: device.snapshot?.board,
            runningVersion: device.snapshot?.version ?? "",
            channel: settings?.ota.channel ?? "stable",
            keyFp: device.snapshot?.ota?.running?.keyFp,
            includePrerelease: settings?.registry.includePrerelease,
          });
          // A release body is markdown — headings, commit links, bullet lists.
          // Rendered raw it buries the page (seen in the browser check), so
          // the same one-line summary the device gets is what the UI shows,
          // with the full notes a click away.
          const build =
            match.build === undefined
              ? undefined
              : {
                  ...match.build,
                  notes: summariseReleaseNotes(match.build.notes),
                };
          res.json({
            project: {
              id: project.id,
              name: project.name,
              repo: project.repo,
              official: project.official === true,
            },
            ...match,
            build,
          });
        } catch (error) {
          res.status(500).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // POST /api/fleet/:id/configure-ota — point a device at this server.
  router.post(
    "/api/fleet/:id/configure-ota",
    guard((req, res) => {
      void (async () => {
        try {
          const id = req.params?.id ?? "";
          const service = getService();
          const device = service.fleet.get(id);
          if (device === undefined) {
            res.status(404).json({ error: `no device ${id}` });
            return;
          }
          const app = device.snapshot?.app;
          if (app === undefined) {
            res.status(409).json({
              error:
                "this device has not reported which firmware it runs yet — " +
                "wait for the next poll",
            });
            return;
          }
          const address = device.identity.addresses[0];
          if (address === undefined) {
            res.status(409).json({ error: "no address known for this device" });
            return;
          }
          const settings = service.getSettings();
          const keys = service.getKeys();
          const client = new DeviceClient({
            address,
            port: device.identity.port,
            key: keys?.keyFor(id),
          });
          const result = await configureOta({
            client,
            app,
            channel: settings?.ota.channel ?? "stable",
            publicBase: PUBLIC_FW_BASE,
          });
          res.json({ ok: true, ...result });
        } catch (error) {
          res.status(502).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // GET /api/jobs — every update this session knows about.
  readonly.get(
    "/api/jobs",
    guard((_req, res) => {
      const orch = getService().getOrchestrator();
      res.json({
        jobs: orch?.list() ?? [],
        paused: orch?.isPaused ?? false,
        pausedReason: orch?.getPausedReason(),
      });
    }),
  );

  // POST /api/jobs/resume — continue a queue paused by a failure.
  router.post(
    "/api/jobs/resume",
    guard((_req, res) => {
      const orch = getService().getOrchestrator();
      if (orch === undefined) {
        res.status(503).json({ error: "no update queue" });
        return;
      }
      orch.resume();
      res.json({ ok: true, paused: orch.isPaused });
    }),
  );

  // POST /api/fleet/:id/update — mirror the firmware, then install it.
  router.post(
    "/api/fleet/:id/update",
    guard((req, res) => {
      void (async () => {
        try {
          const id = req.params?.id ?? "";
          const body =
            typeof req.body === "object" && req.body !== null
              ? (req.body as Record<string, unknown>)
              : {};
          const result = await getService().startUpdate(id, {
            confirmDowngrade: body.confirmDowngrade === true,
          });
          if (!result.ok) {
            res.status(result.status ?? 409).json({ error: result.error });
            return;
          }
          res.json({ ok: true, job: result.job });
        } catch (error) {
          res.status(502).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // DELETE /api/fleet/:id/job — drop a queued update.
  router.delete(
    "/api/fleet/:id/job",
    guard((req, res) => {
      const id = req.params?.id ?? "";
      const orch = getService().getOrchestrator();
      const result = orch?.cancel(id) ?? {
        cancelled: false,
        reason: "no update queue",
      };
      res.status(result.cancelled ? 200 : 409).json(result);
    }),
  );

  // POST /api/fleet/:id/confirm — accept a pending image.
  router.post(
    "/api/fleet/:id/confirm",
    guard((req, res) => {
      void (async () => {
        try {
          const client = getService().clientFor(req.params?.id ?? "");
          if (client === undefined) {
            res.status(404).json({ error: "no such device" });
            return;
          }
          await client.otaConfirm();
          res.json({ ok: true });
        } catch (error) {
          res.status(502).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // POST /api/fleet/:id/rollback — go back to the previous image.
  router.post(
    "/api/fleet/:id/rollback",
    guard((req, res) => {
      void (async () => {
        try {
          const client = getService().clientFor(req.params?.id ?? "");
          if (client === undefined) {
            res.status(404).json({ error: "no such device" });
            return;
          }
          await client.otaRollback();
          res.json({ ok: true });
        } catch (error) {
          res.status(502).json({ error: errorMessage(error) });
        }
      })();
    }),
  );

  // DELETE /api/fleet/:id — forget a device and its key.
  router.delete(
    "/api/fleet/:id",
    guard((req, res) => {
      void (async () => {
        const id = req.params?.id ?? "";
        try {
          const service = getService();
          // Deleting the key touches the disk and can fail (permissions, a
          // full card). Unhandled, the rejection escapes this un-awaited IIFE
          // and the request simply never answers.
          await service.getKeys()?.removeKeyFor(id);
          const removed = service.fleet.forget(id);
          res.json({ ok: removed });
        } catch (error) {
          res.status(500).json({ error: errorMessage(error) });
        }
      })();
    }),
  );
}
