/**
 * Chip facts, read out of esptool-js 0.6.1 rather than assumed.
 *
 * Two of these decide whether a signed firmware image survives being written,
 * so both were checked against the library's own source and its inheritance
 * chain (several targets inherit an offset from another target rather than
 * declaring one).
 */

import type { Target } from "./types.js";

/**
 * `ESPLoader.chip.CHIP_NAME` to the ESP-IDF target name.
 *
 * The exact strings esptool-js reports; a mismatch here would let a P4 image
 * be written to a C6, which the device rejects only after the whole transfer.
 */
export const CHIP_NAME_TO_TARGET: Readonly<Record<string, Target>> = {
  ESP32: "esp32",
  "ESP32-C2": "esp32c2",
  "ESP32-C3": "esp32c3",
  "ESP32-C5": "esp32c5",
  "ESP32-C6": "esp32c6",
  "ESP32-C61": "esp32c61",
  "ESP32-H2": "esp32h2",
  "ESP32-P4": "esp32p4",
  "ESP32-S2": "esp32s2",
  "ESP32-S3": "esp32s3",
  ESP8266: "esp8266",
};

/**
 * Where each chip's bootloader lives, and therefore where an image header is
 * expected.
 *
 * Resolved through the inheritance chain, not from the literals in each file:
 * `esp32c6.js` sets 0 while extending ESP32C3ROM, `esp32c5.js` sets 0x2000
 * while extending ESP32C6ROM, and `esp32c61.js` declares nothing at all.
 *
 * Six of the ten have offset 0, which matters: `_updateImageFlashParams()`
 * returns early only when the write address differs from this offset, so a
 * merged image written at 0x0 goes through the rewrite path on most chips.
 * The `keep` flash parameters are what actually prevent mutation there.
 */
export const BOOTLOADER_FLASH_OFFSET: Readonly<Record<Target, number>> = {
  esp32: 0x1000,
  esp32c2: 0x0,
  esp32c3: 0x0,
  esp32c5: 0x2000,
  esp32c6: 0x0,
  esp32c61: 0x0,
  esp32h2: 0x0,
  esp32p4: 0x2000,
  esp32s2: 0x1000,
  esp32s3: 0x0,
  esp8266: 0x0,
};

/** Every ESP image starts with this magic byte. */
export const ESP_IMAGE_MAGIC = 0xe9;

/**
 * Espressif's native USB-serial-JTAG product id.
 *
 * `constructResetSequence()` picks `UsbJtagSerialReset` when it sees this, so
 * the right reset happens automatically — the user just has to pick the right
 * socket on a board that has two.
 */
export const USB_JTAG_SERIAL_PID = 0x1001;

export function targetFromChipName(chipName: string): Target | undefined {
  return CHIP_NAME_TO_TARGET[chipName];
}

/** A friendly chip name for a target, for messages the user reads. */
export function chipNameForTarget(target: Target): string {
  for (const [name, value] of Object.entries(CHIP_NAME_TO_TARGET)) {
    if (value === target) return name;
  }
  return target;
}
