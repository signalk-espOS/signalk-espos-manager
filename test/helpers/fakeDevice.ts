/**
 * A throwaway HTTP server that behaves like an espOS device, for tests that
 * need the real fetch path rather than a mocked client.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeDeviceOptions {
  app?: string;
  version?: string;
  /** When set, protected endpoints demand this Bearer key. */
  key?: string;
  /** Answer 429 to authenticated calls until this many have been made. */
  throttleAfter?: number;
  retryAfterS?: number;
  info?: Record<string, unknown>;
  ota?: Record<string, unknown>;
}

export interface FakeDevice {
  address: string;
  port: number;
  /** Every request path seen, in order. */
  requests: string[];
  /** Requests that carried an Authorization header. */
  authAttempts: number;
  options: FakeDeviceOptions;
  close(): Promise<void>;
}

export async function startFakeDevice(
  options: FakeDeviceOptions = {},
): Promise<FakeDevice> {
  const state: FakeDevice = {
    address: "127.0.0.1",
    port: 0,
    requests: [],
    authAttempts: 0,
    options: { app: "cockpit", version: "1.2.0", ...options },
    close: async () => {
      /* replaced below */
    },
  };

  const server: Server = createServer((req, res) => {
    const path = req.url ?? "";
    state.requests.push(path);
    const auth = req.headers.authorization;
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (path === "/api/v1/system/ping") {
      send(200, {
        app: state.options.app,
        version: state.options.version,
        auth: state.options.key !== undefined,
      });
      return;
    }

    // Everything else is protected when a key is configured.
    if (state.options.key !== undefined) {
      state.authAttempts += 1;
      if (
        state.options.throttleAfter !== undefined &&
        state.authAttempts > state.options.throttleAfter
      ) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (state.options.retryAfterS !== undefined) {
          headers["Retry-After"] = String(state.options.retryAfterS);
        }
        res.writeHead(429, headers);
        res.end(JSON.stringify({ error: "too many attempts" }));
        return;
      }
      if (auth !== `Bearer ${state.options.key}`) {
        send(401, { error: "unauthorized" });
        return;
      }
    }

    if (path === "/api/v1/system/info") {
      send(200, {
        app: state.options.app,
        version: state.options.version,
        chip: "esp32p4",
        cores: 2,
        ...state.options.info,
      });
      return;
    }
    if (path === "/api/v1/ota/status") {
      send(200, {
        state: "idle",
        running: {
          version: state.options.version,
          project: state.options.app,
          target: "esp32p4",
          confirmed: true,
        },
        available: null,
        ...state.options.ota,
      });
      return;
    }
    send(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  return state;
}
