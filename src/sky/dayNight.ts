/**
 * Publish `environment.mode` ("day" / "night") from the boat's position, so
 * an espOS panel can dim at night without signalk-derived-data installed.
 *
 * The Sun comes from @openwaters/almanac, which needs no network and no data
 * files, so this keeps working offshore.
 */

import { sunIsUp } from "@openwaters/almanac";
import type { Path, ServerAPI } from "@signalk/server-api";

export type DayNightMode = "day" | "night";

const PUBLISH_INTERVAL_MS = 60_000;

export interface Position {
  latitude: number;
  longitude: number;
}

/**
 * Day is "any of the Sun is up", by the same horizon and disc Almanac uses
 * for its sunrise and sunset, so the mode switches at those events. A fixed
 * altitude threshold drifts from them by the Sun's changing size, enough to
 * call a grazing polar sunrise night.
 */
export function dayNight(date: Date, position: Position): DayNightMode {
  return sunIsUp(date, {
    latitudeDeg: position.latitude,
    longitudeDeg: position.longitude,
  })
    ? "day"
    : "night";
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

/** environment.mode in the server's model, compared field by field. */
interface ModeEntry {
  value: unknown;
  source: unknown;
  timestamp: unknown;
}

/** The mode we sent, and the model's entry from before we sent it. */
interface Sent {
  mode: DayNightMode;
  before: ModeEntry;
}

/** Reads the data-model leaf; a bare value is accepted too. */
function modeEntry(entry: unknown): ModeEntry {
  if (typeof entry === "object" && entry !== null && "value" in entry) {
    const leaf = entry as Record<string, unknown>;
    return {
      value: leaf.value,
      source: leaf.$source,
      timestamp: leaf.timestamp,
    };
  }
  return { value: entry, source: undefined, timestamp: undefined };
}

export class DayNightPublisher {
  private timer?: NodeJS.Timeout;
  private published?: DayNightMode;
  private pending?: Sent;

  constructor(
    private readonly app: ServerAPI,
    private readonly pluginId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    this.stop();
    this.published = undefined;
    this.pending = undefined;
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
   * Worked out every minute, so the mode follows a moving boat, but published
   * only when it changes: environment.mode is also switched by hand (App
   * Dock's day/night button), and restating it would undo that switch within
   * a minute. A manual switch holds until the next sunrise or sunset; a
   * restart publishes the current mode again. A panel that connects later
   * gets the last value from the server.
   *
   * A sent mode counts only once the server's model shows it. With a source
   * priority ranking another publisher (App Dock) first, the server drops our
   * delta until that source has been quiet for its fallback timeout, so a
   * dropped transition is sent again each minute. A newer value from anyone
   * else in the meantime is a manual choice, and the retry stops.
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
    this.settlePending();
    if (mode === this.published) {
      // The Sun came back to the accepted mode before a dropped send landed.
      this.pending = undefined;
      return;
    }
    if (this.pending?.mode !== mode) {
      this.pending = { mode, before: this.readMode() };
    }
    this.app.handleMessage(this.pluginId, {
      updates: [
        { values: [{ path: "environment.mode" as Path, value: mode }] },
      ],
    });
    this.settlePending();
  }

  private readMode(): ModeEntry {
    return modeEntry(this.app.getSelfPath("environment.mode"));
  }

  /**
   * Accepted when the model holds the sent mode. Superseded when anything
   * else wrote environment.mode since we sent, even the same value: with
   * only two modes, a manual choice made after our transition can only
   * restate the old one, and it must hold. Unchanged means our delta was
   * dropped: keep it pending, and the next minute sends it again.
   */
  private settlePending(): void {
    if (this.pending === undefined) return;
    const current = this.readMode();
    const { before, mode } = this.pending;
    if (
      current.value === mode ||
      current.value !== before.value ||
      current.source !== before.source ||
      current.timestamp !== before.timestamp
    ) {
      this.published = mode;
      this.pending = undefined;
    }
  }
}
