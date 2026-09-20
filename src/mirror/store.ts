/**
 * The firmware cache on disk.
 *
 * Lives under `app.getDataDirPath()` so it survives plugin updates — anything
 * written inside `node_modules` is replaced wholesale on the next install,
 * which is the classic "worked for months, gone after an update" bug.
 *
 * Layout, chosen so the manifest can use root-relative URLs:
 *
 *   <dataDir>/fw/<app>/manifest.json
 *   <dataDir>/fw/<app>/<version>/<filename>
 *
 * Every path segment is validated before it touches the filesystem. The
 * registry is third-party content: a project entry must not be able to write
 * outside the cache or make the server publish an arbitrary file.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppName } from "../types.js";

/** One path segment: no separators, no traversal, no surprises. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CachedFile {
  app: AppName;
  version: string;
  filename: string;
  path: string;
  sizeBytes: number;
  sha256?: string;
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes?: number;
}

export interface FetchOptions {
  url: string;
  app: AppName;
  version: string;
  filename: string;
  /** Expected size, used for the cache-budget pre-flight. */
  expectedBytes?: number;
  /** Expected digest; a mismatch discards the download. */
  sha256?: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class UnsafePathError extends Error {
  constructor(segment: string) {
    super(
      `refusing to use ${JSON.stringify(segment)} as a path segment: it must ` +
        `match ${String(SAFE_SEGMENT)}`,
    );
    this.name = "UnsafePathError";
  }
}

export function assertSafeSegment(segment: string): void {
  if (!SAFE_SEGMENT.test(segment) || segment === "." || segment === "..") {
    throw new UnsafePathError(segment);
  }
}

export interface FirmwareStoreOptions {
  /** <dataDir>/fw */
  root: string;
  /** Hard ceiling in bytes; a download that would exceed it is refused. */
  maxBytes: number;
  /** Versions to keep per app, beyond those in use. */
  keepVersions: number;
  log?: (message: string) => void;
}

export class FirmwareStore {
  private readonly log: (message: string) => void;

  constructor(private readonly options: FirmwareStoreOptions) {
    this.log = options.log ?? ((): void => {});
  }

  get root(): string {
    return this.options.root;
  }

  appDir(app: AppName): string {
    assertSafeSegment(app);
    return join(this.options.root, app);
  }

  versionDir(app: AppName, version: string): string {
    assertSafeSegment(version);
    return join(this.appDir(app), version);
  }

  filePath(app: AppName, version: string, filename: string): string {
    assertSafeSegment(filename);
    return join(this.versionDir(app, version), filename);
  }

  /** Total bytes currently cached. */
  async totalBytes(): Promise<number> {
    let total = 0;
    for (const file of await this.list()) total += file.sizeBytes;
    return total;
  }

  /** Every cached firmware file. */
  async list(): Promise<CachedFile[]> {
    const files: CachedFile[] = [];
    let apps: string[];
    try {
      apps = await readdir(this.options.root);
    } catch {
      return files;
    }
    for (const app of apps) {
      if (!SAFE_SEGMENT.test(app)) continue;
      let versions: string[];
      try {
        versions = await readdir(join(this.options.root, app));
      } catch {
        continue;
      }
      for (const version of versions) {
        if (!SAFE_SEGMENT.test(version)) continue;
        const dir = join(this.options.root, app, version);
        let entries: string[];
        try {
          const s = await stat(dir);
          if (!s.isDirectory()) continue;
          entries = await readdir(dir);
        } catch {
          continue;
        }
        for (const filename of entries) {
          try {
            const s = await stat(join(dir, filename));
            if (!s.isFile()) continue;
            files.push({
              app,
              version,
              filename,
              path: join(dir, filename),
              sizeBytes: s.size,
            });
          } catch {
            // Vanished between readdir and stat; not worth reporting.
          }
        }
      }
    }
    return files;
  }

  async has(app: AppName, version: string, filename: string): Promise<boolean> {
    try {
      const s = await stat(this.filePath(app, version, filename));
      return s.isFile() && s.size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Download a firmware image into the cache, unless it is already there.
   *
   * Streams to a `.part` file and renames on success, so an interrupted
   * download can never be mistaken for a complete one. There is deliberately
   * no resume logic: for a 4 MB image, starting again is simpler than getting
   * range requests subtly wrong.
   */
  async ensure(options: FetchOptions): Promise<CachedFile> {
    const { app, version, filename } = options;
    const target = this.filePath(app, version, filename);

    if (await this.has(app, version, filename)) {
      const s = await stat(target);
      return { app, version, filename, path: target, sizeBytes: s.size };
    }

    // Budget pre-flight: refuse rather than filling a boat's SD card and
    // taking the server down with it.
    if (options.expectedBytes !== undefined) {
      const used = await this.totalBytes();
      if (used + options.expectedBytes > this.options.maxBytes) {
        throw new Error(
          `downloading ${filename} (${options.expectedBytes} bytes) would ` +
            `exceed the ${this.options.maxBytes}-byte firmware cache limit ` +
            `(${used} bytes in use) — raise the limit or remove old versions`,
        );
      }
    }

    await mkdir(this.versionDir(app, version), { recursive: true });
    const partial = `${target}.part`;
    const doFetch = options.fetchImpl ?? fetch;

    const response = await doFetch(options.url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(
        `fetching ${options.url} answered HTTP ${response.status}`,
      );
    }
    if (response.body === null) {
      throw new Error(`fetching ${options.url} returned no body`);
    }

    const declared = Number(response.headers.get("content-length"));
    const totalBytes =
      Number.isFinite(declared) && declared > 0
        ? declared
        : options.expectedBytes;

    const hash = createHash("sha256");
    let received = 0;
    const source = Readable.fromWeb(
      response.body as Parameters<typeof Readable.fromWeb>[0],
    );
    source.on("data", (chunk: Buffer) => {
      received += chunk.length;
      hash.update(chunk);
      options.onProgress?.({ receivedBytes: received, totalBytes });
    });

    try {
      await pipeline(source, createWriteStream(partial));
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }

    const digest = hash.digest("hex");
    if (options.sha256 !== undefined && options.sha256 !== digest) {
      await rm(partial, { force: true });
      throw new Error(
        `${filename} failed its checksum: expected ${options.sha256}, got ` +
          `${digest} — the download was discarded`,
      );
    }

    await rename(partial, target);
    this.log(`cached ${app} ${version} ${filename} (${received} bytes)`);
    return {
      app,
      version,
      filename,
      path: target,
      sizeBytes: received,
      sha256: digest,
    };
  }

  /** Write an application's manifest next to its versions. */
  async writeManifest(app: AppName, json: string): Promise<string> {
    const dir = this.appDir(app);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "manifest.json");
    const tmp = `${path}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, path);
    return path;
  }

  /**
   * Write a small file at the cache root, used to prove over HTTP that the
   * public mount actually serves this directory. Filesystem state alone does
   * not tell us a device can fetch anything.
   */
  async writeProbe(name: string, body: string): Promise<string> {
    // Must not be a dotfile: serve-static ignores those, so the probe would
    // 404 through the very mount it is meant to prove.
    assertSafeSegment(name);
    await mkdir(this.options.root, { recursive: true });
    const path = join(this.options.root, name);
    await writeFile(path, body, "utf8");
    return path;
  }

  async readManifest(app: AppName): Promise<string | undefined> {
    try {
      return await readFile(join(this.appDir(app), "manifest.json"), "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * Prune old versions.
   *
   * `protectedVersions` is what some device is currently running or mid-update
   * on — evicting the image a device is downloading would fail that update, so
   * those are never candidates however old they look.
   */
  async prune(
    app: AppName,
    protectedVersions: Iterable<string> = [],
  ): Promise<string[]> {
    const keep = new Set(protectedVersions);
    const files = (await this.list()).filter((f) => f.app === app);
    const versions = [...new Set(files.map((f) => f.version))];
    if (versions.length <= this.options.keepVersions) return [];

    // Newest last; drop from the front once the protected ones are excluded.
    const { compareVersions } = await import("./manifest.js");
    const ordered = versions.sort((a, b) => compareVersions(a, b));
    const droppable = ordered.filter((v) => !keep.has(v));
    const surplus = Math.max(
      0,
      ordered.length - Math.max(this.options.keepVersions, keep.size),
    );
    const removed: string[] = [];
    for (const version of droppable.slice(0, surplus)) {
      try {
        await rm(this.versionDir(app, version), {
          recursive: true,
          force: true,
        });
        removed.push(version);
        this.log(`pruned ${app} ${version} from the firmware cache`);
      } catch {
        // Leave it; the next prune will try again.
      }
    }
    return removed;
  }

  /** Remove one cached version outright. */
  async remove(app: AppName, version: string): Promise<boolean> {
    try {
      await rm(this.versionDir(app, version), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
