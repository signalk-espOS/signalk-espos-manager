/**
 * The webapp on a demo server: the demo is shown to a visitor with no login,
 * read-only, and an older plugin without /api/mode leaves everything as it was.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../web/src/store.js";

const empty = {
  "/plugins/signalk-espos-manager/api/fleet": {
    devices: [],
    summary: {},
    warnings: [],
  },
  "/plugins/signalk-espos-manager/api/mirror": {},
  "/plugins/signalk-espos-manager/api/jobs": { jobs: [], paused: false },
  "/plugins/signalk-espos-manager/api/registry": { projects: [] },
};

function serve(routes: Record<string, unknown>): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    asked.push(url);
    const body = routes[url];
    return Promise.resolve(
      body === undefined
        ? new Response("{}", { status: 401 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useStore.setState({ readOnly: false, needsLogin: false });
});

describe("store on a demo server", () => {
  it("loads the fleet without asking who is logged in", async () => {
    const asked = serve({
      ...empty,
      "/plugins/signalk-espos-manager/api/mode": { demo: true },
    });
    await useStore.getState().refresh();
    const state = useStore.getState();
    expect(state.readOnly).toBe(true);
    expect(state.needsLogin).toBe(false);
    expect(state.fleet).toBeDefined();
    expect(asked).not.toContain("/skServer/loginStatus");
  });

  it("runs no action", async () => {
    serve({
      ...empty,
      "/plugins/signalk-espos-manager/api/mode": { demo: true },
    });
    await useStore.getState().refresh();
    const action = vi.fn(() => Promise.resolve());
    await useStore.getState().act("Rescan", action);
    expect(action).not.toHaveBeenCalled();
  });

  it("asks for a login as before when /api/mode is refused", async () => {
    serve({ "/skServer/loginStatus": { status: "notLoggedIn" } });
    await useStore.getState().refresh();
    const state = useStore.getState();
    expect(state.readOnly).toBe(false);
    expect(state.needsLogin).toBe(true);
  });
});
