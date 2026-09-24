/**
 * The firmware list, arranged the way someone holding a board thinks about it.
 *
 * The registry is organised by project, because that is how it is maintained:
 * one file per project, each listing the boards it supports. Someone who has
 * just unpacked a board has the opposite question — "this is what I own, what
 * can I run on it?" — and answering it from a project-shaped list means
 * reading every project to find the boards.
 *
 * So this module inverts the index: board first, then what each board can run.
 * It is pure and separate from the component for the same reason the resolver
 * on the server side is: the interesting part is which of several honest
 * answers a board gets, and that is worth testing directly rather than through
 * a rendered page.
 *
 * The four answers a board can get, and why each exists:
 *
 *   - `flashable`   — a full-flash image names this board. The only case where
 *                     a button can be offered.
 *   - `ota-only`    — the project publishes an over-the-air image but no
 *                     full-flash one for this board. It cannot start a blank
 *                     board, so offering it here would be a download that
 *                     ends in a rejected image.
 *   - `ambiguous`   — a full-flash image exists for this chip but does not say
 *                     which board it was built for, and this chip has more
 *                     than one board. Writing it is a coin toss; on the two
 *                     Waveshare panels the losing side is a black screen that
 *                     reads as dead hardware. Withheld deliberately.
 *   - `none`        — the project supports the board but has published nothing
 *                     for it yet. A real and common state: a project whose
 *                     release workflow has not run yet lists boards and no
 *                     builds at all.
 *
 * `none` is a state, not an omission. A board silently missing from the list
 * is indistinguishable from a board nobody supports, which sends someone off
 * to look for firmware that was never going to exist.
 */

/* The server's comparator, not a second one. It is pure (its only import is a
 * type) and it was verified against espOS's own espos_ota_version_cmp over
 * 3000 random pairs, so a local reimplementation could only be worse -- and a
 * flasher that orders versions differently from the device that installs them
 * is a bug waiting to happen. */
import { compareVersions } from "../../../src/mirror/version.js";
import type { FlashBuild, Target } from "./types.js";

/** The subset of the registry index this module reads. */
export interface CatalogueBuild {
  target: string;
  mergedUrl?: string;
  /**
   * The same image at a URL a browser may actually fetch.
   *
   * GitHub serves release downloads with no Access-Control-Allow-Origin, so
   * `mergedUrl` cannot be read from a web page at all -- only the plugin,
   * which fetches server-side, can use it. A project that mirrors its images
   * to a branch (`webAssetsBranch` in the registry) also gets this one, served
   * by raw.githubusercontent, which does send the header.
   */
  mergedWebUrl?: string;
  mergedBytes?: number;
  otaUrl?: string;
  boardId?: string;
  unsigned?: boolean;
}

export interface CatalogueRelease {
  version: string;
  channel: string;
  notesUrl?: string;
  /**
   * The espOS version this release was built against, when the registry could
   * establish it from the project's submodule pin. Absent for a project that
   * pinned an untagged commit, or one that does not use a submodule at all.
   */
  espos?: string;
  builds: CatalogueBuild[];
}

export interface CatalogueBoard {
  id: string;
  target: string;
  name: string;
  notes?: string;
  buyUrl?: string;
}

export interface CatalogueProject {
  id: string;
  name: string;
  summary?: string;
  repo: string;
  official?: boolean;
  deprecated?: boolean | string;
  boards?: CatalogueBoard[];
  releases?: CatalogueRelease[];
}

/**
 * Is this build a prerelease?
 *
 * Anything that is not "stable", rather than only "beta". The polarity matters:
 * today the registry emits exactly those two values, but a release's `channel`
 * is generated rather than schema-checked, and a `!== "beta"` test would make a
 * future "rc" the DEFAULT install rather than an opt-in. Wrong in this direction
 * hides a channel nobody publishes yet; wrong in the other hands someone a
 * prerelease they never asked for.
 *
 * An ABSENT channel is stable, so an index that omits the field keeps working
 * rather than treating every build as a prerelease.
 */
export function isPrerelease(build: { channel?: string }): boolean {
  return build.channel !== undefined && build.channel !== "stable";
}

/**
 * How a build's espOS runtime compares to the newest released one.
 *
 * Worth surfacing because a fix can land in the runtime rather than the
 * application: a firmware whose own version has not changed can still be
 * missing something, and nothing else on the page would show it. A flasher has
 * no other way to find out either -- it talks to a blank board, and an
 * unflashed board cannot be asked what it would have run.
 *
 * `unknown` when either side is missing, and it stays unknown rather than
 * guessing: a project that pinned an untagged espOS commit records no version,
 * and claiming it is current would be worse than saying nothing.
 */
export type EsposLag = "current" | "behind" | "ahead" | "unknown";

export function esposLag(
  buildEspos: string | undefined,
  latest: string | undefined,
): EsposLag {
  if (buildEspos === undefined || latest === undefined) return "unknown";
  const d = compareVersions(buildEspos, latest);
  if (d === 0) return "current";
  return d < 0 ? "behind" : "ahead";
}

export type OfferState = "flashable" | "ota-only" | "ambiguous" | "none";

/** One project, as offered for one specific board. */
export interface BoardOffer {
  projectId: string;
  projectName: string;
  summary?: string;
  repo: string;
  official?: boolean;
  deprecated?: boolean | string;
  state: OfferState;
  /** Why, in a sentence, for every state except `flashable`. */
  reason?: string;
  /**
   * Set when a release NEWER than anything offered here exists but cannot be
   * installed on this board -- an image that does not say which board it is
   * for, or one that ships no full-flash build.
   *
   * Without this the page silently offers an older version and looks stale to
   * anyone who knows a newer release shipped. The state stays `flashable`,
   * because something IS installable; this says what is being held back.
   */
  note?: string;
  /**
   * The version a click installs: the newest STABLE one, or the newest beta
   * only when there is no stable at all. Present exactly when
   * `state === "flashable"`.
   */
  build?: FlashBuild;
  /**
   * Every version installable on this board, newest first, betas ahead of
   * stable. Empty unless `state === "flashable"`.
   *
   * More than one because "the latest" is not the only thing someone needs:
   * a release can regress and rolling back is the first thing an owner reaches
   * for, and a project with a prerelease channel is worth offering to whoever
   * wants to test one.
   */
  builds: FlashBuild[];
}

/** A board someone might be holding, and everything it can run. */
export interface BoardEntry {
  id: string;
  target: Target;
  name: string;
  notes?: string;
  buyUrl?: string;
  offers: BoardOffer[];
  /** True when at least one project can be written to this board now. */
  anyFlashable: boolean;
}

/**
 * Newest release first, by the device's own ordering rules.
 *
 * This used to trust the order the registry emitted, on the grounds that its CI
 * writes releases newest-first and that a comparator here would be a second,
 * divergent copy of the server's. The first half held only by luck -- it depends
 * on what the GitHub releases API happens to return -- and the second stopped
 * applying once this module began sharing the server's own comparator rather
 * than reimplementing it.
 *
 * Sorting explicitly matters because the mistake is invisible: lexically
 * "1.10.0" sorts below "1.9.0", so an unsorted list silently offers the wrong
 * "newest" and nothing on screen looks wrong.
 */
function releasesNewestFirst(project: CatalogueProject): CatalogueRelease[] {
  return [...(project.releases ?? [])].sort((a, b) =>
    compareVersions(b.version, a.version),
  );
}

/**
 * Build a FlashBuild from one release's entry for this board.
 *
 * Only the fields the chooser and the writer need; the registry carries more.
 */
function toBuild(
  project: CatalogueProject,
  release: CatalogueRelease,
  board: CatalogueBoard,
  b: CatalogueBuild,
): FlashBuild {
  return {
    projectId: project.id,
    projectName: project.name,
    version: release.version,
    target: board.target as Target,
    mergedUrl: b.mergedUrl as string,
    mergedWebUrl: b.mergedWebUrl,
    mergedBytes: b.mergedBytes,
    boardId: b.boardId,
    unsigned: b.unsigned,
    channel: release.channel,
    espos: release.espos,
    /* Empty means "no board to name" -- allBuilds() passes a placeholder board
     * for a project that declares none. undefined, not "", so the page's
     * "any <chip> board" fallback fires: a `??` slips past an empty string and
     * renders a blank where the board name goes. */
    boardName: board.name === "" ? undefined : board.name,
    summary: project.summary,
    repo: project.repo,
    notesUrl: release.notesUrl,
    official: project.official,
  };
}

/**
 * How many of each channel to offer for one board.
 *
 * Three stable is enough to roll back past a bad release without turning the
 * list into a changelog -- the releases themselves remain the archive. Betas
 * are capped separately and only counted when they are NEWER than the newest
 * stable: an old prerelease that a stable release has already superseded is
 * noise, not a choice.
 */
const KEEP_STABLE = 3;
const KEEP_BETA = 2;

/**
 * How this project stands for this board, and every version it can install.
 *
 * Walks every release rather than stopping at the newest, because "the latest"
 * is not the only thing someone needs: a release can regress, and rolling back
 * is the first thing an owner reaches for. A project that ships a prerelease
 * channel is also worth offering to anyone who wants to test one -- labelled,
 * and never as the default.
 *
 * The state describes what can be installed. When nothing can, it carries the
 * reason from the newest release that explained itself. When something can but
 * a NEWER release cannot -- an unidentifiable image, or one with no full-flash
 * build -- that explanation survives as `note`, because a page that quietly
 * offers an older version looks broken to anyone who knows what shipped.
 */
function offerFor(
  project: CatalogueProject,
  board: CatalogueBoard,
  boardsOnTarget: number,
): BoardOffer {
  const base = {
    projectId: project.id,
    projectName: project.name,
    summary: project.summary,
    repo: project.repo,
    official: project.official,
    deprecated: project.deprecated,
  };

  const found: FlashBuild[] = [];
  /* The first definite-but-unusable answer, which is what the state reports.
   * Recorded once: a newer release explaining itself matters, an older one
   * repeating the same explanation does not. */
  let blocked:
    { state: OfferState; reason: string; version: string } | undefined;

  for (const release of releasesNewestFirst(project)) {
    const onTarget = release.builds.filter((b) => b.target === board.target);
    if (onTarget.length === 0) continue;

    // A build naming this board is unambiguous, and is the only case that can
    // be written.
    const named = onTarget.find((b) => b.boardId === board.id);
    if (named !== undefined) {
      if (named.mergedUrl !== undefined) {
        found.push(toBuild(project, release, board, named));
      } else if (blocked === undefined) {
        blocked = {
          state: "ota-only",
          version: release.version,
          reason:
            `${release.version} ships only an over-the-air image for this ` +
            `board. That cannot start a blank board — it has to be installed ` +
            `from a device that is already running espOS.`,
        };
      }
      continue;
    }

    // A build that names no board is safe only where this chip has exactly one
    // board. Where several share it, one binary was built for one of them and
    // nothing in the release says which.
    const agnostic = onTarget.find((b) => b.boardId === undefined);
    if (agnostic === undefined) continue;

    if (boardsOnTarget <= 1 && agnostic.mergedUrl !== undefined) {
      found.push(toBuild(project, release, board, agnostic));
    } else if (boardsOnTarget > 1) {
      if (blocked === undefined) {
        blocked = {
          state: "ambiguous",
          version: release.version,
          reason:
            `${release.version} publishes one ${board.target} image that ` +
            `does not say which of this project's ${boardsOnTarget} ` +
            `${board.target} boards it was built for. Writing the wrong one ` +
            `usually leaves the screen black, so it is not offered here.`,
        };
      }
    } else if (blocked === undefined) {
      blocked = {
        state: "ota-only",
        version: release.version,
        reason:
          `${release.version} ships only an over-the-air image, which ` +
          `cannot start a blank board.`,
      };
    }
  }

  if (found.length === 0) {
    if (blocked !== undefined) {
      return {
        ...base,
        state: blocked.state,
        reason: blocked.reason,
        builds: [],
      };
    }
    return {
      ...base,
      state: "none",
      builds: [],
      reason:
        (project.releases ?? []).length === 0
          ? `${project.name} has not published any firmware yet.`
          : `${project.name} supports this board but has published no build ` +
            `for it.`,
    };
  }

  /* Stable is the default, never a prerelease: someone who wants a beta can
   * pick one, and nobody should be handed one by accident. This mirrors npm,
   * where `latest` stays stable while a beta lives on its own tag. */
  /* Anything that is not "stable" is a prerelease, rather than only "beta".
   * The polarity matters: today the registry emits exactly those two values, but
   * `channel` on a release is generated rather than schema-checked, and a
   * `!== "beta"` test would make a future "rc" the DEFAULT install rather than
   * an opt-in. Wrong in that direction hands someone a prerelease they never
   * asked for; wrong in the other only hides a channel nobody publishes yet.
   *
   * An ABSENT channel stays stable, so an index that omits the field keeps
   * working instead of having every build treated as a prerelease. */
  const stable = found.filter((b) => !isPrerelease(b));
  const betas = found.filter(isPrerelease);
  const newestStable = stable[0];

  /* A beta only earns a place while it is ahead of the newest stable. Once a
   * stable release catches up, the prerelease it came from is history. */
  const aheadOfStable =
    newestStable === undefined
      ? betas
      : betas.filter(
          (b) => compareVersions(b.version, newestStable.version) > 0,
        );

  const builds = [
    ...aheadOfStable.slice(0, KEEP_BETA),
    ...stable.slice(0, KEEP_STABLE),
  ];
  const preferred = newestStable ?? builds[0];

  /* A newer release that cannot be installed here is information, not noise.
   * Dropping it made the page look stale to anyone who knew a newer version
   * had shipped, with nothing on screen to explain the gap. */
  const newest = builds[0];
  const note =
    blocked !== undefined &&
    newest !== undefined &&
    compareVersions(blocked.version, newest.version) > 0
      ? blocked.reason
      : undefined;

  return {
    ...base,
    state: "flashable",
    build: preferred,
    builds,
    note,
  };
}

export function boardCatalogue(projects: CatalogueProject[]): BoardEntry[] {
  const byId = new Map<string, BoardEntry>();

  for (const project of projects) {
    const boards = project.boards ?? [];
    for (const board of boards) {
      const boardsOnTarget = boards.filter(
        (b) => b.target === board.target,
      ).length;
      const offer = offerFor(project, board, boardsOnTarget);

      const existing = byId.get(board.id);
      if (existing === undefined) {
        byId.set(board.id, {
          id: board.id,
          target: board.target as Target,
          name: board.name,
          notes: board.notes,
          buyUrl: board.buyUrl,
          offers: [offer],
          anyFlashable: offer.state === "flashable",
        });
      } else {
        existing.offers.push(offer);
        existing.anyFlashable ||= offer.state === "flashable";
      }
    }
  }

  // Boards with something to install first, then by name. Someone scanning
  // the list is looking for their own board, so the order inside each group is
  // alphabetical rather than by project or chip — but a board that can do
  // nothing today should not sit above one that can.
  return [...byId.values()]
    .map((entry) => ({
      ...entry,
      // Within a board: what can be flashed, then what is explained.
      offers: [...entry.offers].sort((a, b) => rank(a.state) - rank(b.state)),
    }))
    .sort((a, b) => {
      if (a.anyFlashable !== b.anyFlashable) return a.anyFlashable ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function rank(state: OfferState): number {
  switch (state) {
    case "flashable":
      return 0;
    case "ambiguous":
      return 1;
    case "ota-only":
      return 2;
    case "none":
      return 3;
  }
}

/**
 * Boards grouped by chip, for a filter control.
 *
 * The chip is the one fact a person can read off the board itself when they do
 * not recognise the product name, so it is the useful filter even though it is
 * not the useful primary key.
 */
export function targetsInCatalogue(entries: BoardEntry[]): Target[] {
  const seen = new Set<Target>();
  for (const entry of entries) seen.add(entry.target);
  return [...seen].sort();
}

/**
 * Every installable build, for the firmware-first view.
 *
 * Not `boardCatalogue(...).flatMap(...)`, for two reasons that only show up at
 * the edges:
 *
 *   - `boards` is optional in the registry schema, so a project may declare
 *     none. The board-first view cannot place such a project at all -- there is
 *     no board to file it under -- and deriving this list from that one made it
 *     invisible in BOTH views, which is worse than the duplicate row the
 *     board-first view was built to remove.
 *   - this view exists for someone who already knows what they want and is
 *     after a particular release, so it lists every offered version rather than
 *     just the default one.
 *
 * Still one implementation: it reuses `offerFor` through the catalogue for the
 * placed case, so the two views cannot disagree about what a build IS. They
 * differ only in which builds they show, which is the point of having two.
 */
export function allBuilds(projects: CatalogueProject[]): FlashBuild[] {
  const out: FlashBuild[] = [];
  for (const entry of boardCatalogue(projects)) {
    for (const offer of entry.offers) out.push(...offer.builds);
  }
  /* Projects the board-first view could not place. A synthetic board name is
   * deliberately NOT invented: the row says the chip, and the chooser's own
   * checks still refuse a wrong-chip write. */
  for (const project of projects) {
    if ((project.boards ?? []).length > 0) continue;
    for (const release of releasesNewestFirst(project)) {
      for (const b of release.builds) {
        if (b.mergedUrl === undefined) continue;
        out.push(
          toBuild(project, release, { id: "", target: b.target, name: "" }, b),
        );
      }
    }
  }
  return out;
}
