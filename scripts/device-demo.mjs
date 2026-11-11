/**
 * public/device-demo/: espOS's demo build of the device web UI, which the
 * arrow next to a demo device opens (espOS docs/ui.md, "Demo build").
 *
 * The bundle is an espOS release asset, pinned in package.json under
 * `espos.uiDemo` by version and SHA-256, so a build gets exactly the bytes
 * that were reviewed. `ESPOS_UI_DEMO_DIR` copies a local `ui/dist-demo`
 * instead, for trying an espOS change. With neither, a placeholder page says
 * the demo is not in this build: the plugin works without it, only the demo
 * arrow has nothing to show. An offline build outside CI falls back to that
 * placeholder too, so working on the plugin never needs GitHub; in CI, where
 * the published package is built, a failed download fails the build.
 *
 * It reports on stderr: `npm pack --json` runs the build through `prepare`,
 * and anything on stdout would break the JSON it prints.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "public", "device-demo");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pin = pkg.espos?.uiDemo;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const local = process.env.ESPOS_UI_DEMO_DIR;
if (local !== undefined && local !== "") {
  cpSync(local, out, { recursive: true });
  console.error(`device-demo: copied ${local}`);
} else if (pin == null) {
  placeholder("none pinned");
} else {
  const { version, sha256 } = pin;
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("device-demo: espos.uiDemo needs a version and a sha256");
  }
  const name = `espos-ui-demo-${version}.tar.gz`;
  const url = `https://github.com/signalk-espOS/espOS/releases/download/v${version}/${name}`;
  let bytes;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (process.env.CI) throw new Error(`device-demo: ${url}: ${error}`);
    placeholder(`${url} unreachable (${error})`);
    process.exit(0);
  }
  // A download that arrives but differs is never replaced by a placeholder:
  // it is not an offline build, it is the wrong bytes.
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha256) {
    throw new Error(`device-demo: ${name} has sha256 ${got}, pinned ${sha256}`);
  }
  const archive = join(tmpdir(), `${name}.${process.pid}`);
  writeFileSync(archive, bytes);
  try {
    execFileSync("tar", ["-xzf", archive, "-C", out]);
  } finally {
    rmSync(archive, { force: true });
  }
  console.error(`device-demo: espOS ${version}`);
}

function placeholder(why) {
  writeFileSync(
    join(out, "index.html"),
    "<!doctype html><meta charset=utf-8><title>espOS</title>" +
      "<p>The device demo is not part of this build.</p>\n",
  );
  console.error(`device-demo: ${why}, placeholder written`);
}
