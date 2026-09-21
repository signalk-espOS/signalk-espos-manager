import { api, isJobFinished, type DeviceDto } from "../api.js";
import { useStore } from "../store.js";

/** Human-readable reachability, since the raw words are jargon. */
function reachabilityLabel(device: DeviceDto): {
  text: string;
  tone: string;
} {
  switch (device.reachability) {
    case "online":
      return { text: "Online", tone: "ok" };
    case "stale":
      return { text: "Not answering just now", tone: "warn" };
    case "unreachable":
      return { text: "Found, but not responding", tone: "warn" };
    default:
      return { text: "Offline", tone: "off" };
  }
}

function authNote(device: DeviceDto): string | undefined {
  switch (device.auth) {
    case "needs-key":
      return "Needs an access key";
    case "locked-out":
      return "Too many failed key attempts — waiting before trying again";
    case "unknown":
      return device.hasKey ? "Key not yet checked" : undefined;
    default:
      return undefined;
  }
}

export function FleetPage() {
  const { fleet, mirror, jobs, go, act, refresh } = useStore();

  if (fleet === undefined) {
    return <p class="muted">Looking for espOS devices…</p>;
  }

  if (fleet.devices.length === 0) {
    return (
      <div class="card">
        <h2>No devices found yet</h2>
        <p class="muted">
          Devices announce themselves over mDNS. If one is on a different
          network segment, add its address under Plugin Config.
        </p>
        <button onClick={() => void act("Rescan", () => api.rescan())}>
          Look again
        </button>
      </div>
    );
  }

  return (
    <>
      <div class="toolbar">
        <span class="muted">
          {fleet.summary.online} of {fleet.summary.total} online
          {fleet.summary.updatesAvailable > 0 &&
            ` · ${fleet.summary.updatesAvailable} update(s) available`}
        </span>
        <span class="spacer" />
        {mirror !== undefined && mirror.mode === "upstream" && (
          <span class="pill warn" title={mirror.reason}>
            firmware not mirrored locally
          </span>
        )}
        <button onClick={() => void act("Rescan", () => api.rescan())}>
          Look again
        </button>
      </div>

      {jobs?.paused === true && (
        <div class="card warn">
          <strong>Updates are paused.</strong> {jobs.pausedReason}
          <div>
            <button onClick={() => void act("Resume", () => api.resumeJobs())}>
              Continue anyway
            </button>
          </div>
        </div>
      )}

      {fleet.warnings.map((warning) => (
        <div class="card warn" key={warning}>
          {warning}
        </div>
      ))}

      <ul class="devices">
        {fleet.devices.map((device) => {
          const state = reachabilityLabel(device);
          const note = authNote(device);
          const job = jobs?.jobs.find((j) => j.deviceId === device.id);
          return (
            <li class="card device" key={device.id}>
              <button
                class="device-main"
                onClick={() => go("device", device.id)}
              >
                <span class={`dot ${state.tone}`} aria-hidden="true" />
                <span class="device-name">
                  {device.hostname ?? device.id}
                  {!device.identified && (
                    <span class="pill" title="Not yet named by mDNS">
                      by address
                    </span>
                  )}
                </span>
                <span class="device-meta">
                  {device.app ?? "unknown firmware"}
                  {device.version !== undefined && ` ${device.version}`}
                  {device.target !== undefined && ` · ${device.target}`}
                </span>
                {/*
                    The board, not just the chip. "esp32p4" does not tell
                    anyone which panel this is, and two boards on that chip
                    take different firmware -- so the name is the useful fact.
                  */}
                {device.board !== undefined && (
                  <span class="device-meta muted">{device.board}</span>
                )}
                <span class="device-meta muted">
                  {device.addresses[0] ?? "no address"} · {state.text}
                  {device.esposVersion !== undefined &&
                    ` · espOS ${device.esposVersion}`}
                </span>
                {note !== undefined && <span class="pill warn">{note}</span>}
                {device.otaNeedsRepair === true && (
                  <span class="pill warn" title={device.otaRepairReason}>
                    not set up for updates
                  </span>
                )}
                {job !== undefined && !isJobFinished(job) && (
                  <span class="pill busy">
                    {job.state}
                    {job.progress !== undefined &&
                      job.progress.totalBytes > 0 &&
                      ` ${Math.round(
                        (job.progress.receivedBytes / job.progress.totalBytes) *
                          100,
                      )}%`}
                  </span>
                )}
              </button>
              {/*
                Sibling of the row button, not inside it: an <a> nested in a
                <button> is invalid HTML and browsers treat the click
                inconsistently. Opens the device's OWN espOS web UI -- WiFi,
                config, logs, core dump -- which is where you go for the
                things this plugin deliberately does not do.
              */}
              {device.addresses[0] !== undefined && (
                <a
                  class="device-open"
                  href={`http://${device.addresses[0]}${
                    device.port === 80 ? "" : `:${device.port}`
                  }/`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open this device's own web UI"
                  aria-label="Open this device's own web UI in a new tab"
                >
                  ↗
                </a>
              )}
            </li>
          );
        })}
      </ul>

      <p class="muted small">
        Devices are found over mDNS on this network. Nothing is changed on a
        device unless you ask.{" "}
        <button class="link" onClick={() => void refresh()}>
          Refresh now
        </button>
      </p>
    </>
  );
}
