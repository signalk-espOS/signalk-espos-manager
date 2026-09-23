/**
 * The checks that run before a single byte is written.
 *
 * Pure functions, so the rules that decide whether hardware gets a wrong image
 * can be tested without hardware. Each one exists because of a specific way a
 * flash goes wrong:
 *
 * - wrong chip: the device rejects the image, but only after the whole
 *   transfer, and a merged image is 15 MB;
 * - too big for the flash: esptool-js normally refuses this itself, but its
 *   guard runs only when `flashSize !== "keep"`, and we must pass "keep" to
 *   avoid mutating a signed image — so the check becomes ours;
 * - wrong file: an OTA image written where a merged image belongs leaves an
 *   unbootable board, and the two are told apart by a single magic byte;
 * - wrong board variant: two panels behind one target, and the wrong one is a
 *   black screen that reads as a hardware fault.
 */

import {
  BOOTLOADER_FLASH_OFFSET,
  ESP_IMAGE_MAGIC,
  chipNameForTarget,
} from "./chips.js";
import type { Target } from "./types.js";

export type CheckId = "chip" | "fit" | "image" | "board";

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** Written for the person holding the board, not for a log. */
  message: string;
  /** True when the user can proceed by making a choice (board ambiguity). */
  needsChoice?: boolean;
}

export interface PreflightInput {
  /** What the connected chip reports. */
  detectedTarget?: Target;
  /** What the chosen build is for. */
  buildTarget: Target;
  /**
   * False when `detectedFlashBytes` is a fallback rather than a reading.
   *
   * Undefined means "not stated", treated as detected, so existing callers
   * and tests keep their behaviour.
   */
  flashSizeDetected?: boolean;
  /** Flash size the chip reports, in bytes. */
  detectedFlashBytes?: number;
  /** The image about to be written. */
  imageBytes: number;
  /** First 64 KiB is enough to check the header. */
  imageHead?: Uint8Array;
  /** Address the image will be written at; merged images go to 0. */
  writeAddress: number;
  /** Boards the project declares for this target. */
  candidateBoards?: { id: string; name: string }[];
  /** The board the user picked, when they had to. */
  chosenBoard?: string;
  /** The board this build was made for, when the build says. */
  buildBoard?: string;
}

/** Does the connected chip match the build? */
export function checkChip(input: PreflightInput): CheckResult {
  if (input.detectedTarget === undefined) {
    return {
      id: "chip",
      ok: false,
      message: "Could not work out which chip this is. Try reconnecting.",
    };
  }
  if (input.detectedTarget !== input.buildTarget) {
    return {
      id: "chip",
      ok: false,
      message:
        `This board is an ${chipNameForTarget(input.detectedTarget)}, but the ` +
        `firmware you picked is for an ${chipNameForTarget(input.buildTarget)}.`,
    };
  }
  return {
    id: "chip",
    ok: true,
    message: `${chipNameForTarget(input.detectedTarget)} detected.`,
  };
}

/**
 * Will the image fit?
 *
 * esptool-js's own fit check is skipped when `flashSize` is "keep", which it
 * must be for a signed image, so this check is not redundant.
 */
export function checkFit(input: PreflightInput): CheckResult {
  if (input.detectedFlashBytes === undefined) {
    return {
      id: "fit",
      ok: true,
      message: "Flash size unknown — writing anyway.",
    };
  }
  const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;

  if (input.imageBytes > input.detectedFlashBytes) {
    // An ASSUMED size must not block a write. esptool-js falls back to "4MB"
    // when it cannot decode the flash id, and a fallback that is too small
    // makes correct firmware look too big -- which is how a 16 MB Waveshare
    // C5 was refused a 5.9 MB image it had ample room for. Say what is known
    // and let the user decide; a genuinely too-large image fails the write
    // safely, while a false refusal leaves them with no way forward at all.
    if (input.flashSizeDetected === false) {
      return {
        id: "fit",
        ok: true,
        message:
          `The firmware is ${mb(input.imageBytes)} and this board's flash ` +
          `size could not be read — assuming ${mb(input.detectedFlashBytes)}, ` +
          `which would be too small. If the board's specification says it has ` +
          `room, this is safe to write: the size was guessed, not measured.`,
      };
    }
    return {
      id: "fit",
      ok: false,
      message:
        `The firmware is ${mb(input.imageBytes)} but this board has only ` +
        `${mb(input.detectedFlashBytes)} of flash.`,
    };
  }

  if (input.flashSizeDetected === false) {
    return {
      id: "fit",
      ok: true,
      message:
        `Fits in an assumed ${mb(input.detectedFlashBytes)} — this board's ` +
        `flash size could not be read.`,
    };
  }
  return {
    id: "fit",
    ok: true,
    message: `Fits in ${(input.detectedFlashBytes / (1024 * 1024)).toFixed(0)} MB of flash.`,
  };
}

/**
 * Is this actually a full-flash image?
 *
 * A merged image carries the bootloader at the chip's bootloader offset. An
 * OTA image is just the application and has its magic byte at 0 instead — so
 * writing one at 0x0 produces a board that will not boot. One byte tells them
 * apart.
 */
export function checkImage(input: PreflightInput): CheckResult {
  const head = input.imageHead;
  if (head === undefined || head.length === 0) {
    return { id: "image", ok: true, message: "Image not inspected." };
  }
  const offset = BOOTLOADER_FLASH_OFFSET[input.buildTarget] ?? 0;
  const expectedAt = input.writeAddress + offset;

  if (head.length <= expectedAt) {
    return { id: "image", ok: true, message: "Image too small to inspect." };
  }
  if (head[expectedAt] === ESP_IMAGE_MAGIC) {
    return { id: "image", ok: true, message: "Looks like a full-flash image." };
  }
  // A bare application image has its header at the very start instead.
  if (head[0] === ESP_IMAGE_MAGIC && offset !== 0) {
    return {
      id: "image",
      ok: false,
      message:
        "This looks like an update image, not a full-flash image. Writing it " +
        "to a blank board would leave it unable to start.",
    };
  }
  return {
    id: "image",
    ok: false,
    message: "This file does not look like firmware for this chip.",
  };
}

/**
 * Do we know which board variant this is?
 *
 * espOS matches an update on chip alone, so two incompatible panels behind one
 * target cannot be told apart automatically. When a project declares several
 * boards for the chip and the build does not name one, the user has to say.
 */
export function checkBoard(input: PreflightInput): CheckResult {
  const candidates = input.candidateBoards ?? [];
  if (input.buildBoard !== undefined) {
    return {
      id: "board",
      ok: true,
      message: `Built for ${input.buildBoard}.`,
    };
  }
  if (candidates.length <= 1) {
    return { id: "board", ok: true, message: "Only one board uses this chip." };
  }
  if (input.chosenBoard !== undefined) {
    const picked = candidates.find((b) => b.id === input.chosenBoard);
    return {
      id: "board",
      ok: picked !== undefined,
      message:
        picked === undefined
          ? "That board is not one this firmware supports."
          : `Flashing as ${picked.name}.`,
    };
  }
  return {
    id: "board",
    ok: false,
    needsChoice: true,
    message:
      "Several boards use this chip and they are not interchangeable — " +
      "the wrong one usually leaves the screen black. Choose which one this is.",
  };
}

export interface PreflightReport {
  checks: CheckResult[];
  /** True only when every check passed. */
  canWrite: boolean;
  /** True when the user can unblock this by choosing a board. */
  needsChoice: boolean;
}

export function preflight(input: PreflightInput): PreflightReport {
  const checks = [
    checkChip(input),
    checkFit(input),
    checkImage(input),
    checkBoard(input),
  ];
  return {
    checks,
    canWrite: checks.every((c) => c.ok),
    needsChoice: checks.some((c) => c.needsChoice === true),
  };
}

/**
 * The flash parameters passed to `writeFlash`.
 *
 * All three must stay "keep". `_updateImageFlashParams()` rewrites image bytes
 * 2 and 3 and recomputes the appended SHA-256 when any of them is set — which
 * invalidates a signed image. The early return that skips the rewrite fires
 * only when the write address differs from the chip's bootloader offset, and
 * six of the ten supported chips have that offset at 0x0, exactly where a
 * merged image is written. So on most chips these values are the only thing
 * standing between a signed image and a corrupted one.
 */
export const SAFE_FLASH_PARAMS = {
  flashMode: "keep",
  flashFreq: "keep",
  flashSize: "keep",
} as const;
