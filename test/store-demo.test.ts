/**
 * The webapp on a demo server: the fleet says it is a demo, which is shown to
 * a visitor with no login, read-only; anywhere else nothing changes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../web/src/store.js";

const API = "/plugins/signalk-espos-manager/api";
const LOGIN = "/skServer/loginStatus";

const fleet = (demo?: boolean) => ({
  devices: [],
  summary: {},
  warnings: [],
  ...(demo === undefined ? {} : { demo }),
});
const rest = {
  [`${API}/mirror`]: {},
  [`${API}/jobs`]: { jobs: [], paused: false },
  [`${API}/registry`]: { projects: [] },
};
const loggedOut = { [LOGIN]: { status: "notLoggedIn" } };
const loggedIn = { [LOGIN]: { status: "loggedIn", username: "admin" } };

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
  useStore.setState({
    readOnly: false,
    needsLogin: false,
    fleet: undefined,
    loadError: undefined,
  });
});

describe("store on a demo server", () => {
  it("shows the demo to a visitor with no login", async () => {
    serve({ ...rest, ...loggedOut, [`${API}/fleet`]: fleet(true) });
    await useStore.getState().refresh();
    const state = useStore.getState();
    expect(state.readOnly).toBe(true);
    expect(state.needsLogin).toBe(false);
    expect(state.fleet).toBeDefined();
  });

  it("asks nobody to log in once it knows the demo", async () => {
    serve({ ...rest, ...loggedOut, [`${API}/fleet`]: fleet(true) });
    await useStore.getState().refresh();
    const asked = serve({ ...rest, [`${API}/fleet`]: fleet(true) });
    await useStore.getState().refresh();
    expect(asked).not.toContain(LOGIN);
    expect(useStore.getState().readOnly).toBe(true);
  });

  it("runs no action", async () => {
    serve({ ...rest, ...loggedOut, [`${API}/fleet`]: fleet(true) });
    await useStore.getState().refresh();
    const action = vi.fn(() => Promise.resolve());
    await useStore.getState().act("Rescan", action);
    expect(action).not.toHaveBeenCalled();
  });

  it("keeps the demo through a failed refresh", async () => {
    serve({ ...rest, ...loggedOut, [`${API}/fleet`]: fleet(true) });
    await useStore.getState().refresh();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("{}", { status: 503 })),
    );
    await useStore.getState().refresh();
    const state = useStore.getState();
    expect(state.readOnly).toBe(true);
    expect(state.needsLogin).toBe(false);
  });

  it("drops the virtual fleet and checks the login when the demo ends", async () => {
    serve({ ...rest, ...loggedOut, [`${API}/fleet`]: fleet(true) });
    await useStore.getState().refresh();
    const asked = serve({
      ...rest,
      ...loggedOut,
      [`${API}/fleet`]: fleet(false),
    });
    await useStore.getState().refresh();
    const state = useStore.getState();
    expect(asked).toContain(LOGIN);
    expect(state.readOnly).toBe(false);
    expect(state.needsLogin).toBe(true);
  });
});

describe("store elsewhere", () => {
  it("asks for a login when the server is no demo", async () => {
    serve({ ...rest, ...loggedOut, [`${API}/fleet`]: fleet(false) });
    await useStore.getState().refresh();
    const state = useStore.getState();
    expect(state.readOnly).toBe(false);
    expect(state.needsLogin).toBe(true);
  });

  it("asks for a login when the fleet is refused", async () => {
    serve(loggedOut);
    await useStore.getState().refresh();
    expect(useStore.getState().needsLogin).toBe(true);
  });

  it("works as before with an older plugin", async () => {
    serve({ ...rest, ...loggedIn, [`${API}/fleet`]: fleet() });
    await useStore.getState().refresh();
    const state = useStore.getState();
    expect(state.readOnly).toBe(false);
    expect(state.needsLogin).toBe(false);
    expect(state.fleet).toBeDefined();
  });
});
