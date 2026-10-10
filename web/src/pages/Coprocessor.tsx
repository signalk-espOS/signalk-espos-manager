import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, type CoprocessorDto, type DeviceDto } from "../api.js";
import { useStore } from "../store.js";

const RUNNING: readonly CoprocessorDto["state"][] = [
  "downloading",
  "verifying",
  "writing",
  "restarting",
];

// The device restarts at the end and is back within a minute or two; past
// this, polling a device that stays silent only keeps a stale phase on screen.
const SILENT_LIMIT_MS = 5 * 60 * 1000;

const PHASE: Record<CoprocessorDto["state"], string> = {
  idle: "",
  downloading: "Downloading the radio firmware",
  verifying: "Checking it is the expected image",
  writing: "Writing it to the radio chip",
  restarting: "Restarting the device",
  failed: "",
};

/**
 * The radio co-processor (the C6 beside a P4) runs its own firmware, which
 * esp_hosted on the main chip expects at a matching version. espOS flashes it
 * over the link between the two; this card starts that and follows it.
 */
export function CoprocessorCard({ device }: { device: DeviceDto }) {
  // Mounted with key={device.id}, so all of this belongs to one device.
  const { act, acting, inlineErrors } = useStore();
  const [status, setStatus] = useState<CoprocessorDto>();
  const [problem, setProblem] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);
  // Set once this page has seen an update run, so "behind" turning false
  // afterwards reads as the success it is rather than the card vanishing.
  const [ran, setRan] = useState(false);
  const [lost, setLost] = useState(false);
  const lastAnswer = useRef(0);

  const stale = device.coprocessor?.stale === true;
  const running =
    status !== undefined && RUNNING.includes(status.state) && !lost;
  const key = `coprocessor:${device.id}`;

  const load = async (quietOnError: boolean): Promise<void> => {
    try {
      const next = await api.coprocessor(device.id);
      lastAnswer.current = Date.now();
      setStatus(next);
      setProblem(undefined);
      setUnsupported(false);
      setLost(false);
      if (RUNNING.includes(next.state)) setRan(true);
    } catch (error) {
      // Mid-update the device restarts and stops answering for a while; that
      // is the expected end of the update, not a problem to report.
      if (quietOnError) return;
      setUnsupported(error instanceof ApiError && error.status === 404);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (stale) void load(false);
  }, [stale]);

  useEffect(() => {
    if (!running) return;
    lastAnswer.current = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastAnswer.current > SILENT_LIMIT_MS) {
        setLost(true);
        setProblem(
          "the device has not answered for five minutes; check that it is powered and on the network",
        );
        return;
      }
      void load(true);
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);

  if (!stale) {
    return ran ? (
      <div class="card">
        <h3>Radio co-processor</h3>
        <p>
          Updated
          {device.coprocessor?.version !== undefined &&
            ` to ${device.coprocessor.version}`}
          .
        </p>
      </div>
    ) : null;
  }

  const have = device.coprocessor?.version;
  const want = status?.image?.version ?? device.coprocessor?.hostVersion;
  // Back up after the restart, but the device list still has the reading
  // from before it; the next poll replaces it.
  const settling = ran && status?.state === "idle";

  return (
    <div class="card warn">
      <h3>Radio co-processor needs an update</h3>
      <p class="muted small">
        The radio chip that handles WiFi and Bluetooth runs its own firmware
        {have !== undefined && have !== "0.0.0" && ` (${have})`}, which is older
        than the {want ?? "version"} this device's firmware expects. Updating
        takes a minute or two and restarts the device. If it is interrupted, the
        radio keeps its current firmware.
      </p>
      {running && status !== undefined ? (
        <>
          <p>
            <strong>{PHASE[status.state]}…</strong>
          </p>
          {status.total !== undefined && status.total > 0 && (
            <progress max={status.total} value={status.done ?? 0} />
          )}
          {status.state === "restarting" && (
            <p class="muted small">
              The device will not answer for a moment — that is expected.
            </p>
          )}
        </>
      ) : unsupported ? (
        <p class="muted small">{problem}</p>
      ) : (
        <>
          {settling && (
            <p class="small">
              The update finished and the device restarted. Waiting for it to
              report its new radio firmware…
            </p>
          )}
          {problem !== undefined && (
            <p class="warn-text small">
              Could not read the update status: {problem}
            </p>
          )}
          {status?.state === "failed" && (
            <p class="warn-text small">
              Last attempt failed: {status.error ?? "no reason given"}
            </p>
          )}
          <button
            disabled={
              (status === undefined && problem === undefined) ||
              acting.includes(key)
            }
            onClick={() =>
              void act(
                "Start the radio co-processor update",
                async () => {
                  await api.updateCoprocessor(device.id);
                  setRan(true);
                  await load(false);
                },
                { errorInline: true, key },
              )
            }
          >
            {acting.includes(key)
              ? "Starting…"
              : settling
                ? "Update again"
                : "Update radio co-processor"}
          </button>
        </>
      )}
      {inlineErrors[key] !== undefined && (
        <p class="warn-text small" role="alert">
          Did not start: {inlineErrors[key]}
        </p>
      )}
    </div>
  );
}
