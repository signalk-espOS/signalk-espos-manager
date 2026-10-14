/**
 * Day/night for espOS panels. The panel dims only at night, so a wrong "night"
 * darkens the helm in daylight, and no value at all must leave it bright.
 */

import { sunEvents } from "@openwaters/almanac";
import type { ServerAPI } from "@signalk/server-api";
import { describe, expect, it, vi } from "vitest";
import {
  dayNight,
  DayNightPublisher,
  readPosition,
} from "../src/sky/dayNight.js";

const equator = { latitude: 0, longitude: 0 };

describe("dayNight", () => {
  it("is day at noon and night at midnight on the equator", () => {
    expect(dayNight(new Date("2024-06-21T12:00:00Z"), equator)).toBe("day");
    expect(dayNight(new Date("2024-06-21T00:00:00Z"), equator)).toBe("night");
  });

  it("switches at Almanac's own sunrise and sunset", () => {
    // Away from the equator and in both hemispheres, so the threshold is
    // checked where the Sun crosses the horizon at a shallow angle too.
    for (const position of [
      equator,
      { latitude: 60, longitude: 10 },
      { latitude: -40, longitude: 170 },
    ]) {
      // June and January: the Sun is smallest at aphelion and largest at
      // perihelion, which moves the altitude of its upper limb.
      for (const start of ["2024-06-21T00:00:00Z", "2025-01-03T00:00:00Z"]) {
        const from = new Date(start);
        const events = sunEvents(
          from,
          new Date(from.getTime() + 2 * 86_400_000),
          { latitudeDeg: position.latitude, longitudeDeg: position.longitude },
        ).filter((event) => event.kind === "rise" || event.kind === "set");
        expect(events.length).toBeGreaterThanOrEqual(4);
        for (const event of events) {
          const before = new Date(event.time.getTime() - 60_000);
          const after = new Date(event.time.getTime() + 60_000);
          const [was, becomes] =
            event.kind === "rise" ? ["night", "day"] : ["day", "night"];
          expect(dayNight(before, position)).toBe(was);
          expect(dayNight(after, position)).toBe(becomes);
        }
      }
    }
  });

  it("follows the midnight sun and the polar night", () => {
    const svalbard = { latitude: 78.2, longitude: 15.6 };
    expect(dayNight(new Date("2024-06-21T23:30:00Z"), svalbard)).toBe("day");
    expect(dayNight(new Date("2024-12-21T12:00:00Z"), svalbard)).toBe("night");
  });

  it("is day when the Sun only grazes the horizon before the polar night", () => {
    // The centre stays below -0.211°, but the upper limb clears the horizon.
    expect(
      dayNight(new Date("2024-11-22T11:29:40Z"), {
        latitude: 70.5,
        longitude: 0,
      }),
    ).toBe("day");
  });
});

describe("readPosition", () => {
  it("reads the data-model leaf and a bare position", () => {
    expect(
      readPosition({
        value: { latitude: 54.3, longitude: 10.1 },
        $source: "gps",
      }),
    ).toEqual({ latitude: 54.3, longitude: 10.1 });
    expect(readPosition({ latitude: 1, longitude: 2 })).toEqual({
      latitude: 1,
      longitude: 2,
    });
  });

  it("refuses anything that is not a usable position", () => {
    for (const entry of [
      undefined,
      null,
      "54.3,10.1",
      { value: null },
      { value: { latitude: null, longitude: null } },
      { latitude: Number.NaN, longitude: 0 },
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 },
    ]) {
      expect(readPosition(entry)).toBeUndefined();
    }
  });
});

describe("DayNightPublisher", () => {
  function fakeApp(position: unknown) {
    const handleMessage = vi.fn();
    const app = {
      getSelfPath: vi.fn(() => position),
      handleMessage,
      debug: vi.fn(),
    } as unknown as ServerAPI;
    return { app, handleMessage };
  }

  it("publishes environment.mode as this plugin", () => {
    const { app, handleMessage } = fakeApp({ value: equator });
    new DayNightPublisher(
      app,
      "signalk-espos-manager",
      () => new Date("2024-06-21T12:00:00Z"),
    ).publish();
    expect(handleMessage).toHaveBeenCalledWith("signalk-espos-manager", {
      updates: [{ values: [{ path: "environment.mode", value: "day" }] }],
    });
  });

  it("publishes nothing without a position, so the panel stays bright", () => {
    const { app, handleMessage } = fakeApp(undefined);
    new DayNightPublisher(app, "signalk-espos-manager").publish();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("survives a server that throws while publishing", () => {
    const { app, handleMessage } = fakeApp({ value: equator });
    handleMessage.mockImplementation(() => {
      throw new Error("shutting down");
    });
    expect(() => {
      new DayNightPublisher(app, "signalk-espos-manager").publish();
    }).not.toThrow();
  });

  it("publishes nothing for a clock outside Almanac's range", () => {
    const { app, handleMessage } = fakeApp({ value: equator });
    new DayNightPublisher(
      app,
      "signalk-espos-manager",
      () => new Date("1900-01-01T12:00:00Z"),
    ).publish();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("stops republishing once stopped", () => {
    vi.useFakeTimers();
    try {
      const { app, handleMessage } = fakeApp({ value: equator });
      const publisher = new DayNightPublisher(app, "signalk-espos-manager");
      publisher.start();
      vi.advanceTimersByTime(60_000);
      expect(handleMessage).toHaveBeenCalledTimes(2);
      publisher.stop();
      vi.advanceTimersByTime(180_000);
      expect(handleMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
