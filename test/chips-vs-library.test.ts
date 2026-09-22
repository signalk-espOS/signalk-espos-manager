/**
 * The chip table in web/src/flash/chips.ts is transcribed from esptool-js.
 * A hand-copied table is exactly where a typo hides, and a wrong offset or
 * chip name would let the wrong image reach a board — so this checks the
 * transcription against the installed library rather than trusting it.
 *
 * It reads the library's source instead of importing it: esptool-js 0.6.1
 * ships extensionless internal imports, which Node's ESM resolver rejects
 * (Vite rewrites them when bundling, so the app itself is unaffected).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOOTLOADER_FLASH_OFFSET,
  CHIP_NAME_TO_TARGET,
  FLASH_SIZE_BY_ID,
} from "../web/src/flash/chips.js";

const TARGETS = Object.values(CHIP_NAME_TO_TARGET).filter(
  (t) => t !== "esp8266",
);

/** Follow `extends` until a target declares its own offset. */
function resolveOffset(target: string, seen = new Set<string>()): number {
  if (seen.has(target)) return 0;
  seen.add(target);
  const src = readFileSync(
    new URL(
      `../node_modules/esptool-js/lib/targets/${target}.js`,
      import.meta.url,
    ),
    "utf8",
  );
  const own = /BOOTLOADER_FLASH_OFFSET = (0x[0-9a-fA-F]+|0)\b/.exec(src);
  if (own?.[1] !== undefined) return Number(own[1]);
  const parent = /extends (\w+)ROM/.exec(src);
  if (parent?.[1] === undefined) return 0;
  return resolveOffset(parent[1].toLowerCase(), seen);
}

function chipName(target: string): string | undefined {
  const src = readFileSync(
    new URL(
      `../node_modules/esptool-js/lib/targets/${target}.js`,
      import.meta.url,
    ),
    "utf8",
  );
  return /CHIP_NAME = "([^"]+)"/.exec(src)?.[1];
}

describe("the chip table matches esptool-js", () => {
  it.each(TARGETS)("%s has the offset the library resolves to", (target) => {
    expect(BOOTLOADER_FLASH_OFFSET[target]).toBe(resolveOffset(target));
  });

  it.each(TARGETS)("%s maps from the name the library reports", (target) => {
    const name = chipName(target);
    expect(name, `${target} should declare a CHIP_NAME`).toBeDefined();
    if (name !== undefined) {
      expect(CHIP_NAME_TO_TARGET[name]).toBe(target);
    }
  });
});

describe("the writeFlash contract we depend on", () => {
  it("still takes Uint8Array, not a binary string", () => {
    // Tutorials predating esptool-js 0.5 show a binary string, and passing
    // one now corrupts every image: padTo() and pako's deflate() both expect
    // bytes, and _updateImageFlashParams indexes image[2] numerically. If a
    // future version changes this, fail here rather than on a user's board.
    const dts = readFileSync(
      new URL(
        "../node_modules/esptool-js/lib/types/flashOptions.d.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(dts).toMatch(/fileArray:\s*\{\s*data:\s*Uint8Array/);
  });

  it("still skips image rewriting when all flash params are kept", () => {
    // The guard that protects a signed image from having bytes 2-3 rewritten
    // and its appended SHA-256 recomputed.
    const src = readFileSync(
      new URL("../node_modules/esptool-js/lib/esploader.js", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(
      /flashSize === "keep" && flashMode === "keep" && flashFreq === "keep"/,
    );
  });
});

describe("the loader methods we call actually exist", () => {
  // A method name invented from memory typechecks fine behind a hand-written
  // interface and fails only on hardware — and here it would have failed
  // inside a catch, silently disabling the check that stops a 16 MB image
  // reaching a 4 MB board. `getFlashSize` was exactly that mistake.
  const dts = readFileSync(
    new URL("../node_modules/esptool-js/lib/esploader.d.ts", import.meta.url),
    "utf8",
  );

  it.each([
    "main(",
    "detectFlashSize(",
    "flashSizeBytes(",
    "writeFlash(",
    "after(",
  ])("ESPLoader declares %s", (member) => {
    expect(dts).toContain(member);
  });

  it("does not declare getFlashSize, which was invented", () => {
    expect(dts).not.toContain("getFlashSize");
  });

  it("detectFlashSize returns a string, not a byte count", () => {
    // Returning the string straight into a byte comparison would make every
    // fit check nonsense.
    expect(dts).toMatch(/detectFlashSize\(\):\s*Promise<string>/);
  });
});

/**
 * Our JEDEC size table must match esptool-js's own.
 *
 * It is a transcription, and a transcription that drifts would mis-size a
 * board silently. Read from the installed package so an upgrade that changes
 * the table fails here rather than on someone's desk.
 */
describe("FLASH_SIZE_BY_ID vs the installed esptool-js", () => {
  it("agrees with DETECTED_FLASH_SIZES entry for entry", () => {
    const source = readFileSync(
      new URL("../node_modules/esptool-js/lib/esploader.js", import.meta.url),
      "utf8",
    );
    const block = /DETECTED_FLASH_SIZES\s*=\s*\{([\s\S]*?)\}/.exec(source);
    expect(block, "could not find DETECTED_FLASH_SIZES").not.toBeNull();

    const theirs = new Map<number, number>();
    for (const match of (block?.[1] ?? "").matchAll(
      /(0x[0-9a-f]+)\s*:\s*"(\d+)(KB|MB)"/gi,
    )) {
      const [, id, size, unit] = match;
      if (id === undefined || size === undefined || unit === undefined) {
        continue;
      }
      theirs.set(
        Number(id),
        Number(size) * (unit.toUpperCase() === "MB" ? 1024 * 1024 : 1024),
      );
    }
    expect(theirs.size).toBeGreaterThan(10);

    for (const [id, bytes] of theirs) {
      expect(FLASH_SIZE_BY_ID[id], `id 0x${id.toString(16)} disagrees`).toBe(
        bytes,
      );
    }
  });
});
