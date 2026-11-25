import { describe, expect, it, vi } from "vitest";
import { createBroker, deviceForUrl } from "../src/broker/index.js";
import type { DeviceRecord } from "../src/types.js";

function device(id: string, hostname: string, address: string): DeviceRecord {
  return {
    identity: { id, hostname, addresses: [address], port: 80, sources: {} },
    reachability: "online",
    auth: "authorized",
    lastSeenAt: 0,
    consecutiveFailures: 0,
  } as unknown as DeviceRecord;
}

const panel = device("ab12", "espos-ab12", "192.168.0.167");

function deps(fetchImpl: typeof fetch, withKey = true, accepted = true) {
  const key = withKey ? "k1" : undefined;
  return {
    isCurrent: vi.fn(() => true),
    devices: () => [panel],
    keyToSend: vi.fn(() => key),
    keyAccepted: vi.fn(() => accepted),
    noteRefused: vi.fn(),
    noteSuccess: vi.fn(),
    markLockedOut: vi.fn(),
    fetchImpl,
  };
}

function answer(status: number, body: unknown = {}, headers = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("deviceForUrl", () => {
  it("matches by address, hostname and .local name", () => {
    const list = [panel];
    expect(deviceForUrl(list, "http://192.168.0.167/hello")).toBe(panel);
    expect(deviceForUrl(list, "http://espos-ab12/layout")).toBe(panel);
    expect(deviceForUrl(list, "http://ESPOS-AB12.local:80/hello")).toBe(panel);
  });

  it("ignores other hosts and broken URLs", () => {
    expect(deviceForUrl([panel], "http://192.168.0.10/")).toBeUndefined();
    expect(deviceForUrl([panel], "not a url")).toBeUndefined();
  });
});

describe("broker", () => {
  it("leaves unknown hosts to the caller", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const broker = createBroker(deps(fetchImpl));
    expect(await broker.request("http://example.org/")).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("adds the device's key and notes success", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answer(200));
    const d = deps(fetchImpl);
    const res = await createBroker(d).request(
      "http://espos-ab12.local/layout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(res?.status).toBe(200);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer k1",
    });
    expect(d.noteSuccess).toHaveBeenCalledWith("ab12", "k1");
  });

  it("keeps an Authorization header the caller set", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answer(401));
    const d = deps(fetchImpl);
    await createBroker(d).request("http://espos-ab12/hello", {
      headers: { authorization: "Bearer mine" },
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: "Bearer mine",
    });
    expect(d.noteRefused).not.toHaveBeenCalled();
  });

  it("sends no key when none may be sent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answer(401));
    const d = deps(fetchImpl, false);
    const res = await createBroker(d).request("http://espos-ab12/layout");
    expect(res?.status).toBe(401);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({});
    expect(d.noteRefused).not.toHaveBeenCalled();
  });

  it("records a refused key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answer(401));
    const d = deps(fetchImpl);
    await createBroker(d).request("http://espos-ab12/layout");
    expect(d.noteRefused).toHaveBeenCalledWith("ab12", "k1");
  });

  it("records espOS's key throttle but not an endpoint's own 429", async () => {
    const throttled = vi.fn<typeof fetch>(async () =>
      answer(429, { error: "too_many_attempts" }, { "Retry-After": "30" }),
    );
    const d1 = deps(throttled);
    const res = await createBroker(d1).request("http://espos-ab12/layout");
    expect(d1.markLockedOut).toHaveBeenCalledWith("ab12", 30);
    expect(await res?.json()).toEqual({ error: "too_many_attempts" });

    const busy = vi.fn<typeof fetch>(async () =>
      answer(429, { ok: false, err: "screenshot in flight" }),
    );
    const d2 = deps(busy);
    await createBroker(d2).request("http://espos-ab12/screenshot");
    expect(d2.markLockedOut).not.toHaveBeenCalled();
  });
});

describe("broker, more", () => {
  it("answers undefined once withdrawn", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answer(200));
    const d = deps(fetchImpl);
    d.isCurrent.mockReturnValue(false);
    expect(await createBroker(d).request("http://espos-ab12/")).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the default lockout when Retry-After is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      answer(429, { error: "too_many_attempts" }),
    );
    const d = deps(fetchImpl);
    await createBroker(d).request("http://espos-ab12/layout");
    expect(d.markLockedOut).toHaveBeenCalledWith("ab12", undefined);
  });

  it("propagates a device that does not answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const d = deps(fetchImpl);
    await expect(
      createBroker(d).request("http://espos-ab12/layout"),
    ).rejects.toThrow("fetch failed");
    expect(d.noteRefused).not.toHaveBeenCalled();
  });

  it("tests an untried key with one request at a time", async () => {
    let refused = false;
    const sent: Array<string | undefined> = [];
    let release: (r: Response) => void = () => undefined;
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      sent.push(auth);
      if (sent.length === 1) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(answer(auth === undefined ? 401 : 200));
    });
    const d = deps(fetchImpl, true, false);
    d.keyToSend.mockImplementation(() => (refused ? undefined : "k1"));
    d.noteRefused.mockImplementation(() => {
      refused = true;
    });
    const broker = createBroker(d);
    const first = broker.request("http://espos-ab12/screenshot");
    const second = broker.request("http://espos-ab12/screenshot");
    const third = broker.request("http://espos-ab12/screenshot");
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual(["Bearer k1"]);
    release(answer(401, { error: "unauthorized" }));
    expect((await first)?.status).toBe(401);
    await Promise.all([second, third]);
    expect(sent).toEqual(["Bearer k1", undefined, undefined]);
    expect(d.noteRefused).toHaveBeenCalledTimes(1);
  });
});

describe("KeyStore.keyToSend", () => {
  it("withholds a refused key until a different one is set", async () => {
    const { KeyStore } = await import("../src/device/auth.js");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const keys = new KeyStore({
      dataDir: await mkdtemp(join(tmpdir(), "broker-")),
    });
    await keys.load();
    keys.setFleetKey("old");
    expect(keys.keyToSend("ab12")).toBe("old");
    keys.noteRefused("ab12", "old");
    expect(keys.keyToSend("ab12")).toBeUndefined();
    keys.setFleetKey("new");
    expect(keys.keyToSend("ab12")).toBe("new");
    keys.markLockedOut("ab12", 30);
    expect(keys.keyToSend("ab12")).toBeUndefined();
  });

  it("records the key that was refused, not the current one", async () => {
    const { KeyStore } = await import("../src/device/auth.js");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const keys = new KeyStore({
      dataDir: await mkdtemp(join(tmpdir(), "broker-")),
    });
    await keys.load();
    keys.setFleetKey("fleet");
    await keys.setKeyFor("ab12", "own");
    expect(keys.keyToSend("ab12")).toBe("own");
    // "fleet" was in flight when the device got its own key.
    keys.noteRefused("ab12", "fleet");
    expect(keys.keyToSend("ab12")).toBe("own");
    keys.noteSuccess("ab12", "own");
    expect(keys.keyAccepted("ab12", "own")).toBe(true);
    keys.noteRefused("ab12", "own");
    expect(keys.keyAccepted("ab12", "own")).toBe(false);
    expect(keys.keyToSend("ab12")).toBeUndefined();
  });
});
