/**
 * The standalone flasher.
 *
 * One build serves two places. GitHub Pages hosts it on an https origin,
 * which matters because browsers only allow USB access from a secure page and
 * a Signal K server on a boat is almost always plain http on a LAN address.
 * The plugin serves the same page next to its webapp, which a browser lets
 * use USB on localhost or behind https.
 *
 * Served by the plugin, the page reads the plugin's merged registry, so it
 * offers the registries configured there and lists firmware from the plugin's
 * cached copy. The hosted copy needs no server at all, since a board being set
 * up for the first time has no network connection to one anyway: its firmware
 * list comes straight from the public registry, as does the plugin copy's when
 * the plugin's cannot be read.
 */

import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  allBuilds,
  boardCatalogue,
  esposLag,
  isPrerelease,
  targetsInCatalogue,
  type BoardEntry,
  type BoardOffer,
  type CatalogueBoard,
  type HardwareBoard,
  type UseCase,
} from "../src/flash/catalogue.js";
import { NothingSent, UseCaseList, UseCaseView } from "./start.js";
import {
  activeConnection,
  connect,
  disconnect,
  serialSupport,
  writeImage,
} from "../src/flash/loader.js";
import {
  leadingBoard,
  likelyBoards,
  type AppDescription,
  type LikelyBoard,
} from "../src/flash/fingerprint.js";
import { preflight, type PreflightReport } from "../src/flash/preflight.js";
import type { FlashBuild, Target } from "../src/flash/types.js";
import "../src/style.css";

const REGISTRY_URL =
  "https://raw.githubusercontent.com/signalk-espOS/registry/main/index.json";

/** The plugin's merged index, when this page is the copy the plugin serves. */
const PLUGIN_REGISTRY_URL = "/plugins/signalk-espos-manager/api/registry/index";

const HOSTED_ORIGIN = "https://signalk-espos.github.io";

interface RegistryBody {
  projects: RegistryProject[];
  esposLatest?: string;
  boards?: HardwareBoard[];
  useCases?: UseCase[];
}

async function fetchRegistry(url: string): Promise<RegistryBody> {
  // raw.githubusercontent sends max-age=300, and the browser's copy can
  // outlive GitHub's own, so a reload kept showing the previous release
  // after the index moved on. no-cache revalidates by ETag on every load;
  // GitHub's CDN may still lag the push by up to five minutes, which no
  // request header from a page can skip.
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as RegistryBody;
  if (!Array.isArray(body.projects)) throw new Error("not a registry index");
  return body;
}

/**
 * The plugin's index when the plugin serves this page, else the public one.
 * A plugin that refuses (no login, an older version without the route) falls
 * back too: the public list is still better than none.
 */
async function loadRegistry(): Promise<RegistryBody> {
  if (window.location.origin !== HOSTED_ORIGIN) {
    try {
      return await fetchRegistry(PLUGIN_REGISTRY_URL);
    } catch {
      // Fall through to the public registry.
    }
  }
  return fetchRegistry(REGISTRY_URL);
}

interface RegistryBuild {
  target: string;
  mergedUrl?: string;
  mergedBytes?: number;
  mergedWebUrl?: string;
  otaUrl?: string;
  boardId?: string;
  unsigned?: boolean;
}

interface RegistryProject {
  id: string;
  /** The firmware's project name, which its app description reports. */
  app: string;
  name: string;
  summary?: string;
  repo: string;
  official?: boolean;
  deprecated?: boolean | string;
  boards?: CatalogueBoard[];
  releases?: {
    version: string;
    channel: string;
    notesUrl?: string;
    espos?: string;
    builds: RegistryBuild[];
  }[];
}

/**
 * Which question the chooser answers.
 *
 * `board` is the default because it is the question someone has when they are
 * standing at the chart table with a board in hand and this page open. `build`
 * is the same data project-first, which is the better view once you know what
 * you want and are after a specific release.
 */
type Browse = "board" | "build";

/**
 * Where the chooser is. `start` asks what the board should do; `usecase` shows
 * the boards for one job; `list` is the full board or firmware list; `board`
 * is one board's card, reached from a job.
 */
type View =
  | { kind: "start" }
  | { kind: "usecase"; id: string }
  | { kind: "list" }
  | { kind: "board"; id: string; useCase: string };

/** The project publishes no URL a browser is allowed to read. */
class NoWebUrlError extends Error {
  constructor() {
    super("no browser-readable copy of this firmware is published");
    this.name = "NoWebUrlError";
  }
}

/** A response that arrived and said no, as opposed to one that never came. */
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

/**
 * The URL this page may actually fetch, or undefined.
 *
 * GitHub release downloads carry no Access-Control-Allow-Origin, so
 * `mergedUrl` is unusable from a browser however valid it looks. Only a
 * project that mirrors its images to a branch has a URL a page can read.
 * Returning undefined rather than falling back keeps the failure honest: the
 * fallback would always fail, and it would look like a network fault.
 */
function fetchableUrl(build: {
  mergedUrl: string;
  mergedWebUrl?: string;
}): string | undefined {
  return build.mergedWebUrl;
}

function mb(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What espOS runtime a build carries, and whether a newer one exists.
 *
 * Only says something when it has something to say: silent when the registry
 * could not establish the version, and silent when the build is current, so the
 * line appears exactly when it is worth reading.
 */
function EsposLine({
  build,
  latest,
}: {
  build: FlashBuild;
  latest: string | undefined;
}) {
  const lag = esposLag(build.espos, latest);
  if (build.espos === undefined) return null;
  if (lag === "behind") {
    return (
      <span class="muted small espos-line">
        Built with espOS {build.espos}; {latest} is out. A fix can land in the
        runtime rather than the firmware, so a newer release of this project may
        carry one even when its own version looks similar.
      </span>
    );
  }
  return <span class="muted small espos-line">espOS {build.espos}</span>;
}

/**
 * The versions other than the one the main button installs.
 *
 * Collapsed by default: the newest stable is what almost everyone wants, and a
 * list of five versions on every row turns the page into a changelog. It is
 * here at all because the two cases that need it are real -- rolling back past
 * a release that broke something, and deliberately testing a prerelease -- and
 * neither is served by a page that only ever offers the newest thing.
 */
function OtherVersions({
  offer,
  busy,
  onPick,
}: {
  offer: BoardOffer;
  busy: boolean;
  onPick: (b: FlashBuild) => void;
}) {
  const others = offer.builds.filter((b) => b.version !== offer.build?.version);
  if (others.length === 0) return null;
  return (
    <details class="other-versions small">
      <summary>
        {others.length === 1
          ? "1 other version"
          : `${others.length} other versions`}
      </summary>
      <ul>
        {others.map((b) => (
          <li key={b.version}>
            <button disabled={busy} onClick={() => onPick(b)}>
              {b.version}
            </button>
            {isPrerelease(b) && (
              <span
                class="pill warn"
                title="A prerelease. Offered for testing; expect it to be less tried than the stable release."
              >
                {b.channel ?? "prerelease"}
              </span>
            )}
            {b.unsigned === true && (
              <span class="pill warn" title="Built with a throwaway key.">
                unsigned
              </span>
            )}
            <span class="muted"> {mb(b.mergedBytes)}</span>
            {b.espos !== undefined && (
              <span class="muted"> · espOS {b.espos}</span>
            )}
            {b.notesUrl !== undefined && (
              <>
                {" "}
                <a href={b.notesUrl} target="_blank" rel="noreferrer">
                  notes
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Where to read more about a project.
 *
 * Shown for a board that cannot be flashed as well as one that can: a project
 * with nothing published for your board is exactly the case where you want its
 * repository, to see whether that is about to change.
 */
function OfferLinks({ offer }: { offer: BoardOffer }) {
  return (
    <span class="flash-links">
      <a
        href={`https://github.com/${offer.repo}`}
        target="_blank"
        rel="noreferrer"
      >
        Project
      </a>
      {offer.build?.notesUrl !== undefined && (
        <a href={offer.build.notesUrl} target="_blank" rel="noreferrer">
          Release notes
        </a>
      )}
    </span>
  );
}

/** Why a board was suggested, as the end of "…, because …". */
function clueText(likely: LikelyBoard, installed?: AppDescription): string {
  return likely.clues
    .map((clue) =>
      clue === "factory"
        ? `its maker's own firmware (${installed?.projectName ?? "demo"}) is on it`
        : clue === "espos"
          ? `it already runs ${likely.project ?? "espOS firmware"} made for this board`
          : "it has the same USB chip",
    )
    .join(" and ");
}

/**
 * One board and everything it can run.
 *
 * `prefer` puts the projects a use case named first, so someone who came for
 * Bluetooth sensors sees the gateway before the instrument panel the same
 * board also runs.
 */
function BoardEntryView({
  entry,
  matches,
  busy,
  esposLatest,
  onPick,
  prefer = [],
  likely,
  leading = false,
  installed,
}: {
  entry: BoardEntry;
  matches: boolean;
  busy: boolean;
  esposLatest: string | undefined;
  onPick: (b: FlashBuild) => void;
  prefer?: string[];
  /** Set when the connected board's fingerprint points here. */
  likely?: LikelyBoard;
  leading?: boolean;
  installed?: AppDescription;
}) {
  const offers = [...entry.offers].sort(
    (a, b) =>
      Number(!prefer.includes(a.projectId)) -
      Number(!prefer.includes(b.projectId)),
  );
  return (
    <li class={matches ? "board-entry matches" : "board-entry"}>
      {entry.image !== undefined && (
        <img
          class="board-photo"
          src={entry.image}
          alt={entry.name}
          title={entry.imageCredit}
          loading="lazy"
        />
      )}
      <div class="board-head">
        <span class="board-name">{entry.name}</span>
        {likely !== undefined && (
          <span
            class={leading ? "pill ok" : "pill"}
            title={`Suggested because ${clueText(likely, installed)}. Check the name against the board in front of you.`}
          >
            {leading ? "looks like yours" : "possible match"}
          </span>
        )}
        {matches && (
          <span
            class="pill ok"
            title="This board uses the chip you connected. Several different boards can share one chip, so check the name against the hardware in front of you."
          >
            matches your chip
          </span>
        )}
        <span class="muted small">{entry.target}</span>
        {entry.buyUrl !== undefined && (
          <a class="small" href={entry.buyUrl} target="_blank" rel="noreferrer">
            where to buy
          </a>
        )}
      </div>
      {entry.vendor !== undefined && (
        <p class="muted small">
          {entry.vendor}
          {entry.model !== undefined && ` · ${entry.model}`}
        </p>
      )}
      {entry.notes !== undefined && <p class="muted small">{entry.notes}</p>}
      <ul class="offers">
        {offers.map((offer, i) => (
          /* One project can reach a board twice, through its own entry and
           * another's runsOn, so the project alone is not a unique key. */
          <li key={`${offer.projectId}-${i}`}>
            {offer.state === "flashable" && offer.build !== undefined ? (
              <>
                <button
                  disabled={busy}
                  onClick={() => onPick(offer.build as FlashBuild)}
                >
                  <span class="flash-title">
                    {offer.projectName} {offer.build.version}
                    {offer.official === true && (
                      <span class="pill ok">official</span>
                    )}
                    {offer.support === "tested" && (
                      <span
                        class="pill ok"
                        title="The project has run this firmware on this board."
                      >
                        tested
                      </span>
                    )}
                    {isPrerelease(offer.build) && (
                      <span
                        class="pill warn"
                        title="This project has published no stable release for this board yet, so the newest prerelease is what is offered."
                      >
                        {offer.build.channel ?? "prerelease"}
                      </span>
                    )}
                    {offer.build.unsigned === true && (
                      <span
                        class="pill warn"
                        title="Built with a throwaway key: this board will not accept later updates over the air."
                      >
                        unsigned
                      </span>
                    )}
                  </span>
                  {offer.summary !== undefined && (
                    <span class="flash-summary">{offer.summary}</span>
                  )}
                  {/* An image built for another board entry, which runs on
                      this one too: say which, since a project can offer both. */}
                  {offer.build.boardId !== undefined &&
                    offer.build.boardId !== entry.id &&
                    offer.build.boardName !== undefined && (
                      <span class="flash-summary">
                        Image for {offer.build.boardName}
                      </span>
                    )}
                  <span class="flash-meta">{mb(offer.build.mergedBytes)}</span>
                </button>
                <EsposLine build={offer.build} latest={esposLatest} />
                {offer.boardNotes !== undefined && (
                  <span class="muted small offer-note">{offer.boardNotes}</span>
                )}
                {offer.note !== undefined && (
                  <span class="muted small offer-note">{offer.note}</span>
                )}
                <OtherVersions offer={offer} busy={busy} onPick={onPick} />
                <OfferLinks offer={offer} />
              </>
            ) : (
              <div class="offer-blocked">
                <span class="flash-title">
                  {offer.projectName}
                  <span class="pill">
                    {offer.state === "none"
                      ? "no firmware yet"
                      : offer.state === "ota-only"
                        ? "update only"
                        : "build not identified"}
                  </span>
                </span>
                {offer.reason !== undefined && (
                  <span class="muted small">{offer.reason}</span>
                )}
                {offer.boardNotes !== undefined && (
                  <span class="muted small">{offer.boardNotes}</span>
                )}
                <OfferLinks offer={offer} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

function App() {
  const support = serialSupport();
  const [projects, setProjects] = useState<RegistryProject[] | undefined>(
    undefined,
  );
  const [registryError, setRegistryError] = useState<string | undefined>(
    undefined,
  );
  /* The newest espOS runtime, so a build made against an older one can say so.
   * From the index, because a blank board cannot be asked. */
  const [esposLatest, setEsposLatest] = useState<string | undefined>(undefined);
  /* The registry's hardware catalogue and use cases. Empty in an index from
   * before they existed, which drops the page back to the plain board list. */
  const [hardware, setHardware] = useState<HardwareBoard[]>([]);
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [view, setView] = useState<View>({ kind: "start" });
  const [build, setBuild] = useState<FlashBuild | undefined>(undefined);
  const [report, setReport] = useState<PreflightReport | undefined>(undefined);
  const [head, setHead] = useState<Uint8Array | undefined>(undefined);
  const [chipName, setChipName] = useState<string | undefined>(undefined);
  const [nativeUsb, setNativeUsb] = useState(false);
  // What the chip says about itself, shown so someone can confirm the page is
  // talking to the board they think it is.
  const [profile, setProfile] = useState<
    | {
        description?: string;
        features?: string[];
        flashBytes?: number;
        flashSizeDetected: boolean;
        jedecId?: number;
        mac?: string;
        target?: Target;
        usbVid?: string;
        usbPid?: string;
        installed?: AppDescription;
      }
    | undefined
  >(undefined);
  const [progress, setProgress] = useState<
    { written: number; total: number; startedAt: number } | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [finished, setFinished] = useState(false);
  // Separate from `error`: a download that fails is not the same as the page
  // breaking, and it needs its own explanation because the cause is almost
  // always the same one and is not the user's fault.
  const [downloadError, setDownloadError] = useState<
    { message: string; blocked: boolean; noMirror: boolean } | undefined
  >(undefined);
  const [browse, setBrowse] = useState<Browse>("board");
  const [chipFilter, setChipFilter] = useState<Target | "all">("all");

  useEffect(() => {
    void (async () => {
      try {
        const body = await loadRegistry();
        setProjects(body.projects);
        setEsposLatest(body.esposLatest);
        setHardware(body.boards ?? []);
        setUseCases(body.useCases ?? []);
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
    imageHead: Uint8Array | undefined,
    board: string | undefined,
  ): void => {
    const connection = activeConnection();
    setReport(
      preflight({
        detectedTarget: connection?.target,
        buildTarget: chosen.target,
        detectedFlashBytes: connection?.flashBytes,
        flashSizeDetected: connection?.flashSizeDetected,
        imageBytes: chosen.mergedBytes ?? 0,
        imageHead,
        writeAddress: 0,
        candidateBoards: boardsFor(chosen),
        buildBoard: chosen.boardId,
        chosenBoard: board,
      }),
    );
  };

  /**
   * Connect and ask the board what it is, before any firmware is chosen.
   *
   * The list has five rows reading "ESP32-<x> development board", differing by
   * two characters in the middle, and the page already knows which chip is
   * plugged in -- so making someone find their own row unaided is a trap we
   * built. Identifying first turns the list into a short one.
   */
  const onIdentify = async (): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      const connection = await connect(() => {});
      setChipName(connection.chipName);
      setNativeUsb(connection.nativeUsb);
      setProfile({
        description: connection.chipDescription,
        features: connection.features,
        flashBytes: connection.flashBytes,
        flashSizeDetected: connection.flashSizeDetected,
        jedecId: connection.jedecId,
        mac: connection.mac,
        target: connection.target,
        usbVid: connection.usbVid,
        usbPid: connection.usbPid,
        installed: connection.installed,
      });
      // Narrow the list to what this board can actually run.
      if (connection.target !== undefined) setChipFilter(connection.target);
      setView({ kind: "list" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPick = async (chosen: FlashBuild): Promise<void> => {
    setBuild(chosen);
    setError(undefined);
    setDownloadError(undefined);
    setBusy(true);
    try {
      // Reuse the port if identify already opened it: a second
      // requestPort() prompt for a board we are already talking to is
      // confusing, and on some systems the first handle still holds the port.
      const connection = activeConnection() ?? (await connect(() => {}));
      setChipName(connection.chipName);
      setNativeUsb(connection.nativeUsb);
      setProfile({
        description: connection.chipDescription,
        features: connection.features,
        flashBytes: connection.flashBytes,
        flashSizeDetected: connection.flashSizeDetected,
        jedecId: connection.jedecId,
        mac: connection.mac,
        target: connection.target,
        usbVid: connection.usbVid,
        usbPid: connection.usbPid,
        installed: connection.installed,
      });

      // Check what the chip already told us BEFORE touching the network. The
      // chip and fit checks need no download, and they are the two that catch
      // the mistakes worth catching -- wrong board picked from the list, image
      // too big for this module. Fetching first meant a network failure threw
      // before any of them ran, so someone who clicked the wrong row was told
      // "failed to fetch" rather than "this is an ESP32-C5, that firmware is
      // for an ESP32".
      runChecks(chosen, undefined, undefined);

      // Only now read the image header, and treat failure as one more failed
      // check rather than an exception that discards the checks above.
      try {
        const url = fetchableUrl(chosen);
        if (url === undefined) {
          throw new NoWebUrlError();
        }
        const response = await fetch(url, {
          headers: { Range: "bytes=0-65535" },
        });
        if (!response.ok) {
          throw new HttpStatusError(response.status);
        }
        const imageHead = new Uint8Array(await response.arrayBuffer());
        setHead(imageHead);
        runChecks(chosen, imageHead, undefined);
      } catch (e) {
        setHead(undefined);
        // A server that answered tells us something specific; a request the
        // browser refused to make, or that never arrived, rejects with a
        // TypeError carrying no response at all. Only the second case is the
        // one the CORS explanation fits, and guessing wrong sends someone
        // looking in the wrong place.
        setDownloadError({
          message: e instanceof Error ? e.message : String(e),
          blocked: !(e instanceof HttpStatusError),
          noMirror: e instanceof NoWebUrlError,
        });
      }
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
      const url = fetchableUrl(build);
      if (url === undefined) throw new NoWebUrlError();
      const response = await fetch(url);
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

  const catalogue: BoardEntry[] = useMemo(
    () => boardCatalogue(projects ?? [], hardware),
    [projects, hardware],
  );
  const chips = useMemo(() => targetsInCatalogue(catalogue), [catalogue]);
  /* The guided start needs the registry's use cases; an older index has none
   * and gets the plain board list straight away. */
  const guided = useCases.length > 0;
  /* Only where the list it filters is on screen, or a write is under way. */
  const showIdentify = !guided || view.kind === "list" || build !== undefined;
  const openUseCase =
    view.kind === "usecase"
      ? useCases.find((u) => u.id === view.id)
      : undefined;
  const openBoard =
    view.kind === "board" ? catalogue.find((e) => e.id === view.id) : undefined;
  /* Boards the connected one looks like, strongest first. They lead the list
   * rather than replace it: every clue is a suggestion, and the owner still
   * checks the name against the board in front of them. */
  const likely = useMemo(
    () =>
      profile === undefined
        ? []
        : likelyBoards(
            {
              target: profile.target,
              flashBytes: profile.flashBytes,
              flashSizeDetected: profile.flashSizeDetected,
              usbVid: profile.usbVid,
              usbPid: profile.usbPid,
              installed: profile.installed,
            },
            hardware,
            projects ?? [],
          ),
    [profile, hardware, projects],
  );
  const lead = leadingBoard(likely);
  const leadEntry =
    lead === undefined ? undefined : catalogue.find((e) => e.id === lead.id);
  const rank = (id: string): number => {
    const at = likely.findIndex((l) => l.id === id);
    return at === -1 ? likely.length : at;
  };
  const shown = (
    chipFilter === "all"
      ? catalogue
      : catalogue.filter((entry) => entry.target === chipFilter)
  )
    .slice()
    .sort((a, b) => rank(a.id) - rank(b.id));

  /* Derived from the same catalogue as the board-first view, not projected
   * again from the registry. The hand-rolled copy this replaces had drifted in
   * three fields -- it never carried mergedWebUrl, so picking anything here
   * failed as "no browser-readable copy" even for a project that publishes a
   * mirror, and it carried neither the channel nor the espOS version, so betas
   * were unlabelled and the runtime line never appeared. One source, so the two
   * views cannot disagree about what a build is.
   *
   */
  /* Every offered version, including projects the board-first view cannot place
   * because they declare no boards. One implementation in the catalogue, so the
   * two views cannot disagree about what a build is -- only about which ones
   * they show. */
  const flashable: FlashBuild[] = useMemo(
    () => allBuilds(projects ?? []),
    [projects],
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
            {build?.projectName} {build?.version} has been written.
          </p>
          {/*
            The power cycle is first because it is the step people get stuck
            on. esptool-js resets the board after writing, but that reset is
            not always enough to get it out of the state the flash sequence
            left it in: a C5 written from this page showed no WiFi at all
            until it was unplugged and plugged back in. Telling someone to
            look for a network that is not there yet costs them far more time
            than one extra instruction.
          */}
          <ol class="next-steps">
            <li>
              <strong>Unplug the board and plug it back in.</strong> It was
              reset after writing, but a full power cycle is what reliably
              starts the new firmware.
            </li>
            <li>
              Look for a WiFi network named <code>espOS-</code> followed by four
              characters, and join it. It is open — no password.
            </li>
            <li>
              A setup page should open by itself. If it does not, go to{" "}
              <a href="http://192.168.4.1/" target="_blank" rel="noreferrer">
                http://192.168.4.1/
              </a>{" "}
              and tell the board about your own WiFi.
            </li>
            <li>
              Once it joins, the espOS Manager plugin on your Signal K server
              will find it.
            </li>
          </ol>
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
          {/* Identifying the chip answers "which board is this?", the second
              door. Someone still choosing what to buy has nothing to plug in. */}
          {showIdentify && (
            <div class="card">
              {chipName === undefined ? (
                <>
                  <p>
                    <button disabled={busy} onClick={() => void onIdentify()}>
                      Connect the board and identify it
                    </button>
                  </p>
                  <p class="muted small">
                    Optional, and much easier than finding your board in the
                    list: several boards differ only by a couple of characters
                    in their name. Identifying first shows only what this board
                    can run.
                  </p>
                </>
              ) : (
                <>
                  {profile?.installed !== undefined && (
                    <p class="small">
                      <strong>Already on it:</strong>{" "}
                      {profile.installed.projectName}{" "}
                      {profile.installed.version}
                    </p>
                  )}
                  {lead !== undefined && leadEntry !== undefined && (
                    <p>
                      This looks like a <strong>{leadEntry.name}</strong>,
                      because {clueText(lead, profile?.installed)}.
                    </p>
                  )}
                  <p class="muted small">
                    Showing boards that use the{" "}
                    <strong>{profile?.description ?? chipName}</strong> you
                    connected. Several boards can share one chip, so check the
                    name against the hardware in front of you before writing.
                  </p>
                  <p class="small">
                    <button
                      class="linkish"
                      onClick={() => {
                        setChipFilter("all");
                      }}
                    >
                      Show every board
                    </button>
                    {" · "}
                    <button
                      class="linkish"
                      onClick={() => {
                        void (async () => {
                          await disconnect();
                          setChipName(undefined);
                          setProfile(undefined);
                          setChipFilter("all");
                          setReport(undefined);
                          setBuild(undefined);
                        })();
                      }}
                    >
                      Identify another board
                    </button>
                  </p>
                </>
              )}
              <p class="muted small">
                Nothing is sent anywhere: the firmware downloads from GitHub
                straight to your browser, and your browser writes it to the
                board.
              </p>
            </div>
          )}

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

          {build === undefined && guided && view.kind === "start" ? (
            <UseCaseList
              useCases={useCases}
              onUseCase={(id) => setView({ kind: "usecase", id })}
              onHaveBoard={() => setView({ kind: "list" })}
            />
          ) : build === undefined && openUseCase !== undefined ? (
            <UseCaseView
              useCase={openUseCase}
              catalogue={catalogue}
              onBack={() => setView({ kind: "start" })}
              onBoard={(id) =>
                setView({ kind: "board", id, useCase: openUseCase.id })
              }
            />
          ) : build === undefined && view.kind === "board" ? (
            <div class="card">
              <p class="small">
                <button
                  class="linkish"
                  onClick={() => setView({ kind: "usecase", id: view.useCase })}
                >
                  ← Back
                </button>
              </p>
              {openBoard === undefined ? (
                <p class="muted">
                  No firmware in the registry lists this board yet.
                </p>
              ) : (
                <ul class="projects">
                  <BoardEntryView
                    entry={openBoard}
                    matches={activeConnection()?.target === openBoard.target}
                    busy={busy}
                    esposLatest={esposLatest}
                    onPick={(b) => void onPick(b)}
                    prefer={
                      useCases.find((u) => u.id === view.useCase)?.projects ??
                      []
                    }
                  />
                </ul>
              )}
            </div>
          ) : build === undefined ? (
            <div class="card">
              {guided && (
                <p class="small">
                  <button
                    class="linkish"
                    onClick={() => setView({ kind: "start" })}
                  >
                    ← What should your board do?
                  </button>
                </p>
              )}
              <div class="browse-head">
                <h3>
                  {browse === "board"
                    ? "Which board do you have?"
                    : "Choose firmware"}
                </h3>
                <button
                  class="linkish"
                  onClick={() => {
                    setBrowse(browse === "board" ? "build" : "board");
                  }}
                >
                  {browse === "board"
                    ? "Browse by firmware instead"
                    : "Browse by board instead"}
                </button>
              </div>

              {registryError !== undefined ? (
                <p class="muted">
                  Could not load the firmware list ({registryError}).
                </p>
              ) : projects === undefined ? (
                <p class="muted">Loading…</p>
              ) : browse === "board" ? (
                catalogue.length === 0 ? (
                  <p class="muted">
                    No project in the registry lists the boards it supports yet.
                  </p>
                ) : (
                  <>
                    {chips.length > 1 && (
                      <p class="chip-filter small">
                        <button
                          class={chipFilter === "all" ? "pill ok" : "pill"}
                          onClick={() => setChipFilter("all")}
                        >
                          all chips
                        </button>
                        {chips.map((chip) => (
                          <button
                            key={chip}
                            class={chipFilter === chip ? "pill ok" : "pill"}
                            onClick={() => setChipFilter(chip)}
                          >
                            {chip}
                          </button>
                        ))}
                      </p>
                    )}
                    <ul class="projects">
                      {shown.map((entry) => (
                        <BoardEntryView
                          key={entry.id}
                          entry={entry}
                          matches={activeConnection()?.target === entry.target}
                          busy={busy}
                          esposLatest={esposLatest}
                          onPick={(b) => void onPick(b)}
                          likely={likely.find((l) => l.id === entry.id)}
                          leading={lead?.id === entry.id}
                          installed={profile?.installed}
                        />
                      ))}
                    </ul>
                  </>
                )
              ) : flashable.length === 0 ? (
                <p class="muted">
                  No project publishes a full-flash image yet. Only those can be
                  written to a blank board.
                </p>
              ) : (
                <ul class="projects">
                  {flashable.map((candidate) => (
                    <li
                      key={`${candidate.projectId}-${candidate.version}-${candidate.target}-${
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
                          {isPrerelease(candidate) && (
                            <span
                              class="pill warn"
                              title="A prerelease. Offered for testing; expect it to be less tried than the stable release."
                            >
                              {candidate.channel ?? "prerelease"}
                            </span>
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
                      <EsposLine build={candidate} latest={esposLatest} />
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
                <div class="chip-profile small">
                  <p class="muted">
                    Connected to {profile?.description ?? chipName}
                    {nativeUsb && " over its native USB port"}.
                  </p>
                  <dl>
                    <div>
                      <dt>Flash</dt>
                      <dd>
                        {profile?.flashBytes === undefined
                          ? "could not be read"
                          : profile.flashSizeDetected
                            ? mb(profile.flashBytes)
                            : profile.jedecId === undefined
                              ? `${mb(profile.flashBytes)} assumed — the flash chip did not answer when asked to identify itself, so this is a fallback rather than a reading. Check the board's specification.`
                              : `${mb(profile.flashBytes)} assumed — this flash chip is not one we recognise (id 0x${profile.jedecId.toString(16).padStart(6, "0")})`}
                      </dd>
                    </div>
                    {profile?.features !== undefined &&
                      profile.features.length > 0 && (
                        <div>
                          <dt>Radios</dt>
                          <dd>{profile.features.join(" · ")}</dd>
                        </div>
                      )}
                    {profile?.mac !== undefined && (
                      <div>
                        <dt>MAC</dt>
                        <dd>{profile.mac}</dd>
                      </div>
                    )}
                  </dl>
                </div>
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

              {downloadError !== undefined && (
                <div class="card warn">
                  <p>
                    <strong>The firmware could not be downloaded.</strong>{" "}
                    Everything above was checked against the board itself and
                    still holds — this is about reaching the file, not about
                    your hardware.
                  </p>
                  <p class="muted small">
                    {downloadError.noMirror
                      ? `${build.projectName} does not publish a copy of its ` +
                        "firmware that a web page is allowed to download. " +
                        "GitHub serves release files without the header a " +
                        "browser needs, so this page cannot fetch them; the " +
                        "Signal K plugin can, because it downloads on the " +
                        "server."
                      : downloadError.blocked
                        ? "The browser would not complete the request. GitHub " +
                          "serves release downloads without the header a page " +
                          "needs to read them from another site, which is the " +
                          "usual cause; a dropped connection looks the same " +
                          "from here."
                        : `The server answered ${downloadError.message}.`}{" "}
                    Either way you can download{" "}
                    <a href={build.mergedUrl} target="_blank" rel="noreferrer">
                      {build.mergedUrl.split("/").pop()}
                    </a>{" "}
                    yourself and write it with <code>esptool</code>:
                  </p>
                  <pre class="small">
                    esptool --chip {build.target} write-flash 0x0{" "}
                    {build.mergedUrl.split("/").pop()}
                  </pre>
                </div>
              )}

              {report?.canWrite === true &&
                downloadError === undefined &&
                progress === undefined && (
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
