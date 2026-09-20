import { api } from "../api.js";
import { useStore } from "../store.js";

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function StorePage() {
  const { registry, fleet, mirror, act } = useStore();

  if (registry === undefined) {
    return <p class="muted">Loading the firmware list…</p>;
  }

  // Which projects are relevant to the hardware actually on this boat.
  const runningApps = new Set(
    (fleet?.devices ?? [])
      .map((d) => d.app)
      .filter((a): a is string => a !== undefined),
  );
  const targets = new Set(
    (fleet?.devices ?? [])
      .map((d) => d.target)
      .filter((t): t is string => t !== undefined),
  );

  return (
    <>
      <div class="toolbar">
        <span class="muted">
          {registry.projects.length} project(s)
          {registry.stale && " · showing the last copy fetched"}
        </span>
        <span class="spacer" />
        <button
          onClick={() =>
            void act("Refresh firmware list", () => api.refreshRegistry())
          }
        >
          Refresh
        </button>
      </div>

      {registry.stale && (
        <div class="card warn">
          The firmware list could not be fetched
          {registry.reason !== undefined && `: ${registry.reason}`}. Showing the
          last copy that was downloaded, which is what makes this work at
          anchor.
        </div>
      )}

      {registry.warnings.map((warning) => (
        <div class="card warn" key={warning}>
          {warning}
        </div>
      ))}

      {registry.projects.length === 0 && (
        <div class="card">
          <p>No firmware projects are listed yet.</p>
        </div>
      )}

      <ul class="projects">
        {registry.projects.map((project) => {
          const installed = runningApps.has(project.app);
          const compatible = project.targets.some((t) => targets.has(t));
          const latest = project.releases?.[0];
          return (
            <li class="card" key={project.id}>
              <h3>
                <span>{project.name}</span>
                {project.official === true && (
                  <span
                    class="pill"
                    title="Maintained by the signalk-espOS project"
                  >
                    official
                  </span>
                )}
                {installed && <span class="pill ok">installed</span>}
                {project.deprecated !== undefined &&
                  project.deprecated !== false && (
                    <span class="pill warn">no longer maintained</span>
                  )}
              </h3>
              {project.summary !== undefined && <p>{project.summary}</p>}
              <p class="muted small">
                {latest !== undefined
                  ? `Latest ${latest.version}`
                  : "No release yet"}
              </p>

              {/*
                Boards by name, not by chip. "esp32p4" tells nobody which
                panel to buy, and it does not tell an owner whether the thing
                on their desk is supported. Each board says whether firmware
                for it is actually published, because a supported board with
                no build is a real and common state.
              */}
              {(project.boards ?? []).length > 0 && (
                <ul class="boards small">
                  {(project.boards ?? []).map((board) => {
                    // Look across every published release, not just the
                    // newest: a board whose firmware shipped in an earlier
                    // release is still supported, and saying "no firmware
                    // yet" about it is simply wrong.
                    const builds = (project.releases ?? []).flatMap((r) =>
                      (r.builds ?? []).filter((b) => b.target === board.target),
                    );
                    const named = builds.some((b) => b.boardId === board.id);
                    const ambiguous =
                      builds.some((b) => b.boardId === undefined) &&
                      (project.boards ?? []).filter(
                        (o) => o.target === board.target,
                      ).length > 1;
                    return (
                      <li key={board.id}>
                        <span class="board-name">{board.name}</span>{" "}
                        {named ? (
                          <span class="pill ok">firmware available</span>
                        ) : ambiguous ? (
                          <span
                            class="pill warn"
                            title="The published build does not say which board it was made for, so it cannot be offered safely."
                          >
                            build not identified
                          </span>
                        ) : builds.length > 0 ? (
                          <span class="pill ok">firmware available</span>
                        ) : (
                          <span class="pill">no firmware yet</span>
                        )}
                        {board.buyUrl !== undefined && (
                          <>
                            {" "}
                            <a
                              href={board.buyUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              where to buy
                            </a>
                          </>
                        )}
                        {board.notes !== undefined && (
                          <div class="muted">{board.notes}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {latest === undefined && (
                // "installed" plus "nothing published" reads as a
                // contradiction unless the reason is stated: the project is
                // real and running, it just has no downloadable release.
                <p class="muted small">
                  {installed
                    ? "Running on this boat, but the project has not published " +
                      "a downloadable release yet, so it cannot be updated " +
                      "from here."
                    : "No downloadable release has been published yet."}
                </p>
              )}
              {!installed && !compatible && (
                <p class="muted small">
                  Needs hardware this boat does not have.
                </p>
              )}
              <p class="small">
                <a
                  href={`https://github.com/${project.repo}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Project page
                </a>
                {latest?.notesUrl !== undefined && (
                  <>
                    {" · "}
                    <a href={latest.notesUrl} target="_blank" rel="noreferrer">
                      Release notes
                    </a>
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ul>

      {mirror !== undefined && (
        <div class="card">
          <h3>Firmware kept on this server</h3>
          {mirror.mode === "upstream" ? (
            <p class="muted small">
              Firmware is not being mirrored{" "}
              {mirror.reason !== undefined && `(${mirror.reason})`}. Devices
              will be pointed at the internet instead, so updates will not work
              at anchor.
            </p>
          ) : mirror.files.length === 0 ? (
            <p class="muted small">
              Nothing downloaded yet. Firmware is fetched when you install an
              update, so it is then available offline.
            </p>
          ) : (
            <>
              <p class="muted small">
                {bytes(mirror.cachedBytes)} in {mirror.files.length} file(s) —
                available without an internet connection.
              </p>
              <ul class="small muted">
                {mirror.files.map((file) => (
                  <li key={`${file.app}/${file.version}/${file.filename}`}>
                    {file.app} {file.version} · {bytes(file.sizeBytes)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
