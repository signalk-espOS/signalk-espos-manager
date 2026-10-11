import { useStore } from "../store.js";
import { serialSupport } from "../flash/loader.js";
import {
  defaultBuilds,
  isPrerelease,
  type CatalogueProject,
} from "../flash/catalogue.js";
import type { FlashBuild } from "../flash/types.js";

/** Where the HTTPS-hosted copy of the flasher lives. */
const HOSTED_FLASHER =
  "https://signalk-espos.github.io/signalk-espos-manager/flash/";

/**
 * The same flasher, served by this plugin next to the webapp. It is one build
 * with the hosted copy, so a browser that may use USB here gets the same
 * start screen, board recognition and checks, reading this server's registry.
 * Absolute, like the build's base: a relative link breaks when the webapp is
 * opened without its trailing slash.
 */
const LOCAL_FLASHER = "/signalk-espos-manager/flash/";

export function FlashPage() {
  const { registry } = useStore();
  const support = serialSupport();

  const offered = defaultBuilds(
    (registry?.projects ?? []) as unknown as CatalogueProject[],
  );
  const label = (b: FlashBuild): string =>
    `${b.projectName} ${b.version}${isPrerelease(b) ? " (prerelease)" : ""} · ` +
    (b.boardName ?? b.target);

  return (
    <div class="card">
      <h2>Flashing a new board</h2>
      {support.supported ? (
        <>
          <p>
            Plug the board into this computer by USB, then open the flasher. It
            asks what the board should do, or recognises the board you plug in,
            and checks the firmware fits before anything is written.
          </p>
          <p>
            <a href={LOCAL_FLASHER} target="_blank" rel="noreferrer">
              Open the flasher
            </a>
          </p>
        </>
      ) : (
        <>
          <p>{support.reason}</p>
          {support.needsHttps && (
            <>
              <p class="muted small">
                Browsers only allow USB access from a secure page. Use the
                hosted flasher instead: it is the same page, and a brand-new
                board has no network connection to this server anyway.
              </p>
              <p>
                <a href={HOSTED_FLASHER} target="_blank" rel="noreferrer">
                  Open the hosted flasher
                </a>
              </p>
            </>
          )}
        </>
      )}
      {/* The flasher needs a browser with USB access, so the images themselves
          are always offered: a link is a normal download, which needs no
          CORS. */}
      {offered.length > 0 && (
        <>
          <p class="muted small">
            Or download an image and write it with <code>esptool</code>:
          </p>
          <ul class="projects">
            {offered.map((candidate) => (
              <li
                key={`${candidate.projectId}-${candidate.target}-${candidate.boardId ?? ""}`}
              >
                <a href={candidate.mergedUrl} rel="noreferrer">
                  {label(candidate)}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
