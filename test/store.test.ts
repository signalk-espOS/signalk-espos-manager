/**
 * The webapp store: an action's outcome must outlive the background refresh,
 * and an action's busy state belongs to that action alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  impl: (): Promise<unknown> => Promise.resolve({}),
  calls: 0,
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
      registry: () => {
        registry.calls += 1;
        return registry.impl();
      },
      available: () => Promise.resolve({}),
    },
  };
});

const { useStore } = await import("../web/src/store.js");

beforeEach(() => {
  registry.impl = () => Promise.resolve({});
  registry.calls = 0;
  useStore.setState({
    error: undefined,
    notice: undefined,
    inlineError: undefined,
    loadError: undefined,
    acting: [],
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
    let seen: string[] = [];
    await useStore.getState().act("Point this device at the server", () => {
      seen = useStore.getState().acting;
      return Promise.resolve();
    });
    expect(seen).toEqual(["Point this device at the server"]);
    expect(useStore.getState().acting).toEqual([]);
    expect(useStore.getState().notice).toMatch(/done/);
  });

  it("finishes an action without waiting for the registry", async () => {
    // The registry is an internet fetch that can take seconds or never
    // return; awaiting it kept the button busy for just as long.
    let release = (): void => undefined;
    registry.impl = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({});
        };
      });
    await useStore
      .getState()
      .act("Point espos-2be9 at the server", () => Promise.resolve());
    expect(useStore.getState().acting).toEqual([]);
    expect(useStore.getState().notice).toMatch(/done/);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("keys the busy state and inline error by the given key", async () => {
    let seen: string[] = [];
    await useStore.getState().act(
      "Point espos-2be9 at the server",
      () => {
        seen = useStore.getState().acting;
        return Promise.reject(new Error("refused"));
      },
      { errorInline: true, key: "configure-ota:2be9" },
    );
    expect(seen).toEqual(["configure-ota:2be9"]);
    expect(useStore.getState().inlineError?.key).toBe("configure-ota:2be9");
  });

  it("keeps an action busy while another one finishes", async () => {
    let finishFix = (): void => undefined;
    const fix = useStore.getState().act(
      "Point espos-2be9 at the server",
      () =>
        new Promise<void>((resolve) => {
          finishFix = resolve;
        }),
      { key: "configure-ota:2be9" },
    );
    await useStore.getState().act("Save key", () => Promise.resolve());
    expect(useStore.getState().acting).toEqual(["configure-ota:2be9"]);

    finishFix();
    await fix;
    expect(useStore.getState().acting).toEqual([]);
  });

  it("does not start a registry fetch while one is outstanding", async () => {
    let release = (): void => undefined;
    registry.impl = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({});
        };
      });
    await useStore.getState().refresh();
    await useStore.getState().refresh();
    expect(registry.calls).toBe(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await useStore.getState().refresh();
    expect(registry.calls).toBe(2);
  });
});
