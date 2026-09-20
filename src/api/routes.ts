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
import { PLUGIN_ID } from "../config.js";
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
