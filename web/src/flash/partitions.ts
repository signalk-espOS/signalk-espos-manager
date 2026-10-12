/**
 * The partition table inside a full-flash image.
 *
 * The chip reports how much flash it has; only the image says how much of it
 * the firmware lays out and how big its app slot is. A 16 MB board running a
 * build partitioned for 6 MB otherwise reads as "fits in 16 MB", which says
 * nothing about how close the app is to outgrowing its slot -- the number that
 * decides whether the next release can still be installed over the air.
 *
 * Pure, so it is tested without hardware or a download.
 */

/** Each entry starts with these two bytes; the MD5 row and padding do not. */
const ENTRY_MAGIC_0 = 0xaa;
const ENTRY_MAGIC_1 = 0x50;
const ENTRY_BYTES = 32;
/** ESP-IDF's default CONFIG_PARTITION_TABLE_OFFSET, and espOS's. */
const DEFAULT_TABLE_OFFSET = 0x8000;
/** The table is at most one 4 KiB sector. */
const TABLE_MAX_BYTES = 0x1000;

const TYPE_APP = 0x00;
const SUBTYPE_FACTORY = 0x00;
const SUBTYPE_OTA_MIN = 0x10;
const SUBTYPE_OTA_MAX = 0x1f;

export interface Partition {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

function hasEntryAt(bytes: Uint8Array, at: number): boolean {
  return (
    at + ENTRY_BYTES <= bytes.length &&
    bytes[at] === ENTRY_MAGIC_0 &&
    bytes[at + 1] === ENTRY_MAGIC_1
  );
}

/**
 * Read the table from the start of a merged image (offset 0 = flash 0x0).
 *
 * Looks at the default offset first, then at every other 4 KiB boundary the
 * head covers, since a project may move the table. Undefined when no table is
 * found, and the page then shows no layout rather than a guess.
 */
export function parsePartitionTable(head: Uint8Array): Partition[] | undefined {
  const starts = [DEFAULT_TABLE_OFFSET];
  for (let at = 0x1000; at < head.length; at += 0x1000) {
    if (at !== DEFAULT_TABLE_OFFSET) starts.push(at);
  }
  const start = starts.find((at) => hasEntryAt(head, at));
  if (start === undefined) return undefined;

  const entries: Partition[] = [];
  const end = Math.min(start + TABLE_MAX_BYTES, head.length);
  for (let at = start; at + ENTRY_BYTES <= end; at += ENTRY_BYTES) {
    if (!hasEntryAt(head, at)) break;
    const labelBytes = head.subarray(at + 12, at + 28);
    const nul = labelBytes.indexOf(0);
    entries.push({
      type: head[at + 2] ?? 0,
      subtype: head[at + 3] ?? 0,
      offset: readU32(head, at + 4),
      size: readU32(head, at + 8),
      label: new TextDecoder().decode(
        nul === -1 ? labelBytes : labelBytes.subarray(0, nul),
      ),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

export interface FlashLayout {
  /** Where the last partition ends: the flash the firmware actually uses. */
  partitionedBytes: number;
  /** The app slot an update has to fit in (the smallest one, if they differ). */
  appSlotBytes?: number;
  /** The application image, when the build states its size. */
  appBytes?: number;
}

export function flashLayout(
  partitions: Partition[],
  appBytes?: number,
): FlashLayout {
  const partitionedBytes = Math.max(
    ...partitions.map((p) => p.offset + p.size),
  );
  const appSlots = partitions.filter(
    (p) =>
      p.type === TYPE_APP &&
      (p.subtype === SUBTYPE_FACTORY ||
        (p.subtype >= SUBTYPE_OTA_MIN && p.subtype <= SUBTYPE_OTA_MAX)),
  );
  const appSlotBytes =
    appSlots.length > 0 ? Math.min(...appSlots.map((p) => p.size)) : undefined;
  return { partitionedBytes, appSlotBytes, appBytes };
}
