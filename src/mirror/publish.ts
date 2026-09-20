/**
 * Expose the firmware cache on the server's unauthenticated webapp mount.
 *
 * A package carrying the `signalk-webapp` keyword has its `public/` directory
 * served at `/<package-name>/` with no auth middleware in front of it
 * (signalk-server `src/interfaces/webapps.ts`, `mountWebModules`). That matters
 * because an espOS device fetching its manifest sends no credentials at all —
 * `espos_ota`'s fetch is a bare `esp_http_client` with no Authorization header
 * — and `/plugins/<id>/*` is admin-gated. The public mount is the only path a
 * device can reach.
 *
 * But `public/` lives inside `node_modules` and is replaced wholesale whenever
 * the plugin updates, so nothing durable can live there. The cache lives in
 * `app.getDataDirPath()` and `public/fw` is a symlink recreated at every
 * `start()`.
 *
 * Verified against signalk-server 2.32.0 with security enabled and no
 * credentials: `/signalk-espos-manager/fw/<app>/manifest.json` answers 200
 * while `/plugins/signalk-espos-manager/api/fleet` answers 401.
 */

import { lstat, mkdir, readlink, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type MirrorMode = "mirror" | "upstream";

export interface PublishResult {
  mode: MirrorMode;
  /** The public path firmware is served from, when mirroring. */
  publicPath?: string;
  /** Why we fell back, when we did. */
  reason?: string;
}

export interface EnsureMountOptions {
  /** Where the durable cache lives (app.getDataDirPath()). */
  dataDir: string;
  /** Overridable for tests; defaults to this package's own public/ dir. */
  publicDir?: string;
  /** Probe callback: given a relative path under the mount, is it served? */
  probe?: (relativePath: string) => Promise<boolean>;
  log?: (message: string) => void;
}

/** This package's installed `public/` directory. */
export function defaultPublicDir(): string {
  // dist/mirror/publish.js -> ../../public
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
}

/**
 * Create (or repair) the `public/fw -> <dataDir>/fw` symlink.
 *
 * Idempotent, and deliberately conservative: a real directory sitting where
 * the link belongs is left alone rather than deleted, because that is either
 * someone else's data or a sign this is not the layout we think it is.
 */
export async function ensureFirmwareLink(
  options: EnsureMountOptions,
): Promise<PublishResult> {
  const publicDir = options.publicDir ?? defaultPublicDir();
  const cacheDir = join(options.dataDir, "fw");
  const linkPath = join(publicDir, "fw");
  const log = options.log ?? ((): void => {});

  try {
    await mkdir(cacheDir, { recursive: true });
  } catch (error) {
    return {
      mode: "upstream",
      reason: `cannot create the firmware cache at ${cacheDir}: ${message(error)}`,
    };
  }

  try {
    await mkdir(publicDir, { recursive: true });
  } catch (error) {
    return {
      mode: "upstream",
      reason: `cannot write to the plugin's public directory: ${message(error)}`,
    };
  }

  try {
    const stats = await lstat(linkPath);
    if (stats.isSymbolicLink()) {
      const current = await readlink(linkPath);
      if (resolve(publicDir, current) === resolve(cacheDir)) {
        log(`firmware mount already points at ${cacheDir}`);
      } else {
        await unlink(linkPath);
        await symlink(cacheDir, linkPath);
        log(`repointed the firmware mount at ${cacheDir}`);
      }
    } else if (stats.isDirectory()) {
      // Not ours to remove. Say so plainly instead of destroying data.
      return {
        mode: "upstream",
        reason:
          `${linkPath} is a real directory, not the expected symlink — ` +
          `refusing to replace it`,
      };
    } else {
      await unlink(linkPath);
      await symlink(cacheDir, linkPath);
      log(`replaced a stray file at ${linkPath} with the firmware mount`);
    }
  } catch (error) {
    if (isNotFound(error)) {
      try {
        await symlink(cacheDir, linkPath);
        log(`created the firmware mount at ${linkPath}`);
      } catch (linkError) {
        // Windows without developer mode, or a filesystem with no symlinks.
        return {
          mode: "upstream",
          reason: `cannot create a symlink at ${linkPath}: ${message(linkError)}`,
        };
      }
    } else {
      return { mode: "upstream", reason: message(error) };
    }
  }

  return { mode: "mirror", publicPath: linkPath };
}

/**
 * Confirm the mount is actually served over HTTP, not merely present on disk.
 *
 * This is the check that matters: a correct symlink still fails if the
 * `signalk-webapp` keyword is missing, if the server mounted the package
 * before the link existed, or if something in front of the server rewrites the
 * path. Filesystem state is not evidence that a device can fetch the file.
 */
export async function verifyMountServed(
  probe: (relativePath: string) => Promise<boolean>,
  probeFile: string,
): Promise<PublishResult> {
  try {
    const ok = await probe(probeFile);
    return ok
      ? { mode: "mirror" }
      : {
          mode: "upstream",
          reason:
            "the firmware path is not reachable over HTTP, so devices " +
            "cannot fetch from this server",
        };
  } catch (error) {
    return { mode: "upstream", reason: message(error) };
  }
}

/** Remove the symlink, for a clean stop or an uninstall. */
export async function removeFirmwareLink(publicDir?: string): Promise<void> {
  const linkPath = join(publicDir ?? defaultPublicDir(), "fw");
  try {
    const stats = await lstat(linkPath);
    // Only ever remove a symlink — never recurse into real data.
    if (stats.isSymbolicLink()) await rm(linkPath);
  } catch {
    // Nothing there; nothing to do.
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
