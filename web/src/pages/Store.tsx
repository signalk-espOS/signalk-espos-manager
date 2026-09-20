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
                {project.targets.join(", ")}
                {latest !== undefined && ` · latest ${latest.version}`}
              </p>
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
