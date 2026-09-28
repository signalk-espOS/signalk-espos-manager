/**
 * The webapp store: an action's outcome must outlive the background refresh.
 *
 * The page refreshes every 5 s, and each successful refresh used to clear
 * `error`. A "Fix this" that failed was therefore on screen for about two
 * seconds before the next tick wiped it, which reads as the button doing
 * nothing at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  impl: (): Promise<unknown> => Promise.resolve({}),
}));

vi.mock("../web/src/api.js", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
    get isUnauthorized(): boolean {
      return this.status === 401 || this.status === 403;
    }
  }
  return {
    ApiError,
    loginStatus: () => Promise.resolve({ loggedIn: true }),
    api: {
      fleet: () =>
        Promise.resolve({ summary: { total: 0 }, devices: [], warnings: [] }),
      mirror: () => Promise.resolve({}),
      jobs: () => Promise.resolve({ jobs: [] }),
      registry: () => registry.impl(),
      available: () => Promise.resolve({}),
    },
  };
});

const { useStore } = await import("../web/src/store.js");

beforeEach(() => {
  registry.impl = () => Promise.resolve({});
  useStore.setState({
    error: undefined,
    notice: undefined,
    inlineError: undefined,
    loadError: undefined,
    acting: undefined,
  });
});

describe("store actions", () => {
  it("keeps a failed action's error across a background refresh", async () => {
    await useStore
      .getState()
      .act("Point this device at the server", () =>
        Promise.reject(new Error("the device did not answer (ECONNREFUSED)")),
      );
    expect(useStore.getState().error).toMatch(/ECONNREFUSED/);

    await useStore.getState().refresh();
    expect(useStore.getState().error).toMatch(/ECONNREFUSED/);
  });

  it("puts an inline failure beside its control, not in the banner", async () => {
    await useStore
      .getState()
      .act(
        "Point this device at the server",
        () => Promise.reject(new Error("refused")),
        { errorInline: true },
      );
    const state = useStore.getState();
    expect(state.error).toBeUndefined();
    expect(state.inlineError).toEqual({
      key: "Point this device at the server",
      message: "refused",
    });
  });

  it("marks the action busy while it runs, and idle after", async () => {
    let seen: string | undefined;
    await useStore.getState().act("Point this device at the server", () => {
      seen = useStore.getState().acting;
      return Promise.resolve();
    });
    expect(seen).toBe("Point this device at the server");
    expect(useStore.getState().acting).toBeUndefined();
    expect(useStore.getState().notice).toMatch(/done/);
  });

  it("finishes an action without waiting for the registry", async () => {
    // The registry is an internet fetch that can take seconds or never
    // return; awaiting it kept the button busy for just as long.
    registry.impl = () => new Promise(() => undefined);
    await useStore
      .getState()
      .act("Point espos-2be9 at the server", () => Promise.resolve());
    expect(useStore.getState().acting).toBeUndefined();
    expect(useStore.getState().notice).toMatch(/done/);
  });

  it("keys the busy state and inline error by the given key", async () => {
    let seen: string | undefined;
    await useStore.getState().act(
      "Point espos-2be9 at the server",
      () => {
        seen = useStore.getState().acting;
        return Promise.reject(new Error("refused"));
      },
      { errorInline: true, key: "configure-ota:2be9" },
    );
    expect(seen).toBe("configure-ota:2be9");
    expect(useStore.getState().inlineError?.key).toBe("configure-ota:2be9");
  });
});
