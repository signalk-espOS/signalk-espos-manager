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

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOOTLOADER_FLASH_OFFSET,
  CHIP_NAME_TO_TARGET,
  FLASH_SIZE_BY_ID,
  targetFromChipName,
  isFlashId,
  SPI_REG_BASE_FIXUP,
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

/**
 * The chip name we look up must be the one the library actually gives us.
 *
 * Live failure on Windows, 2026-09-23: the page showed "Connected to ESP32-C5
 * (revision v1.0)" and, two lines below, "Could not work out which chip this
 * is". `loader.main()` returns getChipDescription() — name PLUS revision — not
 * the bare CHIP_NAME our table keys on, so the lookup missed for every modern
 * chip and the wrong-chip gate never fired. A board was offered an esp32 image
 * while an ESP32-C5 was attached.
 */
describe("chip identity", () => {
  it("does not resolve a description carrying a revision", () => {
    // The shape main() returns. Asserting the bug's mechanism so the fix
    // cannot quietly regress to reading main()'s value again.
    expect(targetFromChipName("ESP32-C5 (revision v1.0)")).toBeUndefined();
  });

  it("resolves every CHIP_NAME the installed library defines", async () => {
    const dir = new URL(
      "../node_modules/esptool-js/lib/targets/",
      import.meta.url,
    );
    const names: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.startsWith("esp32") || !file.endsWith(".js")) continue;
      const source = readFileSync(new URL(file, dir), "utf8");
      const m = /CHIP_NAME = "([^"]+)"/.exec(source);
      if (m?.[1] !== undefined) names.push(m[1]);
    }
    expect(names.length).toBeGreaterThan(8);

    for (const name of names) {
      expect(
        targetFromChipName(name),
        `${name} is not in CHIP_NAME_TO_TARGET`,
      ).toBeDefined();
    }
  });
});

/**
 * 0x000000 and 0xffffff are not flash ids.
 *
 * They are what the SPI read returns when the flash chip did not answer, and
 * esptool-js's own main() warns on exactly these two values ("Failed to
 * communicate with the flash chip"). Measured on a Waveshare ESP32-C5 in
 * Chrome: the browser read 0x000000 while `esptool flash-id` over USB on the
 * same board read 0x184046 (16 MB). Treating the sentinel as an id turns a
 * failed read into "this chip is not one we recognise", which sends someone
 * looking at their hardware instead of at the read.
 */
describe("isFlashId", () => {
  it("rejects both sentinels the library itself warns about", () => {
    expect(isFlashId(0x000000)).toBe(false);
    expect(isFlashId(0xffffff)).toBe(false);
  });

  it("accepts the id this board really has", () => {
    expect(isFlashId(0x184046)).toBe(true);
  });

  it("matches the values esploader.js warns on", () => {
    const source = readFileSync(
      new URL("../node_modules/esptool-js/lib/esploader.js", import.meta.url),
      "utf8",
    );
    // The guard we are mirroring, so a library change is caught here.
    expect(source).toMatch(/flashId === 0xffffff \|\| flashId === 0x000000/);
  });
});

/**
 * esptool-js has the wrong SPI flash controller address for the C5/C6.
 *
 * The flash controller is SPI1. esptool-js's ESP32C6ROM sets
 * SPI_REG_BASE = 0x60002000 (SPI0) and never applies the override Python
 * esptool does (0x60003000); ESP32C5ROM extends ESP32C6ROM in both, so the C5
 * inherits it. readFlashId() then reads a register block that is not the flash
 * controller and answers 0x000000, the flash size falls back to "4MB", and
 * correct firmware looks too big for the board.
 *
 * These tests exist to make the workaround self-retiring: when the installed
 * esptool-js carries the right value, the first one fails and the fixup entry
 * should be deleted rather than left to shadow a fixed library.
 */
describe("SPI_REG_BASE_FIXUP", () => {
  const spiBase = (target: string): string | undefined => {
    const source = readFileSync(
      new URL(
        `../node_modules/esptool-js/lib/targets/${target}.js`,
        import.meta.url,
      ),
      "utf8",
    );
    return /SPI_REG_BASE = (0x[0-9a-f]+)/.exec(source)?.[1];
  };

  it("is still needed: the library still has SPI0 for the c6", () => {
    // 0x60003000 here means upstream fixed it -> drop the fixup entries.
    expect(spiBase("esp32c6")).toBe("0x60002000");
  });

  it("does not patch a chip the library gets right", () => {
    // The C3 genuinely is 0x60002000 in both tools, so it must not be listed.
    expect(spiBase("esp32c3")).toBe("0x60002000");
    expect(SPI_REG_BASE_FIXUP.esp32c3).toBeUndefined();
  });

  it("patches the c5 and c6 to the flash controller", () => {
    expect(SPI_REG_BASE_FIXUP.esp32c5).toBe(0x60003000);
    expect(SPI_REG_BASE_FIXUP.esp32c6).toBe(0x60003000);
  });

  it("covers the c5 by its own entry, not by inheritance", () => {
    // The C5 class declares no SPI_REG_BASE of its own, so nothing would fix
    // it if only the C6 were listed -- our fixup is applied per resolved
    // target, not per class hierarchy.
    expect(spiBase("esp32c5")).toBeUndefined();
    expect(SPI_REG_BASE_FIXUP.esp32c5).toBeDefined();
  });
});
