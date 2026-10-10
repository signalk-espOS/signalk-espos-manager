/**
 * The radio co-processor update endpoint, `/api/v1/system/coprocessor/update`
 * (espOS 0.17.0+). Payloads follow `status_json()` in espOS
 * components/espos_wifi/src/coproc_update.c.
 */

import { describe, expect, it } from "vitest";
import { DeviceClient, DeviceHttpError } from "../src/device/client.js";
import { parseCoprocessorUpdate } from "../src/device/parse.js";

const IMAGE = {
  version: "3.0.9",
  sha256: "2eb7634e3321b946a05e07b5608df31ce495152239fad13efda23338044be866",
  url: "https://raw.githubusercontent.com/signalk-espOS/espOS/coprocessor-assets/esp32c6/3.0.9/espos-coprocessor-esp32c6-3.0.9-2eb7634e3321.bin",
};

describe("parseCoprocessorUpdate", () => {
  it("reads an idle device and the image it accepts", () => {
    expect(parseCoprocessorUpdate({ state: "idle", image: IMAGE })).toEqual({
      state: "idle",
      image: IMAGE,
    });
  });

  it("reads progress through a phase", () => {
    const status = parseCoprocessorUpdate({
      state: "writing",
      done: 1536,
      total: 1427568,
      image: IMAGE,
    });
    expect(status.state).toBe("writing");
    expect(status.done).toBe(1536);
    expect(status.total).toBe(1427568);
  });

  it("keeps the reason of a failed update", () => {
    const status = parseCoprocessorUpdate({
      state: "failed",
      error: "the image is not the one this firmware accepts",
    });
    expect(status.error).toBe("the image is not the one this firmware accepts");
  });

  it("drops an incomplete image and an unknown state", () => {
    const status = parseCoprocessorUpdate({
      state: "reticulating",
      image: { version: "3.0.9" },
    });
    expect(status.state).toBe("idle");
    expect(status.image).toBeUndefined();
    expect(parseCoprocessorUpdate(null).state).toBe("idle");
  });
});

describe("DeviceClient co-processor calls", () => {
  function recording(status = 202, body: unknown = { status: "updating" }) {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("passes a mirror URL when it has one", async () => {
    const { calls, fetchImpl } = recording();
    const client = new DeviceClient({ address: "10.0.0.5", fetchImpl });
    await client.coprocessorUpdate("http://10.0.0.2:3000/fw/c6.bin");
    expect(calls).toEqual([
      {
        url: "http://10.0.0.5/api/v1/system/coprocessor/update",
        method: "POST",
        body: JSON.stringify({ url: "http://10.0.0.2:3000/fw/c6.bin" }),
      },
    ]);
  });

  it("sends an empty object to use the device's own URL", async () => {
    // espOS rejects a POST without a JSON body, so "no URL" is {}, not nothing.
    const { calls, fetchImpl } = recording();
    const client = new DeviceClient({ address: "10.0.0.5", fetchImpl });
    await client.coprocessorUpdate();
    expect(calls[0]?.body).toBe("{}");
  });

  it("surfaces a 404 from firmware without the endpoint", async () => {
    const { fetchImpl } = recording(404, { error: "not_found" });
    const client = new DeviceClient({ address: "10.0.0.5", fetchImpl });
    const error: unknown = await client
      .coprocessorStatus()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceHttpError);
    expect((error as DeviceHttpError).status).toBe(404);
  });
});
