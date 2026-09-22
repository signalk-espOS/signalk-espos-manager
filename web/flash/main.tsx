/**
 * The standalone flasher.
 *
 * This is the same flashing code the plugin ships, hosted on GitHub Pages so
 * it runs from an https origin. That matters because browsers only allow USB
 * access from a secure page, and a Signal K server on a boat is almost always
 * plain http on a LAN address — so the copy inside the plugin cannot flash
 * anything there and links here instead.
 *
 * It deliberately has no dependency on a running server: a board being set up
 * for the first time has no network connection to one anyway. The firmware
 * list comes straight from the public registry.
 */

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  activeConnection,
  connect,
  disconnect,
  serialSupport,
  writeImage,
} from "../src/flash/loader.js";
import { preflight, type PreflightReport } from "../src/flash/preflight.js";
import type { FlashBuild, Target } from "../src/flash/types.js";
import "../src/style.css";

const REGISTRY_URL =
  "https://raw.githubusercontent.com/signalk-espOS/registry/main/index.json";

interface RegistryBuild {
  target: string;
  mergedUrl?: string;
  mergedBytes?: number;
  boardId?: string;
  unsigned?: boolean;
}

interface RegistryProject {
  id: string;
  name: string;
  summary?: string;
  repo: string;
  official?: boolean;
  boards?: { id: string; name: string; target: string; notes?: string }[];
  releases?: {
    version: string;
    channel: string;
    notesUrl?: string;
    builds: RegistryBuild[];
  }[];
}

function mb(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function App() {
  const support = serialSupport();
  const [projects, setProjects] = useState<RegistryProject[] | undefined>(
    undefined,
  );
  const [registryError, setRegistryError] = useState<string | undefined>(
    undefined,
  );
  const [build, setBuild] = useState<FlashBuild | undefined>(undefined);
  const [report, setReport] = useState<PreflightReport | undefined>(undefined);
  const [head, setHead] = useState<Uint8Array | undefined>(undefined);
  const [chipName, setChipName] = useState<string | undefined>(undefined);
  const [nativeUsb, setNativeUsb] = useState(false);
  const [progress, setProgress] = useState<
    { written: number; total: number; startedAt: number } | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(REGISTRY_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { projects: RegistryProject[] };
        setProjects(body.projects);
      } catch (e) {
        setRegistryError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const boardsFor = (chosen: FlashBuild): { id: string; name: string }[] => {
    const project = (projects ?? []).find((p) => p.id === chosen.projectId);
    return (project?.boards ?? [])
      .filter((b) => b.target === chosen.target)
      .map((b) => ({ id: b.id, name: b.name }));
  };

  const runChecks = (
    chosen: FlashBuild,
    imageHead: Uint8Array,
    board: string | undefined,
  ): void => {
    const connection = activeConnection();
    setReport(
      preflight({
        detectedTarget: connection?.target,
        buildTarget: chosen.target,
        detectedFlashBytes: connection?.flashBytes,
        imageBytes: chosen.mergedBytes ?? 0,
        imageHead,
        writeAddress: 0,
        candidateBoards: boardsFor(chosen),
        buildBoard: chosen.boardId,
        chosenBoard: board,
      }),
    );
  };

  const onPick = async (chosen: FlashBuild): Promise<void> => {
    setBuild(chosen);
    setError(undefined);
    setBusy(true);
    try {
      const connection = await connect(() => {});
      setChipName(connection.chipName);
      setNativeUsb(connection.nativeUsb);
      const response = await fetch(chosen.mergedUrl, {
        headers: { Range: "bytes=0-65535" },
      });
      if (!response.ok) {
        throw new Error(
          `Could not read the firmware header: HTTP ${response.status}`,
        );
      }
      const imageHead = new Uint8Array(await response.arrayBuffer());
      setHead(imageHead);
      runChecks(chosen, imageHead, undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onWrite = async (): Promise<void> => {
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
      // Clear the progress bar as well as showing the error: every control —
      // including "try again" — is hidden while a write looks to be running,
      // so leaving it set strands the user with a message and no way out.
      setProgress(undefined);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await disconnect();
    }
  };

  const flashable: FlashBuild[] = (projects ?? []).flatMap((project) =>
    (project.releases ?? []).slice(0, 1).flatMap((release) =>
      release.builds
        .filter((b) => b.mergedUrl !== undefined)
        .map((b) => ({
          projectId: project.id,
          projectName: project.name,
          version: release.version,
          target: b.target as Target,
          mergedUrl: b.mergedUrl as string,
          mergedBytes: b.mergedBytes,
          boardId: b.boardId,
          unsigned: b.unsigned,
          // The board this image is FOR. Without it two variants of one
          // release are indistinguishable, which is how this list came to
          // show "P4 Cockpit 1.3.1 · esp32p4" twice.
          boardName: (project.boards ?? []).find((x) => x.id === b.boardId)
            ?.name,
          summary: project.summary,
          repo: project.repo,
          notesUrl: release.notesUrl,
          official: project.official,
        })),
    ),
  );

  return (
    <main class="shell">
      <header>
        <h1>Flash an espOS board</h1>
      </header>

      {!support.supported ? (
        <div class="card">
          <p>{support.reason}</p>
          <p class="muted small">
            Web Serial works in Chrome, Edge and other Chromium browsers. On
            Firefox or Safari, download the firmware and write it with{" "}
            <code>esptool</code> instead.
          </p>
        </div>
      ) : finished ? (
        <div class="card">
          <h2>Done</h2>
          <p>
            {build?.projectName} {build?.version} has been written and the board
            has restarted.
          </p>
          <p class="muted small">
            It has no network settings yet. Connect to the board's own WiFi
            network to tell it about yours. Once it joins, the espOS Manager
            plugin on your Signal K server will find it.
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
      ) : (
        <>
          <div class="card">
            <p class="muted small">
              Connect the board by USB and pick its firmware. Nothing is sent
              anywhere: the firmware downloads from GitHub straight to your
              browser, and your browser writes it to the board.
            </p>
          </div>

          {error !== undefined && (
            <div
              class="card error"
              onClick={() => {
                setError(undefined);
              }}
            >
              {error}
            </div>
          )}

          {build === undefined ? (
            <div class="card">
              <h3>Choose firmware</h3>
              {registryError !== undefined ? (
                <p class="muted">
                  Could not load the firmware list ({registryError}).
                </p>
              ) : projects === undefined ? (
                <p class="muted">Loading…</p>
              ) : flashable.length === 0 ? (
                <p class="muted">
                  No project publishes a full-flash image yet. Only those can be
                  written to a blank board.
                </p>
              ) : (
                <ul class="projects">
                  {flashable.map((candidate) => (
                    <li
                      key={`${candidate.projectId}-${candidate.target}-${
                        candidate.boardId ?? "any"
                      }`}
                      class="flash-choice"
                    >
                      <button
                        disabled={busy}
                        onClick={() => void onPick(candidate)}
                      >
                        <span class="flash-title">
                          {candidate.projectName} {candidate.version}
                          {candidate.official === true && (
                            <span class="pill ok">official</span>
                          )}
                          {candidate.unsigned === true && (
                            <span
                              class="pill warn"
                              title="Built with a throwaway key: this board will not accept later updates over the air."
                            >
                              unsigned
                            </span>
                          )}
                        </span>
                        {/* The board is the thing a buyer recognises. */}
                        <span class="flash-board">
                          {candidate.boardName ??
                            (candidate.boardId !== undefined
                              ? candidate.boardId
                              : `any ${candidate.target} board`)}
                        </span>
                        {candidate.summary !== undefined && (
                          <span class="flash-summary">{candidate.summary}</span>
                        )}
                        <span class="flash-meta">
                          {candidate.target}
                          {candidate.mergedBytes !== undefined &&
                            ` · ${mb(candidate.mergedBytes)}`}
                        </span>
                      </button>
                      <span class="flash-links">
                        {candidate.repo !== undefined && (
                          <a
                            href={`https://github.com/${candidate.repo}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Project
                          </a>
                        )}
                        {candidate.notesUrl !== undefined && (
                          <a
                            href={candidate.notesUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Release notes
                          </a>
                        )}
                      </span>
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
                <div class="small">
                  <p class="muted">Which board is this?</p>
                  {boardsFor(build).map((board) => (
                    <button
                      key={board.id}
                      onClick={() => {
                        if (head !== undefined)
                          runChecks(build, head, board.id);
                      }}
                    >
                      {board.name}
                    </button>
                  ))}
                </div>
              )}

              {progress !== undefined && (
                <div>
                  <progress max={progress.total} value={progress.written} />
                  <p class="muted small">
                    {mb(progress.written)} of {mb(progress.total)} — do not
                    unplug the board.
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
      )}

      <p class="muted small">
        Part of{" "}
        <a href="https://github.com/signalk-espOS/signalk-espos-manager">
          signalk-espos-manager
        </a>
        . Firmware comes from the{" "}
        <a href="https://github.com/signalk-espOS/registry">espOS registry</a>.
      </p>
    </main>
  );
}

const root = document.getElementById("app");
if (root !== null) render(<App />, root);
