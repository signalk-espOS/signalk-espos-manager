/**
 * The flasher's start screen, for someone who does not know what they need.
 *
 * Two ways in, because owners arrive with one of two questions: "I want my
 * Bluetooth sensors in Signal K, what do I buy?" and "I have this board, what
 * can it do?". Both end on one board's card, where the firmware is.
 *
 * The registry does the judging: it ranks each use case's boards (boards with
 * what the job needs first, then those the project tested, then the most
 * downloaded), so this page only presents that order and never re-sorts it.
 */

import type {
  BoardEntry,
  UseCase,
  UseCaseBoard,
} from "../src/flash/catalogue.js";

export function NothingSent() {
  return (
    <p class="muted small">
      Nothing is sent anywhere: the firmware downloads from GitHub straight to
      your browser, and your browser writes it to the board.
    </p>
  );
}

/** The jobs, as cards, plus the door for someone who already has a board. */
export function UseCaseList({
  useCases,
  onUseCase,
  onHaveBoard,
}: {
  useCases: UseCase[];
  onUseCase: (id: string) => void;
  onHaveBoard: () => void;
}) {
  return (
    <div class="card">
      <h3>What should your board do?</h3>
      <ul class="usecases">
        {useCases.map((uc) => (
          <li key={uc.id}>
            <button class="usecase" onClick={() => onUseCase(uc.id)}>
              <span class="flash-title">
                {uc.title}
                {uc.projects.length === 0 && <span class="pill">coming</span>}
              </span>
              <span class="flash-summary">{uc.summary}</span>
            </button>
          </li>
        ))}
        <li>
          <button class="usecase" onClick={onHaveBoard}>
            <span class="flash-title">I already have a board</span>
            <span class="flash-summary">
              Find it in the list, or plug it in and let this page identify the
              chip, and see what it can run.
            </span>
          </button>
        </li>
      </ul>
      <NothingSent />
    </div>
  );
}

/** One job: what it is, and the boards that do it, best first. */
export function UseCaseView({
  useCase,
  catalogue,
  onBack,
  onBoard,
}: {
  useCase: UseCase;
  catalogue: BoardEntry[];
  onBack: () => void;
  onBoard: (id: string) => void;
}) {
  const entries = new Map(catalogue.map((e) => [e.id, e]));
  return (
    <div class="card">
      <p class="small">
        <button class="linkish" onClick={onBack}>
          ← All jobs
        </button>
      </p>
      <h3>{useCase.title}</h3>
      <p>{useCase.summary}</p>
      {useCase.description !== undefined && (
        <p class="muted small">{useCase.description}</p>
      )}
      {useCase.boards.length === 0 ? (
        <p class="muted">
          No firmware does this yet. It is listed so you know it is planned.
        </p>
      ) : (
        <>
          <p class="muted small">
            Boards that do this, the best choice first. Pick one to see the
            firmware and where to buy it.
          </p>
          <ul class="board-tiles">
            {useCase.boards.map((b, i) => (
              <li key={b.id}>
                <BoardTile
                  board={b}
                  entry={entries.get(b.id)}
                  first={i === 0}
                  onClick={() => onBoard(b.id)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function BoardTile({
  board,
  entry,
  first,
  onClick,
}: {
  board: UseCaseBoard;
  entry: BoardEntry | undefined;
  first: boolean;
  onClick: () => void;
}) {
  return (
    <button class="board-tile" onClick={onClick}>
      {entry?.image !== undefined && (
        <img src={entry.image} alt="" loading="lazy" />
      )}
      <span class="flash-title">
        {board.name}
        {first && board.fits !== false && entry?.anyFlashable === true && (
          <span class="pill ok">best choice</span>
        )}
        {board.support === "tested" && <span class="pill ok">tested</span>}
        {board.fits === false && (
          <span
            class="pill warn"
            title="This board lacks something the job needs, so it takes extra hardware."
          >
            needs an add-on
          </span>
        )}
      </span>
      {entry?.vendor !== undefined && (
        <span class="muted small">
          {entry.vendor}
          {entry.model !== undefined && ` · ${entry.model}`}
        </span>
      )}
      {board.reason !== undefined && (
        <span class="flash-summary">{board.reason}</span>
      )}
    </button>
  );
}
