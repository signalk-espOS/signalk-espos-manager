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

import type { FlashBuild, Target } from "./types.js";

/** The subset of the registry index this module reads. */
export interface CatalogueBuild {
  target: string;
  mergedUrl?: string;
  mergedBytes?: number;
  otaUrl?: string;
  boardId?: string;
  unsigned?: boolean;
}

export interface CatalogueRelease {
  version: string;
  channel: string;
  notesUrl?: string;
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
  /** Present exactly when `state === "flashable"`. */
  build?: FlashBuild;
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
 * Newest release first.
 *
 * Deliberately not a version comparison: the registry's CI emits releases in
 * order, and a full semver comparator here would be a second, divergent copy
 * of the one the server already has (`src/mirror/manifest.ts`). Order is the
 * registry's job; this module's job is not to reorder it.
 */
function releasesNewestFirst(project: CatalogueProject): CatalogueRelease[] {
  return project.releases ?? [];
}

/**
 * How this project stands for this board.
 *
 * Walks releases newest first and stops at the first one that says anything
 * definite about this board. A newer release that skipped the board must not
 * hide an older one that supports it — a project adding a second board does
 * not drop the first — so the walk continues past a release with nothing for
 * this chip at all.
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

  for (const release of releasesNewestFirst(project)) {
    const onTarget = release.builds.filter((b) => b.target === board.target);
    if (onTarget.length === 0) continue;

    // A build naming this board is unambiguous, and is the only case that can
    // be written.
    const named = onTarget.find((b) => b.boardId === board.id);
    if (named !== undefined) {
      if (named.mergedUrl !== undefined) {
        return {
          ...base,
          state: "flashable",
          build: {
            projectId: project.id,
            projectName: project.name,
            version: release.version,
            target: board.target as Target,
            mergedUrl: named.mergedUrl,
            mergedBytes: named.mergedBytes,
            boardId: named.boardId,
            unsigned: named.unsigned,
            boardName: board.name,
            summary: project.summary,
            repo: project.repo,
            notesUrl: release.notesUrl,
            official: project.official,
          },
        };
      }
      return {
        ...base,
        state: "ota-only",
        reason:
          `${release.version} ships only an over-the-air image for this ` +
          `board. That cannot start a blank board — it has to be installed ` +
          `from a device that is already running espOS.`,
      };
    }

    // A build that names no board is safe only where this chip has exactly one
    // board. Where several share it, one binary was built for one of them and
    // nothing in the release says which.
    const agnostic = onTarget.find((b) => b.boardId === undefined);
    if (agnostic !== undefined) {
      if (boardsOnTarget <= 1 && agnostic.mergedUrl !== undefined) {
        return {
          ...base,
          state: "flashable",
          build: {
            projectId: project.id,
            projectName: project.name,
            version: release.version,
            target: board.target as Target,
            mergedUrl: agnostic.mergedUrl,
            mergedBytes: agnostic.mergedBytes,
            boardId: undefined,
            unsigned: agnostic.unsigned,
            boardName: board.name,
            summary: project.summary,
            repo: project.repo,
            notesUrl: release.notesUrl,
            official: project.official,
          },
        };
      }
      if (boardsOnTarget > 1) {
        return {
          ...base,
          state: "ambiguous",
          reason:
            `${release.version} publishes one ${board.target} image that ` +
            `does not say which of this project's ${boardsOnTarget} ` +
            `${board.target} boards it was built for. Writing the wrong one ` +
            `usually leaves the screen black, so it is not offered here.`,
        };
      }
      return {
        ...base,
        state: "ota-only",
        reason:
          `${release.version} ships only an over-the-air image, which ` +
          `cannot start a blank board.`,
      };
    }
  }

  return {
    ...base,
    state: "none",
    reason:
      (project.releases ?? []).length === 0
        ? `${project.name} has not published any firmware yet.`
        : `${project.name} supports this board but has published no build ` +
          `for it.`,
  };
}

/**
 * Every board any project declares, each with what it can run.
 *
 * Boards are keyed by id across projects, because a board is a physical thing
 * and two projects supporting the same devkit is the normal case — a person
 * holding one C6 devkit should see one entry offering both, not the same board
 * twice. The first project to declare a board supplies its presentation: the
 * ids are the registry's own contract, so two entries sharing an id are the
 * same board, and a later project's wording for it is not more correct.
 */
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
