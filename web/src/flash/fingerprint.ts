/**
 * Which board is plugged in, from what a browser can read without writing
 * anything: the chip, the flash size, the USB bridge, and the firmware already
 * on the board.
 *
 * None of these names the vendor and model outright; the ESP32's own USB id is
 * Espressif's whoever built the board. Together they narrow the list, and the
 * firmware already there is often decisive: a board fresh from the box usually
 * still runs the vendor's demo, and a board that ran espOS before says which
 * project it ran. The page leads with a match only when one board stands out,
 * and every match stays a suggestion the owner checks against the hardware.
 */

import type { HardwareBoard } from "./catalogue.js";
import type { Target } from "./types.js";

/** Where ESP-IDF puts the partition table unless a project moves it. */
export const PARTITION_TABLE_OFFSET = 0x8000;
/** Room for the 95 entries a table can hold, plus its MD5 row. */
export const PARTITION_TABLE_BYTES = 0xc00;
/** The image header and the first segment header come before the app description. */
export const APP_DESC_OFFSET = 0x20;
export const APP_DESC_BYTES = 0x100;
/** Two 4 KB sectors, one OTA selection entry at the start of each. */
export const OTADATA_SECTOR = 0x1000;

const PARTITION_MAGIC = 0x50aa;
const APP_DESC_MAGIC = 0xabcd5432;
const ESP_IMAGE_MAGIC = 0xe9;

const TYPE_APP = 0x00;
const TYPE_DATA = 0x01;
const SUBTYPE_FACTORY = 0x00;
const SUBTYPE_OTA_0 = 0x10;
const SUBTYPE_OTA_15 = 0x1f;
const SUBTYPE_DATA_OTA = 0x00;

/** OTA states that mean the slot must not be booted. */
const OTA_STATE_INVALID = 3;
const OTA_STATE_ABORTED = 4;
const OTA_SEQ_UNSET = 0xffffffff;

export interface Partition {
  type: number;
  subtype: number;
  offset: number;
  size: number;
  label: string;
}

function cString(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder()
    .decode(end === -1 ? slice : slice.subarray(0, end))
    .trim();
}

/** The entries of an ESP-IDF partition table, or none when there is no table. */
export function parsePartitionTable(bytes: Uint8Array): Partition[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const partitions: Partition[] = [];
  for (let at = 0; at + 32 <= bytes.byteLength; at += 32) {
    // The table ends at blank flash or at its MD5 row (0xEBEB).
    if (view.getUint16(at, true) !== PARTITION_MAGIC) break;
    partitions.push({
      type: view.getUint8(at + 2),
      subtype: view.getUint8(at + 3),
      offset: view.getUint32(at + 4, true),
      size: view.getUint32(at + 8, true),
      label: cString(bytes, at + 12, 16),
    });
  }
  return partitions;
}

function isOtaSlot(p: Partition): boolean {
  return (
    p.type === TYPE_APP &&
    p.subtype >= SUBTYPE_OTA_0 &&
    p.subtype <= SUBTYPE_OTA_15
  );
}

/** The otadata partition, whose two sectors say which OTA slot boots. */
export function otadataPartition(
  partitions: readonly Partition[],
): Partition | undefined {
  return partitions.find(
    (p) => p.type === TYPE_DATA && p.subtype === SUBTYPE_DATA_OTA,
  );
}

/**
 * The ROM's crc32_le, which the bootloader checks otadata entries with. It
 * inverts the seed on the way in, so ESP-IDF's seed of 0xFFFFFFFF starts the
 * register at zero: not the plain CRC-32 of the four bytes.
 */
function romCrc32le(seed: number, bytes: Uint8Array): number {
  let crc = ~seed >>> 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? ((crc >>> 1) ^ 0xedb88320) >>> 0 : crc >>> 1;
    }
  }
  return ~crc >>> 0;
}

/**
 * The app partition the bootloader would start, by its own rules: the newest
 * valid otadata entry picks OTA slot (seq - 1) mod the number of slots, found
 * by subtype; without one the factory app boots, or ota_0 when there is no
 * factory partition.
 */
export function bootPartition(
  partitions: readonly Partition[],
  otadata: Uint8Array | undefined,
): Partition | undefined {
  const slots = partitions.filter(isOtaSlot);
  const slot = (index: number): Partition | undefined =>
    slots.find((p) => p.subtype === SUBTYPE_OTA_0 + index);
  const factory = partitions.find(
    (p) => p.type === TYPE_APP && p.subtype === SUBTYPE_FACTORY,
  );
  if (otadata !== undefined && slots.length > 0) {
    const view = new DataView(
      otadata.buffer,
      otadata.byteOffset,
      otadata.byteLength,
    );
    let newest: number | undefined;
    for (let at = 0; at + 32 <= otadata.byteLength; at += OTADATA_SECTOR) {
      const seq = view.getUint32(at, true);
      const state = view.getUint32(at + 24, true);
      const crc = view.getUint32(at + 28, true);
      if (seq === OTA_SEQ_UNSET) continue;
      // A torn write from an interrupted update: the bootloader skips it too.
      if (crc !== romCrc32le(0xffffffff, otadata.subarray(at, at + 4))) {
        continue;
      }
      if (state === OTA_STATE_INVALID || state === OTA_STATE_ABORTED) continue;
      if (newest === undefined || seq > newest) newest = seq;
    }
    if (newest !== undefined) return slot((newest - 1) % slots.length);
  }
  return factory ?? slot(0);
}

export interface AppDescription {
  projectName: string;
  version: string;
  idfVersion?: string;
}

/** The app description at the start of an app image, when there is one. */
export function parseAppDescription(
  image: Uint8Array,
): AppDescription | undefined {
  if (image.byteLength < APP_DESC_OFFSET + 144) return undefined;
  if (image[0] !== ESP_IMAGE_MAGIC) return undefined;
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (view.getUint32(APP_DESC_OFFSET, true) !== APP_DESC_MAGIC) {
    return undefined;
  }
  const projectName = cString(image, APP_DESC_OFFSET + 48, 32);
  if (projectName === "") return undefined;
  const idfVersion = cString(image, APP_DESC_OFFSET + 112, 32);
  return {
    projectName,
    version: cString(image, APP_DESC_OFFSET + 16, 32),
    idfVersion: idfVersion === "" ? undefined : idfVersion,
  };
}

/** What the connected board told us, as far as it could. */
export interface Fingerprint {
  target?: Target;
  flashBytes?: number;
  /** False when `flashBytes` is a fallback, not a reading. */
  flashSizeDetected: boolean;
  /** Lower-case hex, as the registry writes them. */
  usbVid?: string;
  usbPid?: string;
  installed?: AppDescription;
}

/** A registry project, as far as matching needs it. */
export interface FingerprintProject {
  id: string;
  app: string;
  name: string;
  boards?: { id: string; target: string; runsOn?: string[] }[];
}

export type Clue = "factory" | "espos" | "bridge";

export interface LikelyBoard {
  id: string;
  clues: Clue[];
  /** The project whose firmware is already on the board, for "espos". */
  project?: string;
}

const GENERIC_VENDOR = "Various";

const WEIGHT: Record<Clue, number> = { factory: 4, espos: 3, bridge: 1 };

function score(board: LikelyBoard): number {
  return board.clues.reduce((sum, clue) => sum + WEIGHT[clue], 0);
}

/**
 * Catalogue boards the fingerprint points at, strongest first.
 *
 * A board on another chip, or with a different flash size than the chip
 * reports, is never suggested: those are readings, not hints.
 */
export function likelyBoards(
  print: Fingerprint,
  hardware: readonly HardwareBoard[],
  projects: readonly FingerprintProject[],
): LikelyBoard[] {
  const installed = print.installed?.projectName;
  const espos =
    installed === undefined
      ? undefined
      : projects.find((p) => p.app === installed);
  const esposBoards = new Set(
    (espos?.boards ?? [])
      .filter((b) => b.target === print.target)
      .flatMap((b) => b.runsOn ?? [b.id]),
  );
  // "Various" is the catalogue's word for a stand-in that covers every board
  // on a chip: firmware built for it says nothing about which board this is.
  const generic = (board: HardwareBoard): boolean =>
    board.vendor === GENERIC_VENDOR;

  const found: LikelyBoard[] = [];
  for (const board of hardware) {
    if (print.target !== undefined && board.target !== print.target) continue;
    // A board sold in several sizes lists them all; one that names only its
    // own model's size is ruled out by any other.
    const sizes =
      board.flashSizes ??
      (board.flashBytes === undefined ? [] : [board.flashBytes]);
    if (
      print.flashSizeDetected &&
      print.flashBytes !== undefined &&
      sizes.length > 0 &&
      !sizes.includes(print.flashBytes)
    ) {
      continue;
    }
    const clues: Clue[] = [];
    if (installed !== undefined && board.factoryApps?.includes(installed)) {
      clues.push("factory");
    }
    if (esposBoards.has(board.id) && !generic(board)) clues.push("espos");
    const bridge = board.usbBridge;
    if (
      bridge?.vid !== undefined &&
      bridge.vid === print.usbVid &&
      (bridge.pid === undefined || bridge.pid === print.usbPid)
    ) {
      clues.push("bridge");
    }
    if (clues.length > 0) {
      found.push({
        id: board.id,
        clues,
        project: clues.includes("espos") ? espos?.name : undefined,
      });
    }
  }
  return found.sort((a, b) => score(b) - score(a));
}

/**
 * The one board to lead with, if the clues single one out.
 *
 * A shared USB bridge alone never does: Waveshare puts the same CH343 on
 * dozens of boards.
 */
export function leadingBoard(
  likely: readonly LikelyBoard[],
): LikelyBoard | undefined {
  const [first, second] = likely;
  if (first === undefined) return undefined;
  if (first.clues.every((clue) => clue === "bridge")) return undefined;
  if (second !== undefined && score(second) >= score(first)) return undefined;
  return first;
}

/** Four lower-case hex digits, as the registry writes USB ids. */
export function usbId(value: number | undefined): string | undefined {
  return value === undefined ? undefined : value.toString(16).padStart(4, "0");
}
