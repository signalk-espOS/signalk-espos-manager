/**
 * Flasher pre-flight tests.
 *
 * These rules decide whether hardware gets the wrong image, so they are pure
 * and tested without hardware. The chip facts they rest on were read out of
 * esptool-js 0.6.1's own source and inheritance chain, not assumed — see
 * web/src/flash/chips.ts.
 */

import { describe, expect, it } from "vitest";
import {
  BOOTLOADER_FLASH_OFFSET,
  CHIP_NAME_TO_TARGET,
  ESP_IMAGE_MAGIC,
  targetFromChipName,
} from "../web/src/flash/chips.js";
import {
  checkBoard,
  checkChip,
  checkFit,
  checkImage,
  preflight,
  SAFE_FLASH_PARAMS,
  type PreflightInput,
} from "../web/src/flash/preflight.js";

function input(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    detectedTarget: "esp32p4",
    buildTarget: "esp32p4",
    detectedFlashBytes: 16 * 1024 * 1024,
    imageBytes: 15_036_742,
    writeAddress: 0,
    ...over,
  };
}

/** A believable merged image: magic byte at the chip's bootloader offset. */
function mergedImage(target: keyof typeof BOOTLOADER_FLASH_OFFSET): Uint8Array {
  const head = new Uint8Array(0x10000);
  head[BOOTLOADER_FLASH_OFFSET[target]] = ESP_IMAGE_MAGIC;
  return head;
}

describe("chip facts", () => {
  it("maps the names esptool-js actually reports", () => {
    // Exact strings; a mismatch lets a P4 image reach a C6.
    expect(targetFromChipName("ESP32-P4")).toBe("esp32p4");
    expect(targetFromChipName("ESP32-C6")).toBe("esp32c6");
    expect(targetFromChipName("ESP32-S3")).toBe("esp32s3");
    expect(targetFromChipName("ESP32")).toBe("esp32");
    expect(targetFromChipName("ESP32-P4 (beta)")).toBeUndefined();
  });

  it("covers every target the library ships", () => {
    for (const target of Object.values(CHIP_NAME_TO_TARGET)) {
      expect(
        BOOTLOADER_FLASH_OFFSET[target],
        `${target} needs a bootloader offset`,
      ).toBeTypeOf("number");
    }
  });

  it("records the offsets that differ from the common case", () => {
    // Resolved through the inheritance chain: esp32c6.js sets 0 while
    // extending ESP32C3ROM, esp32c5.js sets 0x2000 while extending
    // ESP32C6ROM, and esp32c61.js declares none at all.
    expect(BOOTLOADER_FLASH_OFFSET.esp32p4).toBe(0x2000);
    expect(BOOTLOADER_FLASH_OFFSET.esp32c5).toBe(0x2000);
    expect(BOOTLOADER_FLASH_OFFSET.esp32).toBe(0x1000);
    expect(BOOTLOADER_FLASH_OFFSET.esp32s2).toBe(0x1000);
    expect(BOOTLOADER_FLASH_OFFSET.esp32s3).toBe(0x0);
    expect(BOOTLOADER_FLASH_OFFSET.esp32c6).toBe(0x0);
  });
});

describe("flash parameters", () => {
  it("keeps all three, because a signed image must not be rewritten", () => {
    // _updateImageFlashParams() rewrites bytes 2-3 and recomputes the
    // appended SHA-256 unless every one of these is "keep". Its early return
    // only fires when the write address differs from the bootloader offset,
    // and six of ten chips have that at 0x0 — exactly where a merged image
    // goes. Changing any of these corrupts signed firmware on most boards.
    expect(SAFE_FLASH_PARAMS.flashMode).toBe("keep");
    expect(SAFE_FLASH_PARAMS.flashFreq).toBe("keep");
    expect(SAFE_FLASH_PARAMS.flashSize).toBe("keep");
  });
});

describe("checkChip", () => {
  it("passes when the chip matches", () => {
    expect(checkChip(input()).ok).toBe(true);
  });

  it("refuses a P4 image on a C6, in words a person can act on", () => {
    const result = checkChip(input({ detectedTarget: "esp32c6" }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ESP32-C6");
    expect(result.message).toContain("ESP32-P4");
  });

  it("refuses when the chip could not be identified", () => {
    expect(checkChip(input({ detectedTarget: undefined })).ok).toBe(false);
  });
});

describe("checkFit", () => {
  it("passes when the image fits", () => {
    expect(checkFit(input()).ok).toBe(true);
  });

  it("refuses a 16 MB image on a 4 MB board", () => {
    // esptool-js skips its own fit check when flashSize is "keep", which we
    // must pass, so this check is not redundant.
    const result = checkFit(
      input({ detectedFlashBytes: 4 * 1024 * 1024, imageBytes: 15_036_742 }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/14\.3 MB.*4\.0 MB/);
  });

  it("allows the write when the flash size is unknown", () => {
    expect(checkFit(input({ detectedFlashBytes: undefined })).ok).toBe(true);
  });
});

describe("checkImage", () => {
  it("accepts a merged image for a chip whose bootloader is at 0x2000", () => {
    const result = checkImage(
      input({ buildTarget: "esp32p4", imageHead: mergedImage("esp32p4") }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a merged image for a chip whose bootloader is at 0x0", () => {
    const result = checkImage(
      input({
        buildTarget: "esp32s3",
        detectedTarget: "esp32s3",
        imageHead: mergedImage("esp32s3"),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("catches an update image written where a full image belongs", () => {
    // The commonest publishing mistake, and it leaves an unbootable board.
    const ota = new Uint8Array(0x10000);
    ota[0] = ESP_IMAGE_MAGIC; // application header at the start, nothing at 0x2000
    const result = checkImage(
      input({ buildTarget: "esp32p4", imageHead: ota }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/update image, not a full-flash image/);
  });

  it("rejects a file that is not firmware at all", () => {
    const junk = new Uint8Array(0x10000);
    junk.fill(0x41);
    expect(checkImage(input({ imageHead: junk })).ok).toBe(false);
  });

  it("does not judge when it has not seen the image", () => {
    expect(checkImage(input({ imageHead: undefined })).ok).toBe(true);
  });
});

describe("checkBoard", () => {
  const boards = [
    { id: "waveshare-7b", name: "Waveshare 7B" },
    { id: "waveshare-x", name: "Waveshare X" },
  ];

  it("is satisfied when the build names its board", () => {
    expect(
      checkBoard(input({ candidateBoards: boards, buildBoard: "Waveshare 7B" }))
        .ok,
    ).toBe(true);
  });

  it("is satisfied when only one board uses the chip", () => {
    expect(checkBoard(input({ candidateBoards: [boards[0]!] })).ok).toBe(true);
  });

  it("asks the user when two incompatible boards share a chip", () => {
    // espOS matches an update on chip alone, so it cannot tell these apart —
    // and the wrong one is a black screen that reads as a hardware fault.
    const result = checkBoard(input({ candidateBoards: boards }));
    expect(result.ok).toBe(false);
    expect(result.needsChoice).toBe(true);
    expect(result.message).toMatch(/screen black/);
  });

  it("accepts a board the user picked", () => {
    const result = checkBoard(
      input({ candidateBoards: boards, chosenBoard: "waveshare-x" }),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Waveshare X");
  });

  it("refuses a board the firmware does not support", () => {
    expect(
      checkBoard(input({ candidateBoards: boards, chosenBoard: "some-other" }))
        .ok,
    ).toBe(false);
  });
});

describe("preflight", () => {
  it("allows a write only when every check passes", () => {
    const report = preflight(input({ imageHead: mergedImage("esp32p4") }));
    expect(report.canWrite).toBe(true);
    expect(report.checks).toHaveLength(4);
  });

  it("blocks and explains when the chip is wrong", () => {
    const report = preflight(
      input({ detectedTarget: "esp32c6", imageHead: mergedImage("esp32p4") }),
    );
    expect(report.canWrite).toBe(false);
    expect(report.needsChoice).toBe(false);
    expect(report.checks.find((c) => c.id === "chip")?.ok).toBe(false);
  });

  it("distinguishes a blocked write from one needing a choice", () => {
    const report = preflight(
      input({
        imageHead: mergedImage("esp32p4"),
        candidateBoards: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ],
      }),
    );
    expect(report.canWrite).toBe(false);
    // The user can unblock this themselves; a wrong chip they cannot.
    expect(report.needsChoice).toBe(true);
  });
});

describe("where the flasher can run", () => {
  // Verified in Chromium against a real server on 2026-09-21:
  //
  //   http://localhost:3100      -> isSecureContext true,  serial present
  //   http://192.168.0.148:3100  -> isSecureContext false, serial absent
  //
  // localhost is a trustworthy origin per the secure-context spec, so the
  // flasher genuinely works there. The boat case is the LAN address, where it
  // genuinely cannot — and that is the case the hosted copy exists for. Both
  // behaviours are correct; the page must not treat either as an error.
  it("documents that localhost is a secure context but a LAN IP is not", () => {
    const secureContexts = ["localhost", "127.0.0.1"];
    const insecureContexts = ["192.168.0.148", "10.0.0.5", "boat.local"];
    // Encoded as data rather than logic: the browser decides this, not us.
    // The test exists so the distinction is written down where someone
    // debugging "why is there no flash button" will find it.
    expect(secureContexts).toContain("localhost");
    expect(insecureContexts).not.toContain("localhost");
  });
});
