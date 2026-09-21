import { useState } from "preact/hooks";
import { api, isJobFinished } from "../api.js";
import { useStore } from "../store.js";

function bytes(value: number | undefined): string {
  if (value === undefined) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function uptime(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function DevicePage() {
  const { fleet, selectedDevice, available, jobs, go, act } = useStore();
  const [key, setKey] = useState("");

  const device = fleet?.devices.find((d) => d.id === selectedDevice);
  if (device === undefined) {
    return (
      <div class="card">
        <p>That device is no longer in the list.</p>
        <button onClick={() => go("fleet")}>Back to devices</button>
      </div>
    );
  }

  const offer = available[device.id];
  const job = jobs?.jobs.find((j) => j.deviceId === device.id);
  const busy = job !== undefined && !isJobFinished(job);

  return (
    <>
      <button class="link" onClick={() => go("fleet")}>
        ← All devices
      </button>

      <div class="card">
        <h2>{device.hostname ?? device.id}</h2>
        <dl class="facts">
          <dt>Firmware</dt>
          <dd>
            {device.app ?? "unknown"} {device.version ?? ""}
          </dd>
          {device.esposVersion !== undefined && (
            <>
              <dt>espOS</dt>
              <dd>{device.esposVersion}</dd>
            </>
          )}
          <dt>Address</dt>
          <dd>
            {device.addresses.join(", ") || "unknown"}
            {device.port !== 80 && `:${device.port}`}
          </dd>
          {device.chip !== undefined && (
            <>
              <dt>Chip</dt>
              <dd>{device.chip}</dd>
            </>
          )}
          {/*
            Board on its own row rather than tacked onto Chip: it is the
            answer to "what hardware is this", and the vendor/model string is
            long enough that sharing a line with the chip truncates it.
          */}
          {device.board !== undefined && (
            <>
              <dt>Board</dt>
              <dd>{device.board}</dd>
            </>
          )}
          {device.mac !== undefined && (
            <>
              <dt>MAC</dt>
              <dd>{device.mac}</dd>
            </>
          )}
          {(device.flashBytes !== undefined ||
            device.psramBytes !== undefined) && (
            <>
              <dt>Memory</dt>
              <dd>
                {device.flashBytes !== undefined &&
                  `${Math.round(device.flashBytes / 1048576)} MB flash`}
                {device.flashBytes !== undefined &&
                  device.psramBytes !== undefined &&
                  " · "}
                {device.psramBytes !== undefined &&
                  `${Math.round(device.psramBytes / 1048576)} MB PSRAM`}
              </dd>
            </>
          )}
          {device.uptimeS !== undefined && (
            <>
              <dt>Running for</dt>
              <dd>{uptime(device.uptimeS)}</dd>
            </>
          )}
          {device.freeHeap !== undefined && (
            <>
              <dt>Free memory</dt>
              <dd>{bytes(device.freeHeap)}</dd>
            </>
          )}
          <dt>Found via</dt>
          <dd>{device.sources.join(", ")}</dd>
        </dl>
        {device.lastError !== undefined && (
          <p class="muted small">Last problem: {device.lastError}</p>
        )}
      </div>

      {device.auth === "needs-key" && (
        <div class="card warn">
          <h3>This device needs an access key</h3>
          <p class="muted small">
            It is configured to require a key and the one we have was refused.
            Enter the key from the device's own settings page. It is tried once
            — espOS locks out repeated wrong attempts.
          </p>
          <input
            type="password"
            value={key}
            placeholder="Access key"
            onInput={(e) => setKey((e.target as HTMLInputElement).value)}
          />
          <button
            disabled={key.trim() === ""}
            onClick={() =>
              void act("Save key", async () => {
                await api.setKey(device.id, key.trim());
                setKey("");
              })
            }
          >
            Save and try it
          </button>
        </div>
      )}

      {device.otaNeedsRepair === true && (
        <div class="card warn">
          <h3>Not set up for updates</h3>
          <p class="muted small">{device.otaRepairReason}</p>
          <button
            onClick={() =>
              void act("Point this device at the server", () =>
                api.configureOta(device.id),
              )
            }
          >
            Fix this
          </button>
        </div>
      )}

      <div class="card">
        <h3>Firmware updates</h3>
        {busy && job !== undefined ? (
          <div>
            <p>
              <strong>{job.state}</strong>
              {job.devicePhase !== undefined && ` · ${job.devicePhase}`} —{" "}
              {job.fromVersion} → {job.toVersion}
            </p>
            {job.progress !== undefined && job.progress.totalBytes > 0 && (
              <progress
                max={job.progress.totalBytes}
                value={job.progress.receivedBytes}
              />
            )}
            {job.state === "rebooting" && (
              <p class="muted small">
                The device is restarting. It will not answer for a moment — that
                is expected.
              </p>
            )}
            {job.state === "confirming" && job.confirmBy !== undefined && (
              <p class="muted small">
                Waiting to confirm. If nothing confirms it, the device rolls
                back to the previous firmware on its own.
              </p>
            )}
            {job.state === "queued" && (
              <button
                onClick={() =>
                  void act("Cancel", () => api.cancelJob(device.id))
                }
              >
                Cancel
              </button>
            )}
          </div>
        ) : offer === undefined ? (
          <p class="muted">Checking…</p>
        ) : offer.build === undefined ? (
          <p class="muted">{offer.reason ?? "No update available."}</p>
        ) : (
          <div>
            <p>
              <strong>{offer.build.version}</strong> is available
              {offer.build.otaBytes !== undefined &&
                ` (${bytes(offer.build.otaBytes)})`}
              {offer.project !== undefined && ` · ${offer.project.name}`}
            </p>
            {offer.build.notes !== undefined && (
              <p class="notes">{offer.build.notes}</p>
            )}
            {offer.build.notesUrl !== undefined && (
              <p class="small">
                <a href={offer.build.notesUrl} target="_blank" rel="noreferrer">
                  Release notes
                </a>
              </p>
            )}
            {offer.requiresUsb === true ? (
              <p class="warn-text">
                {offer.reason ??
                  "This update cannot be installed over the air."}
              </p>
            ) : (
              <>
                {offer.needsConfirmation === true && (
                  <p class="warn-text small">
                    This device is running {device.version}, which is not a
                    released version — installing {offer.build.version} may
                    replace newer code with older.
                  </p>
                )}
                <button
                  onClick={() =>
                    void act(`Install ${offer.build?.version ?? ""}`, () =>
                      api.update(device.id, offer.needsConfirmation === true),
                    )
                  }
                >
                  {offer.needsConfirmation === true
                    ? "Install anyway"
                    : "Install update"}
                </button>
              </>
            )}
          </div>
        )}

        {job !== undefined && job.state === "failed" && (
          <p class="warn-text small">Last attempt failed: {job.error}</p>
        )}
        {job !== undefined && job.state === "rolled-back" && (
          <p class="warn-text small">{job.error}</p>
        )}

        <details>
          <summary class="small muted">Advanced</summary>
          <p class="small muted">
            Confirm keeps a freshly installed image; roll back returns to the
            previous one. The device does both on its own when it needs to.
          </p>
          <button
            onClick={() =>
              void act("Confirm image", () => api.confirm(device.id))
            }
          >
            Confirm current image
          </button>
          <button
            onClick={() => void act("Roll back", () => api.rollback(device.id))}
          >
            Roll back
          </button>
          <button
            onClick={() =>
              void act("Forget device", async () => {
                await api.forget(device.id);
                go("fleet");
              })
            }
          >
            Forget this device
          </button>
        </details>
      </div>
    </>
  );
}
