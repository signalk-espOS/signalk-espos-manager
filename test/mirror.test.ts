/**
 * Firmware-cache and public-mount tests, against a real filesystem and a real
 * HTTP server rather than mocks — the interesting failures here are all
 * filesystem and network behaviour.
 */

import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeSegment,
  FirmwareStore,
  UnsafePathError,
} from "../src/mirror/store.js";
import {
  ensureFirmwareLink,
  removeFirmwareLink,
  verifyMountServed,
} from "../src/mirror/publish.js";

let base: string;

beforeEach(async () => {
  // Under the user's dev tmp, never the RAM-backed /tmp.
  base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "espos-mirror-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function makeStore(
  over: Partial<{ maxBytes: number; keepVersions: number }> = {},
) {
  return new FirmwareStore({
    root: join(base, "fw"),
    maxBytes: over.maxBytes ?? 10_000_000,
    keepVersions: over.keepVersions ?? 3,
  });
}

/** A server that serves one body, optionally lying about its length. */
async function serveBytes(body: Buffer): Promise<{
  url: string;
  requests: number;
  close: () => Promise<void>;
}> {
  const state = { requests: 0 };
  const server: Server = createServer((_req, res) => {
    state.requests += 1;
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
    });
    res.end(body);
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/firmware.bin`,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

describe("path safety", () => {
  it("accepts the segments real projects use", () => {
    for (const s of ["cockpit", "ble_gateway", "1.3.0", "p4_cockpit-ota.bin"]) {
      expect(() => {
        assertSafeSegment(s);
      }).not.toThrow();
    }
  });

  it("rejects traversal and separators", () => {
    // The registry is third-party content: an entry must not be able to write
    // outside the cache or publish an arbitrary file.
    for (const s of [
      "..",
      ".",
      "../etc",
      "a/b",
      "a\\b",
      "/abs",
      "",
      "-leading-dash",
      "x".repeat(200),
    ]) {
      expect(
        () => {
          assertSafeSegment(s);
        },
        `${JSON.stringify(s)} must be rejected`,
      ).toThrow(UnsafePathError);
    }
  });

  it("refuses to build a path from an unsafe segment", () => {
    const store = makeStore();
    expect(() => store.filePath("cockpit", "../../etc", "passwd")).toThrow(
      UnsafePathError,
    );
    expect(() => store.appDir("../evil")).toThrow(UnsafePathError);
  });
});

describe("FirmwareStore.ensure", () => {
  it("downloads, hashes and caches an image", async () => {
    const body = Buffer.alloc(4096, 7);
    const server = await serveBytes(body);
    try {
      const store = makeStore();
      const file = await store.ensure({
        url: server.url,
        app: "cockpit",
        version: "1.3.0",
        filename: "p4_cockpit-ota.bin",
      });
      expect(file.sizeBytes).toBe(4096);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await readFile(file.path)).equals(body)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("does not download again when the file is already cached", async () => {
    const server = await serveBytes(Buffer.alloc(512, 1));
    try {
      const store = makeStore();
      const args = {
        url: server.url,
        app: "cockpit",
        version: "1.3.0",
        filename: "ota.bin",
      };
      await store.ensure(args);
      await store.ensure(args);
      expect(server.requests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("reports progress as it streams", async () => {
    const server = await serveBytes(Buffer.alloc(64 * 1024, 3));
    try {
      const store = makeStore();
      const seen: number[] = [];
      await store.ensure({
        url: server.url,
        app: "cockpit",
        version: "1.3.0",
        filename: "ota.bin",
        onProgress: (p) => seen.push(p.receivedBytes),
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.at(-1)).toBe(64 * 1024);
    } finally {
      await server.close();
    }
  });

  it("discards a download whose checksum does not match", async () => {
    const server = await serveBytes(Buffer.alloc(1024, 9));
    try {
      const store = makeStore();
      await expect(
        store.ensure({
          url: server.url,
          app: "cockpit",
          version: "1.3.0",
          filename: "ota.bin",
          sha256: "b".repeat(64),
        }),
      ).rejects.toThrow(/failed its checksum/);
      // Nothing half-written is left behind to be mistaken for a good image.
      expect(await store.has("cockpit", "1.3.0", "ota.bin")).toBe(false);
      await expect(
        stat(join(base, "fw", "cockpit", "1.3.0", "ota.bin.part")),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("refuses a download that would blow the cache budget", async () => {
    const server = await serveBytes(Buffer.alloc(1024, 1));
    try {
      const store = makeStore({ maxBytes: 2048 });
      await expect(
        store.ensure({
          url: server.url,
          app: "cockpit",
          version: "1.3.0",
          filename: "big.bin",
          expectedBytes: 5000,
        }),
      ).rejects.toThrow(/exceed the 2048-byte firmware cache limit/);
      // Refused before any request went out.
      expect(server.requests).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("surfaces an HTTP error rather than caching an error page", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404).end("nope");
    });
    await new Promise<void>((r) => {
      server.listen(0, "127.0.0.1", r);
    });
    const { port } = server.address() as AddressInfo;
    try {
      const store = makeStore();
      await expect(
        store.ensure({
          url: `http://127.0.0.1:${port}/missing.bin`,
          app: "cockpit",
          version: "1.3.0",
          filename: "ota.bin",
        }),
      ).rejects.toThrow(/HTTP 404/);
      expect(await store.has("cockpit", "1.3.0", "ota.bin")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("FirmwareStore manifests and pruning", () => {
  it("writes and reads a manifest atomically", async () => {
    const store = makeStore();
    const json = '{"schema":1,"app":"cockpit","builds":[]}';
    const path = await store.writeManifest("cockpit", json);
    expect(path.endsWith(join("cockpit", "manifest.json"))).toBe(true);
    expect(await store.readManifest("cockpit")).toBe(json);
    // No temp file left behind.
    await expect(stat(`${path}.tmp`)).rejects.toThrow();
  });

  it("returns undefined for an app with no manifest", async () => {
    expect(await makeStore().readManifest("cockpit")).toBeUndefined();
  });

  it("prunes the oldest versions beyond the keep count", async () => {
    const store = makeStore({ keepVersions: 2 });
    for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.10.0"]) {
      await mkdir(join(base, "fw", "cockpit", v), { recursive: true });
      await writeFile(join(base, "fw", "cockpit", v, "ota.bin"), "x");
    }
    const removed = await store.prune("cockpit");
    // Version ordering, not string ordering: 1.10.0 is the newest.
    expect(removed).toEqual(["1.0.0", "1.1.0"]);
    expect(await store.has("cockpit", "1.10.0", "ota.bin")).toBe(true);
    expect(await store.has("cockpit", "1.2.0", "ota.bin")).toBe(true);
  });

  it("never prunes a version a device is using", async () => {
    // Evicting the image a device is mid-download on would fail that update.
    const store = makeStore({ keepVersions: 1 });
    for (const v of ["1.0.0", "1.1.0", "1.2.0"]) {
      await mkdir(join(base, "fw", "cockpit", v), { recursive: true });
      await writeFile(join(base, "fw", "cockpit", v, "ota.bin"), "x");
    }
    const removed = await store.prune("cockpit", ["1.0.0"]);
    expect(removed).not.toContain("1.0.0");
    expect(await store.has("cockpit", "1.0.0", "ota.bin")).toBe(true);
  });

  it("totals and lists what is cached", async () => {
    const store = makeStore();
    await mkdir(join(base, "fw", "cockpit", "1.3.0"), { recursive: true });
    await writeFile(join(base, "fw", "cockpit", "1.3.0", "a.bin"), "12345");
    expect(await store.totalBytes()).toBe(5);
    const files = await store.list();
    expect(files).toHaveLength(1);
    expect(files[0]?.app).toBe("cockpit");
  });

  it("ignores directories whose names are not safe segments", async () => {
    const store = makeStore();
    await mkdir(join(base, "fw", "..evil"), { recursive: true });
    await writeFile(join(base, "fw", "..evil", "x.bin"), "zz");
    expect(await store.list()).toEqual([]);
  });
});

describe("the mount probe", () => {
  it("refuses a dotfile name", async () => {
    // serve-static ignores dotfiles by default, so a probe called
    // ".mount-probe" 404s through a mount that is working perfectly — and a
    // probe that reports a healthy mirror as broken is worse than none.
    // Verified against signalk-server 2.32.0: the same bytes served 200 as
    // "mount-probe.txt" and 404 as ".mount-probe".
    const store = makeStore();
    await expect(store.writeProbe(".mount-probe", "x")).rejects.toThrow(
      UnsafePathError,
    );
  });

  it("writes an undotted probe at the cache root", async () => {
    const store = makeStore();
    const path = await store.writeProbe("mount-probe.txt", "hello");
    expect(path.endsWith("mount-probe.txt")).toBe(true);
    expect(await readFile(path, "utf8")).toBe("hello");
  });
});

describe("the public firmware mount", () => {
  it("creates the symlink and reports mirror mode", async () => {
    const publicDir = join(base, "public");
    await mkdir(publicDir, { recursive: true });
    const result = await ensureFirmwareLink({ dataDir: base, publicDir });
    expect(result.mode).toBe("mirror");
    const s = await stat(join(publicDir, "fw"));
    expect(s.isDirectory()).toBe(true); // resolves through the link
  });

  it("is idempotent across restarts", async () => {
    const publicDir = join(base, "public");
    await mkdir(publicDir, { recursive: true });
    await ensureFirmwareLink({ dataDir: base, publicDir });
    const again = await ensureFirmwareLink({ dataDir: base, publicDir });
    expect(again.mode).toBe("mirror");
  });

  it("repoints a symlink aimed somewhere else", async () => {
    const publicDir = join(base, "public");
    await mkdir(publicDir, { recursive: true });
    await mkdir(join(base, "elsewhere"), { recursive: true });
    await symlink(join(base, "elsewhere"), join(publicDir, "fw"));
    const result = await ensureFirmwareLink({ dataDir: base, publicDir });
    expect(result.mode).toBe("mirror");
    await writeFile(join(base, "fw", "probe.txt"), "here");
    expect(await readFile(join(publicDir, "fw", "probe.txt"), "utf8")).toBe(
      "here",
    );
  });

  it("refuses to delete a real directory in its place", async () => {
    // Either someone else's data or a sign the layout is not what we think.
    const publicDir = join(base, "public");
    await mkdir(join(publicDir, "fw"), { recursive: true });
    await writeFile(join(publicDir, "fw", "keep-me.txt"), "precious");
    const result = await ensureFirmwareLink({ dataDir: base, publicDir });
    expect(result.mode).toBe("upstream");
    expect(result.reason).toMatch(/real directory/);
    expect(await readFile(join(publicDir, "fw", "keep-me.txt"), "utf8")).toBe(
      "precious",
    );
  });

  it("replaces a stray file", async () => {
    const publicDir = join(base, "public");
    await mkdir(publicDir, { recursive: true });
    await writeFile(join(publicDir, "fw"), "not a directory");
    const result = await ensureFirmwareLink({ dataDir: base, publicDir });
    expect(result.mode).toBe("mirror");
  });

  it("falls back to upstream when the path is not served over HTTP", async () => {
    // Filesystem state is not evidence that a device can fetch the file: the
    // keyword could be missing, or a proxy could rewrite the path.
    const failed = await verifyMountServed(async () => false, "probe.txt");
    expect(failed.mode).toBe("upstream");
    expect(failed.reason).toMatch(/not reachable over HTTP/);

    const ok = await verifyMountServed(async () => true, "probe.txt");
    expect(ok.mode).toBe("mirror");
  });

  it("treats a throwing probe as a fallback, not a crash", async () => {
    const result = await verifyMountServed(async () => {
      throw new Error("connection refused");
    }, "probe.txt");
    expect(result.mode).toBe("upstream");
    expect(result.reason).toMatch(/connection refused/);
  });

  it("removes only a symlink, never real data", async () => {
    const publicDir = join(base, "public");
    await mkdir(join(publicDir, "fw"), { recursive: true });
    await writeFile(join(publicDir, "fw", "precious.txt"), "data");
    await removeFirmwareLink(publicDir);
    expect(await readFile(join(publicDir, "fw", "precious.txt"), "utf8")).toBe(
      "data",
    );
  });
});
