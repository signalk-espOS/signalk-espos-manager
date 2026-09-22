import { describe, expect, it } from "vitest";

import { deviceUrl } from "../web/src/deviceUrl.js";

describe("deviceUrl", () => {
  it("omits the default port", () => {
    expect(deviceUrl("192.168.0.167", 80)).toBe("http://192.168.0.167/");
  });

  it("keeps a non-default port", () => {
    expect(deviceUrl("192.168.0.167", 8081)).toBe("http://192.168.0.167:8081/");
  });

  it("brackets a bare IPv6 address", () => {
    // Unbracketed, the colons read as a port separator and the link is
    // silently broken. Discovery unwraps ::ffff: form but passes real IPv6
    // through, so one can reach the UI.
    expect(deviceUrl("fe80::1", 80)).toBe("http://[fe80::1]/");
    expect(deviceUrl("fe80::1", 8081)).toBe("http://[fe80::1]:8081/");
  });

  it("leaves a hostname alone", () => {
    expect(deviceUrl("espos-2be9.local", 80)).toBe("http://espos-2be9.local/");
  });
});
