/**
 * URL of a device's own web UI.
 *
 * A bare IPv6 address must be bracketed or the colons read as a port separator
 * and the link is silently broken. Discovery unwraps IPv4-mapped form
 * (`::ffff:1.2.3.4`) but passes a real IPv6 address through, so one can reach
 * here. Detected by the colon rather than by parsing: anything containing a
 * colon is not a hostname or an IPv4 address.
 *
 * Its own module rather than living in the page, so it can be tested without
 * importing the component tree (and with it Zustand, and with that React).
 */
/**
 * On a demo server, the device's web UI as the virtual device it is: espOS's
 * demo build, shipped in this package, picked by the firmware's app name
 * (`ble_gateway` opens the `ble-gateway` device) and showing the version
 * listed here.
 */
export function demoDeviceUrl(
  app: string | undefined,
  version: string | undefined,
): string {
  const query = new URLSearchParams();
  if (app !== undefined) query.set("device", app.replace(/_/g, "-"));
  if (version !== undefined) query.set("version", version);
  return `/signalk-espos-manager/device-demo/?${query.toString()}`;
}

export function deviceUrl(address: string, port: number): string {
  const host = address.includes(":") ? `[${address}]` : address;
  return `http://${host}${port === 80 ? "" : `:${port}`}/`;
}
