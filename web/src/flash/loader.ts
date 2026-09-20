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
import { targetFromChipName, USB_JTAG_SERIAL_PID } from "./chips.js";
import type { Target } from "./types.js";

/** Minimal shapes, so the app does not depend on esptool-js's own types. */
interface Transport {
  getPid(): number | undefined;
  disconnect(): Promise<void>;
}

interface Loader {
  main(): Promise<string>;
  chip: { CHIP_NAME: string };
  getFlashSize(): Promise<number>;
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
  const chipName = await loader.main();

  let flashBytes: number | undefined;
  try {
    flashBytes = await loader.getFlashSize();
  } catch {
    // Not fatal: the fit check reports "unknown" and lets the write proceed.
  }

  current = {
    transport,
    loader,
    chipName,
    target: targetFromChipName(chipName),
    flashBytes,
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
