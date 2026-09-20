/**
 * Fetch and cache the registry index.
 *
 * A boat is offline more often than not, and a store that empties itself the
 * moment the connection drops is useless exactly when someone is trying to fix
 * something. So the last good copy is kept on disk and served with a `stale`
 * flag; only a completely absent cache produces "unavailable".
 *
 * One conditional request per refresh, from raw.githubusercontent.com, with no
 * token and no API rate limit — the registry's own CI pre-resolves each
 * project's releases into the index so the plugin never calls the GitHub API.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeIndexes } from "./resolve.js";
import type { RegistryIndex, RegistryProject } from "./types.js";

export interface RegistryClientOptions {
  /** Where to cache; usually <dataDir>/cache. */
  cacheDir: string;
  indexUrl: string;
  extraIndexUrls?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  now?: () => number;
}

export interface IndexResult {
  index: RegistryIndex;
  /** True when this came from cache after a failed or skipped refresh. */
  stale: boolean;
  fetchedAt?: number;
  /** Why the live fetch did not happen or did not work. */
  reason?: string;
  warnings: string[];
}

interface CacheEntry {
  url: string;
  etag?: string;
  fetchedAt: number;
  body: string;
}

const EMPTY: RegistryIndex = { schema: 1, projects: [] };

/** Validate enough of an index to trust it; unknown fields are ignored. */
export function parseIndex(raw: unknown): RegistryIndex {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("the registry index is not an object");
  }
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.projects)) {
    throw new Error("the registry index has no projects array");
  }
  const projects: RegistryProject[] = [];
  for (const entry of body.projects) {
    if (typeof entry !== "object" || entry === null) continue;
    const project = entry as Record<string, unknown>;
    const id = project.id;
    const app = project.app;
    const repo = project.repo;
    const name = project.name;
    // id, app and targets are load-bearing: without them an entry can neither
    // be matched to a device nor mirrored. Skip rather than fail the whole
    // index, so one bad third-party entry cannot empty the store.
    if (
      typeof id !== "string" ||
      typeof app !== "string" ||
      !Array.isArray(project.targets)
    ) {
      continue;
    }
    projects.push({
      ...(project as unknown as RegistryProject),
      id,
      app,
      name: typeof name === "string" ? name : id,
      repo: typeof repo === "string" ? repo : "",
      targets: project.targets.filter(
        (t): t is string => typeof t === "string",
      ),
    });
  }
  return {
    schema: 1,
    updated: typeof body.updated === "string" ? body.updated : undefined,
    projects,
  };
}

export class RegistryClient {
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RegistryClientOptions) {
    this.log = options.log ?? ((): void => {});
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private cachePath(url: string): string {
    // One cache file per URL, named from a hash so any URL is filesystem-safe.
    let hash = 0;
    for (let i = 0; i < url.length; i += 1) {
      hash = (hash * 31 + url.charCodeAt(i)) | 0;
    }
    return join(
      this.options.cacheDir,
      `registry-${(hash >>> 0).toString(16)}.json`,
    );
  }

  private async readCache(url: string): Promise<CacheEntry | undefined> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(this.cachePath(url), "utf8"),
      );
      if (
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as CacheEntry).body === "string"
      ) {
        return raw as CacheEntry;
      }
    } catch {
      // No cache yet, or unreadable.
    }
    return undefined;
  }

  private async writeCache(entry: CacheEntry): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true });
    const path = this.cachePath(entry.url);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), "utf8");
    await rename(tmp, path);
  }

  /** Fetch one index URL, falling back to its cache. */
  private async fetchOne(
    url: string,
    maxAgeMs: number,
    force: boolean,
  ): Promise<{
    index: RegistryIndex;
    stale: boolean;
    fetchedAt?: number;
    reason?: string;
  }> {
    const cached = await this.readCache(url);
    const fresh =
      cached !== undefined && this.now() - cached.fetchedAt < maxAgeMs;
    if (fresh && !force) {
      return {
        index: parseIndex(JSON.parse(cached.body)),
        stale: false,
        fetchedAt: cached.fetchedAt,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs ?? 15_000);
    try {
      const headers: Record<string, string> = {};
      if (cached?.etag !== undefined) headers["if-none-match"] = cached.etag;
      const response = await this.fetchImpl(url, {
        headers,
        signal: controller.signal,
      });

      if (response.status === 304 && cached !== undefined) {
        // Unchanged: refresh the timestamp so we do not re-ask immediately.
        await this.writeCache({ ...cached, fetchedAt: this.now() });
        return {
          index: parseIndex(JSON.parse(cached.body)),
          stale: false,
          fetchedAt: this.now(),
        };
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.text();
      const index = parseIndex(JSON.parse(body));
      await this.writeCache({
        url,
        etag: response.headers.get("etag") ?? undefined,
        fetchedAt: this.now(),
        body,
      });
      this.log(`registry ${url}: ${index.projects.length} project(s)`);
      return { index, stale: false, fetchedAt: this.now() };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (cached !== undefined) {
        // The whole point: a store that still works at anchor.
        this.log(`registry ${url} unreachable (${reason}); using the cache`);
        try {
          return {
            index: parseIndex(JSON.parse(cached.body)),
            stale: true,
            fetchedAt: cached.fetchedAt,
            reason,
          };
        } catch {
          // Cache is corrupt as well; fall through to empty.
        }
      }
      return { index: EMPTY, stale: true, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The merged registry. Never throws: an unreachable registry is a degraded
   * state that still serves whatever was cached.
   */
  async getIndex(
    options: { maxAgeMs?: number; force?: boolean } = {},
  ): Promise<IndexResult> {
    const maxAgeMs = options.maxAgeMs ?? 12 * 3600 * 1000;
    const urls = [
      this.options.indexUrl,
      ...(this.options.extraIndexUrls ?? []),
    ];
    const sources: { url: string; index: RegistryIndex }[] = [];
    const warnings: string[] = [];
    let stale = false;
    let fetchedAt: number | undefined;
    let reason: string | undefined;

    for (const url of urls) {
      const result = await this.fetchOne(url, maxAgeMs, options.force ?? false);
      sources.push({ url, index: result.index });
      if (result.stale) {
        stale = true;
        if (reason === undefined) reason = result.reason;
      }
      if (
        result.fetchedAt !== undefined &&
        (fetchedAt === undefined || result.fetchedAt < fetchedAt)
      ) {
        fetchedAt = result.fetchedAt;
      }
      if (result.index.projects.length === 0 && result.reason !== undefined) {
        warnings.push(`${url}: ${result.reason}`);
      }
    }

    const merged = mergeIndexes(sources);
    // Record which index each project came from, so the UI can show provenance.
    for (const source of sources) {
      for (const project of source.index.projects) {
        const kept = merged.index.projects.find((p) => p.id === project.id);
        if (kept !== undefined && kept === project) {
          (kept as RegistryProject & { sourceUrl?: string }).sourceUrl =
            source.url;
        }
      }
    }

    return {
      index: merged.index,
      stale,
      fetchedAt,
      reason,
      warnings: [...warnings, ...merged.warnings],
    };
  }
}
