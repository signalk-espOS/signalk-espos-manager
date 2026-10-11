/**
 * What a running device is, in the words the flasher used to sell it: the
 * catalogue board (vendor, model, photo) and the jobs its firmware does there.
 *
 * Labels only. Nothing here picks a build, so where the answer is unsure it is
 * left out rather than guessed: a device shown as the wrong product is worse
 * than one shown by its chip.
 */

import { boardIdFromReport, projectForApp } from "./resolve.js";
import type { HardwareBoard, RegistryBoard, RegistryIndex } from "./types.js";

export interface DeviceHardware {
  board?: HardwareBoard;
  useCases: { id: string; title: string }[];
}

/** The catalogue boards a project board's image runs on. */
function runsOn(board: RegistryBoard): string[] {
  // Index content, so not trusted to be the array the type says.
  const raw: unknown = board.runsOn;
  if (!Array.isArray(raw)) return [board.id];
  const ids = raw.filter((id): id is string => typeof id === "string");
  return ids.length > 0 ? ids : [board.id];
}

export function hardwareFor(
  index: RegistryIndex,
  app: string | undefined,
  reported: string | undefined,
): DeviceHardware {
  if (app === undefined) return { useCases: [] };
  const project = projectForApp(index, app);
  if (project === undefined) return { useCases: [] };

  const boardId = boardIdFromReport(project.boards, reported);
  const entry = project.boards?.find((b) => b.id === boardId);
  // The boards this device may be: the one its report names, or, when it
  // names none, any its firmware runs on.
  const candidates = new Set(
    entry !== undefined
      ? runsOn(entry)
      : (project.boards ?? []).flatMap(runsOn),
  );
  // One image for several boards cannot say which of them this is.
  const board =
    candidates.size === 1 && entry !== undefined
      ? index.boards?.find((b) => candidates.has(b.id))
      : undefined;

  // A job is claimed only when every board this may be does it: the cockpit
  // on a board without CAN is no NMEA 2000 gateway.
  const useCases = (index.useCases ?? [])
    .filter((useCase) => useCase.projects.includes(project.id))
    .filter((useCase) => {
      const listed = useCase.boards.filter((b) => candidates.has(b.id));
      return listed.length > 0 && listed.every((b) => b.fits !== false);
    })
    .map(({ id, title }) => ({ id, title }));

  return { board, useCases };
}
