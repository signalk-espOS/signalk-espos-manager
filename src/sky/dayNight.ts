/**
 * Publish `environment.mode` ("day" / "night") from the boat's position, so
 * an espOS panel can dim at night without signalk-derived-data installed.
 *
 * The Sun comes from @openwaters/almanac, which needs no network and no data
 * files, so this keeps working offshore.
 */

import { sunAltAz } from "@openwaters/almanac";
import type { Path, ServerAPI } from "@signalk/server-api";

export type DayNightMode = "day" | "night";

/**
 * Almanac's refracted altitude of the Sun's centre at its own rise and set:
 * the upper limb on the horizon. Day is "any of the Sun is up", which lands
 * within a minute of the rise and set Almanac's sunEvents reports.
 */
export const SUNSET_ALTITUDE_DEG = -0.211;

const PUBLISH_INTERVAL_MS = 60_000;

export interface Position {
  latitude: number;
  longitude: number;
}

export function dayNight(date: Date, position: Position): DayNightMode {
  const { altDeg } = sunAltAz(date, {
    latitudeDeg: position.latitude,
    longitudeDeg: position.longitude,
  });
  return altDeg > SUNSET_ALTITUDE_DEG ? "day" : "night";
}

/**
 * The server hands back the data-model leaf ({ value, $source, ... }); a
 * bare { latitude, longitude } is accepted too.
 */
export function readPosition(entry: unknown): Position | undefined {
  const candidate =
    typeof entry === "object" && entry !== null && "value" in entry
      ? (entry as { value: unknown }).value
      : entry;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const { latitude, longitude } = candidate as Record<string, unknown>;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return undefined;
  }
  return { latitude, longitude };
}

export class DayNightPublisher {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly app: ServerAPI,
    private readonly pluginId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    this.stop();
    this.publish();
    this.timer = setInterval(() => {
      this.publish();
    }, PUBLISH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Republished every minute, not only on a change: a panel that connects
   * later gets a fresh value, and the mode follows a moving boat.
   */
  publish(): void {
    // Runs from a timer: anything thrown here would be an uncaught
    // exception in the server process.
    try {
      this.publishMode();
    } catch (error) {
      this.app.debug(
        `day/night: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private publishMode(): void {
    const position = readPosition(this.app.getSelfPath("navigation.position"));
    // No position yet: publish nothing. The panel stays bright until it
    // hears a mode, which is the safe side.
    if (position === undefined) return;
    // Almanac covers 1950 to 2100 and throws outside it, which only a badly
    // wrong system clock reaches; publish() logs that and publishes nothing.
    const mode = dayNight(this.now(), position);
    this.app.handleMessage(this.pluginId, {
      updates: [
        { values: [{ path: "environment.mode" as Path, value: mode }] },
      ],
    });
  }
}
