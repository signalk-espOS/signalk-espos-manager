/**
 * Driving esptool-js.
 *
 * Deliberately thin: everything that can be decided without hardware lives in
 * preflight.ts, so this file is only the part that must touch a serial port.
 * The ESPLoader instance is kept in a module-level ref rather than in the
 * store — it is tied to a live port, is not serialisable, and must not survive
 * a component remount.
 */

import { SAFE_FLASH_PARAMS } from "./preflight.js";
import {
  FLASH_SIZE_BY_ID,
  isFlashId,
  targetFromChipName,
  USB_JTAG_SERIAL_PID,
} from "./chips.js";
import type { Target } from "./types.js";

/**
 * How many times to ask the flash chip for its id before giving up.
 *
 * The read is one SPI command, so a few attempts are cheap next to a flash
 * that takes minutes, and the alternative is reporting a size that is wrong in
 * the direction that blocks a legitimate write.
 */
const FLASH_ID_ATTEMPTS = 3;
const FLASH_ID_RETRY_MS = 100;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal shapes, so the app does not depend on esptool-js's own types. */
interface Transport {
  getPid(): number | undefined;
  disconnect(): Promise<void>;
}

interface Loader {
  main(): Promise<string>;
  /** Returns a size string such as "16MB", not a byte count. */
  detectFlashSize(): Promise<string>;
  /** Converts that string to bytes. */
  flashSizeBytes(flashSize: string): number;
  /** Raw JEDEC id of the flash part: 24 bits, manufacturer in the low byte. */
  readFlashId(): Promise<number>;
  /** Radios and cores, e.g. ["Wi-Fi 6 (dual-band)", "BT 5 (LE)"]. */
  chip: {
    CHIP_NAME: string;
    getChipDescription?: (loader: Loader) => Promise<string>;
    getChipFeatures?: (loader: Loader) => Promise<string[]>;
    readMac?: (loader: Loader) => Promise<string>;
  };
  writeFlash(options: {
    fileArray: { data: Uint8Array; address: number }[];
    flashMode: string;
    flashFreq: string;
    flashSize: string;
    eraseAll: boolean;
    compress: boolean;
    reportProgress?: (index: number, written: number, total: number) => void;
  }): Promise<void>;
  after(mode: string): Promise<void>;
}

export interface Connection {
  transport: Transport;
  loader: Loader;
  chipName: string;
  target?: Target;
  flashBytes?: number;
  /**
   * False when `flashBytes` is esptool-js's guess rather than a reading.
   *
   * `detectFlashSize()` answers "4MB" both when it decoded that from the
   * chip and when it could not decode anything at all (esploader.js: `if
   * (!flashSizeStr) { flashSizeStr = "4MB" }`). Those must not look the same:
   * a guess that is too SMALL makes good firmware look too big for the board.
   * Seen for real on a Waveshare ESP32-C5 whose flash reports manufacturer
   * 0x46 — the browser said 4 MB, the chip has 16 MB.
   */
  flashSizeDetected: boolean;
  /** The raw JEDEC id, when one was read, for diagnosing an unknown chip. */
  jedecId?: number;
  /** What the chip says it is, e.g. "ESP32-C5 (revision v1.0)". */
  chipDescription?: string;
  /** Radios and cores the chip reports. */
  features?: string[];
  /** Unique to this unit — not to the board model. */
  mac?: string;
  /** True when the user picked Espressif's native USB port. */
  nativeUsb: boolean;
}

let current: Connection | undefined;

export function activeConnection(): Connection | undefined {
  return current;
}

/** Is this browser capable of talking to a board at all? */
export function serialSupport(): {
  supported: boolean;
  reason?: string;
  needsHttps: boolean;
} {
  if (typeof navigator !== "undefined" && "serial" in navigator) {
    return { supported: true, needsHttps: false };
  }
  // Web Serial needs a secure context; a boat server on plain http has none.
  const insecure =
    typeof window !== "undefined" &&
    !window.isSecureContext &&
    window.location.protocol === "http:";
  if (insecure) {
    return {
      supported: false,
      needsHttps: true,
      reason:
        "Flashing a board over USB needs a secure connection, and this page " +
        "is served over plain http.",
    };
  }
  return {
    supported: false,
    needsHttps: false,
    reason:
      "This browser cannot talk to a USB serial port. Chrome, Edge or another " +
      "Chromium browser can.",
  };
}

/**
 * Ask for a port and identify what is on the other end.
 *
 * `requestPort()` is called without filters on purpose. Filtering by USB
 * vendor and product looks tidier and hides the only working port on boards
 * that expose both a native USB-serial-JTAG and a UART bridge — the user is
 * then shown an empty chooser with no explanation. Show every port and let
 * chip detection be the judge.
 */
export async function connect(
  log: (line: string) => void,
): Promise<Connection> {
  const serial = (
    navigator as unknown as {
      serial: { requestPort(options?: object): Promise<unknown> };
    }
  ).serial;
  const port = await serial.requestPort({});

  const { ESPLoader, Transport: TransportCtor } =
    (await import("esptool-js")) as unknown as {
      ESPLoader: new (options: object) => Loader;
      Transport: new (port: unknown, tracing: boolean) => Transport;
    };

  const transport = new TransportCtor(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: 921600,
    romBaudrate: 115200,
    terminal: {
      clean: () => {},
      write: (text: string) => log(text),
      writeLine: (text: string) => log(text),
    },
    enableTracing: false,
  });

  // main() detects the chip, uploads the stub, raises the baud rate and
  // verifies the flash responds. Using it rather than hand-rolling those
  // steps keeps us on the library's tested path.
  // main() returns getChipDescription(), e.g. "ESP32-C5 (revision v1.0)" --
  // NOT the bare chip name. Deriving the target from it silently failed for
  // every chip whose description carries a revision, which is all of the
  // modern ones: the page said "could not work out which chip this is" while
  // displaying the chip two lines above, and the wrong-chip gate never fired.
  // chip.CHIP_NAME is the exact key our table uses.
  const description = await loader.main();
  const chipName = loader.chip.CHIP_NAME ?? description;

  let flashBytes: number | undefined;
  let flashSizeDetected = false;
  // Kept so an unrecognised id can be reported rather than silently becoming
  // "could not be read" -- the raw value is what makes a bug report useful.
  let jedecId: number | undefined;
  try {
    // Read the JEDEC id ourselves and decode the size byte, rather than
    // trusting detectFlashSize() alone. That call answers "4MB" both when it
    // read 4 MB off the chip and when it recognised nothing, and the two must
    // be distinguishable — see Connection.flashSizeDetected.
    // Same extraction esptool-js uses: manufacturer in the low byte, size in
    // bits 16-23 (esploader.js flashId()/detectFlashSize()).
    let jedec = await loader.readFlashId();

    // 0x000000 and 0xffffff are not ids: they are what the SPI read returns
    // when the flash chip did not answer, and esptool-js's own main() warns on
    // exactly these two values ("Failed to communicate with the flash chip").
    // Seen on a Waveshare ESP32-C5 in Chrome, where the first read came back
    // 0x000000 while the identical read over USB on another machine returned
    // 0x184046 (16 MB). Retrying costs one SPI command and turns a permanent
    // wrong answer into a correct one.
    for (
      let attempt = 0;
      attempt < FLASH_ID_ATTEMPTS && !isFlashId(jedec);
      attempt++
    ) {
      await sleep(FLASH_ID_RETRY_MS);
      jedec = await loader.readFlashId();
    }

    // Only record an id that is one; a sentinel must not be shown as though
    // the chip identified itself as something unrecognised.
    if (isFlashId(jedec)) {
      jedecId = jedec;
      const sizeId = (jedec >> 16) & 0xff;
      const known = FLASH_SIZE_BY_ID[sizeId];
      if (known !== undefined) {
        flashBytes = known;
        flashSizeDetected = true;
      }
    }
  } catch {
    // Fall through to the library's answer below.
  }

  if (flashBytes === undefined) {
    try {
      // detectFlashSize() answers with a string like "16MB"; flashSizeBytes()
      // turns it into a number. There is no getFlashSize() — calling one would
      // throw into the catch below and silently disable the fit check, which is
      // the very thing that stops a 16 MB image reaching a 4 MB board.
      const detected = await loader.detectFlashSize();
      const bytes = loader.flashSizeBytes(detected);
      // Whatever this is, it is not a reading we could confirm, so it stays
      // flagged as undetected and never blocks a write on its own.
      if (Number.isFinite(bytes) && bytes > 0) flashBytes = bytes;
    } catch {
      // Not fatal: the fit check reports "unknown" and lets the write proceed.
    }
  }

  // Describe the hardware while we have it connected. Each is optional in
  // esptool-js's chip classes, and none of it is worth failing a flash over.
  const chipDescription: string | undefined = description;
  let features: string[] | undefined;
  let mac: string | undefined;
  try {
    features = await loader.chip.getChipFeatures?.(loader);
  } catch {
    /* optional */
  }
  try {
    mac = await loader.chip.readMac?.(loader);
  } catch {
    /* optional */
  }

  current = {
    transport,
    loader,
    chipName,
    target: targetFromChipName(chipName),
    flashBytes,
    flashSizeDetected,
    jedecId,
    chipDescription,
    features,
    mac,
    nativeUsb: transport.getPid() === USB_JTAG_SERIAL_PID,
  };
  return current;
}

export interface WriteOptions {
  image: ArrayBuffer;
  /** Merged images go to 0; the bootloader offset is baked in by merge_bin. */
  address?: number;
  eraseAll?: boolean;
  onProgress: (written: number, total: number) => void;
  log: (line: string) => void;
}

export async function writeImage(options: WriteOptions): Promise<void> {
  const connection = current;
  if (connection === undefined) {
    throw new Error("No board is connected.");
  }

  // Uint8Array, per FlashOptions in esptool-js's own types: the library pads
  // it with padTo(), indexes image[2] numerically and hands it to pako's
  // deflate(). Tutorials predating 0.5 show a binary string; passing one now
  // corrupts every image.
  const bytes = new Uint8Array(options.image);

  await connection.loader.writeFlash({
    fileArray: [{ data: bytes, address: options.address ?? 0 }],
    ...SAFE_FLASH_PARAMS,
    // A merged image overwrites every sector it occupies, and a full chip
    // erase adds minutes while destroying stored WiFi credentials.
    eraseAll: options.eraseAll ?? false,
    compress: true,
    reportProgress: (_index, written, total) => {
      options.onProgress(written, total);
    },
  });

  await connection.loader.after("hard_reset");
  options.log("Done. The board is restarting.");
}

/** Release the port so the board — or another tool — can use it. */
export async function disconnect(): Promise<void> {
  const connection = current;
  current = undefined;
  if (connection === undefined) return;
  try {
    await connection.transport.disconnect();
  } catch {
    // The port may already be gone; nothing useful to do.
  }
}
