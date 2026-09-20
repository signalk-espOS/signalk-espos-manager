import { useState } from "preact/hooks";
import { useStore } from "../store.js";
import {
  connect,
  disconnect,
  serialSupport,
  writeImage,
} from "../flash/loader.js";
import { preflight, type PreflightReport } from "../flash/preflight.js";
import type { FlashBuild, Target } from "../flash/types.js";

/** Where the HTTPS-hosted copy of this page lives. */
const HOSTED_FLASHER =
  "https://signalk-espos.github.io/signalk-espos-manager/flash/";

function mb(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FlashPage() {
  const { registry, mirror } = useStore();
  const support = serialSupport();

  const [build, setBuild] = useState<FlashBuild | undefined>(undefined);
  const [report, setReport] = useState<PreflightReport | undefined>(undefined);
  const [chosenBoard, setChosenBoard] = useState<string | undefined>(undefined);
  const [chipName, setChipName] = useState<string | undefined>(undefined);
  const [nativeUsb, setNativeUsb] = useState(false);
  const [progress, setProgress] = useState<
    { written: number; total: number; startedAt: number } | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [finished, setFinished] = useState(false);

  // Only builds that ship a full-flash image can go on a blank board.
  const flashable: FlashBuild[] = (registry?.projects ?? []).flatMap(
    (project) =>
      (project.releases ?? []).slice(0, 1).flatMap((release) => {
        const raw = release as unknown as {
          version: string;
          builds?: {
            target: string;
            mergedUrl?: string;
            mergedBytes?: number;
            boardId?: string;
            unsigned?: boolean;
          }[];
        };
        return (raw.builds ?? [])
          .filter((b) => b.mergedUrl !== undefined)
          .map((b) => ({
            projectId: project.id,
            projectName: project.name,
            version: raw.version,
            target: b.target as Target,
            mergedUrl: b.mergedUrl as string,
            mergedBytes: b.mergedBytes,
            boardId: b.boardId,
            unsigned: b.unsigned,
          }));
      }),
  );

  if (!support.supported) {
    return (
      <div class="card">
        <h2>Flashing a new board</h2>
        <p>{support.reason}</p>
        {support.needsHttps ? (
          <>
            <p class="muted small">
              Browsers only allow USB access from a secure page. Use the hosted
              flasher instead — it does the same thing, and a brand-new board
              has no network connection to this server anyway.
            </p>
            <p>
              <a href={HOSTED_FLASHER} target="_blank" rel="noreferrer">
                Open the hosted flasher
              </a>
            </p>
          </>
        ) : (
          <p class="muted small">
            You can also download the firmware and write it with{" "}
            <code>esptool</code> from a terminal.
          </p>
        )}
      </div>
    );
  }

  const onConnect = async (chosen: FlashBuild) => {
    setError(undefined);
    setBusy(true);
    try {
      const connection = await connect(() => {});
      setChipName(connection.chipName);
      setNativeUsb(connection.nativeUsb);

      // Fetch only the head first: enough to tell a full-flash image from an
      // update image without pulling 15 MB to find out.
      const head = await fetch(chosen.mergedUrl, {
        headers: { Range: "bytes=0-65535" },
      });
      const imageHead = new Uint8Array(await head.arrayBuffer());

      setReport(
        preflight({
          detectedTarget: connection.target,
          buildTarget: chosen.target,
          detectedFlashBytes: connection.flashBytes,
          imageBytes: chosen.mergedBytes ?? 0,
          imageHead,
          writeAddress: 0,
          buildBoard: chosen.boardId,
          chosenBoard,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onWrite = async () => {
    if (build === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(build.mergedUrl);
      if (!response.ok)
        throw new Error(`Download failed: HTTP ${response.status}`);
      const image = await response.arrayBuffer();
      const startedAt = Date.now();
      await writeImage({
        image,
        onProgress: (written, total) => {
          setProgress({ written, total, startedAt });
        },
        log: () => {},
      });
      setFinished(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await disconnect();
    }
  };

  if (finished) {
    return (
      <div class="card">
        <h2>Done</h2>
        <p>
          {build?.projectName} {build?.version} has been written and the board
          has restarted.
        </p>
        <p class="muted small">
          It has no network settings yet. Connect to the board's own WiFi
          network to tell it about your boat's network — once it joins, it
          appears in the device list here.
        </p>
        <button
          onClick={() => {
            setFinished(false);
            setBuild(undefined);
            setReport(undefined);
            setProgress(undefined);
          }}
        >
          Flash another board
        </button>
      </div>
    );
  }

  return (
    <>
      <div class="card">
        <h2>Flashing a new board</h2>
        <p class="muted small">
          For a board that has never been on your network. Connect it by USB,
          pick the firmware, and this writes it directly.
          {mirror?.mode === "mirror" &&
            " Firmware already on this server is used when possible."}
        </p>
      </div>

      {error !== undefined && (
        <div class="card error" onClick={() => setError(undefined)}>
          {error}
        </div>
      )}

      {build === undefined ? (
        <div class="card">
          <h3>Choose firmware</h3>
          {flashable.length === 0 ? (
            <p class="muted">
              No project publishes a full-flash image yet. Only those can be
              written to a blank board.
            </p>
          ) : (
            <ul class="projects">
              {flashable.map((candidate) => (
                <li key={`${candidate.projectId}-${candidate.target}`}>
                  <button
                    onClick={() => {
                      setBuild(candidate);
                      void onConnect(candidate);
                    }}
                  >
                    {candidate.projectName} {candidate.version} ·{" "}
                    {candidate.target}
                    {candidate.mergedBytes !== undefined &&
                      ` · ${mb(candidate.mergedBytes)}`}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div class="card">
          <h3>
            {build.projectName} {build.version}
          </h3>
          {chipName !== undefined && (
            <p class="muted small">
              Connected to {chipName}
              {nativeUsb && " over its native USB port"}.
            </p>
          )}

          {busy && progress === undefined && <p class="muted">Checking…</p>}

          {report !== undefined && (
            <ul class="checks">
              {report.checks.map((check) => (
                <li key={check.id} class={check.ok ? "ok" : "warn-text"}>
                  {check.ok ? "✓" : "✗"} {check.message}
                </li>
              ))}
            </ul>
          )}

          {report?.needsChoice === true && (
            <p class="small">
              <button
                onClick={() => {
                  setChosenBoard("confirmed");
                  void onConnect(build);
                }}
              >
                I have checked which board this is
              </button>
            </p>
          )}

          {build.unsigned === true && (
            <p class="warn-text small">
              This build is unsigned: the board will not accept over-the-air
              updates afterwards.
            </p>
          )}

          {progress !== undefined && (
            <div>
              <progress max={progress.total} value={progress.written} />
              <p class="muted small">
                {mb(progress.written)} of {mb(progress.total)} —{" "}
                {Math.round((Date.now() - progress.startedAt) / 1000)}s elapsed.
                Do not unplug the board.
              </p>
            </div>
          )}

          {report?.canWrite === true && progress === undefined && (
            <button disabled={busy} onClick={() => void onWrite()}>
              Write firmware to this board
            </button>
          )}

          {progress === undefined && (
            <button
              onClick={() => {
                setBuild(undefined);
                setReport(undefined);
                void disconnect();
              }}
            >
              Choose something else
            </button>
          )}
        </div>
      )}
    </>
  );
}
