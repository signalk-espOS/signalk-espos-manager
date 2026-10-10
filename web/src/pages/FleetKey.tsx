import { useState } from "preact/hooks";
import { api, type FleetKeyChangeDto } from "../api.js";
import { useStore } from "../store.js";

const ACT_KEY = "fleet-key";

function describeChange(
  change: FleetKeyChangeDto,
  removed: boolean,
): string | undefined {
  if (removed) {
    return change.kept.length > 0
      ? `${change.kept.length} device(s) keep the removed key as their own ` +
          `key, so none is left unprotected.`
      : undefined;
  }
  const parts: string[] = [];
  if (change.updated.length > 0) {
    parts.push(`${change.updated.length} device(s) now use the new key.`);
  }
  if (change.kept.length > 0) {
    parts.push(
      `${change.kept.length} device(s) are offline or did not accept it yet ` +
        `and stay on their previous key; they are moved over once they answer.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * The fleet key: the one web login every espOS device on the boat can share.
 * Optional: devices with no key of their own set need none.
 */
export function FleetKeyCard() {
  const { fleet, act, acting, inlineErrors } = useStore();
  const [own, setOwn] = useState("");
  const [editing, setEditing] = useState(false);
  const [generated, setGenerated] = useState<string | undefined>();
  const [outcome, setOutcome] = useState<string | undefined>();

  const status = fleet?.fleetKey;
  if (status === undefined) return null;
  const busy = acting.includes(ACT_KEY);

  const run = (
    what: string,
    fn: () => Promise<FleetKeyChangeDto>,
    removed = false,
  ) =>
    act(
      what,
      async () => {
        setGenerated(undefined);
        setOutcome(undefined);
        const change = await fn();
        setGenerated(change.key);
        setOutcome(describeChange(change, removed));
        setOwn("");
        setEditing(false);
      },
      { errorInline: true, key: ACT_KEY },
    );

  return (
    <div class="card">
      <h3>Fleet key</h3>
      <p class="muted small">
        {status.set
          ? "A fleet key is set. Devices that ask for a key are contacted with it."
          : "No fleet key is set. That is fine while your devices have no key of their own; set one to protect their web pages and settings."}{" "}
        Replacing it also writes the new key to every device that is online and
        using the old one.
        {status.autoProvision &&
          " Devices with no key at all are given the fleet key automatically."}
      </p>

      {generated !== undefined && (
        <div class="card notice">
          <p>
            New fleet key: <code>{generated}</code>
          </p>
          <p class="muted small">
            Copy it now: a device's own web page asks for it. It can be read
            again under Plugin Config.
          </p>
        </div>
      )}
      {outcome !== undefined && <p class="small">{outcome}</p>}

      <div class="button-row">
        <button
          disabled={busy}
          onClick={() =>
            void run(
              status.set ? "Replace the fleet key" : "Generate a fleet key",
              () => api.generateFleetKey(),
            )
          }
        >
          {status.set ? "Generate a new key" : "Generate a key"}
        </button>
        <button disabled={busy} onClick={() => setEditing(!editing)}>
          Use my own key
        </button>
        {status.set && (
          <button
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  "Stop using the fleet key? Devices that use it keep it as " +
                    "their own key, so none is left unprotected.",
                )
              ) {
                return;
              }
              void run(
                "Remove the fleet key",
                () => api.removeFleetKey(),
                true,
              );
            }}
          >
            Remove
          </button>
        )}
      </div>

      {editing && (
        <div class="button-row">
          <input
            type="password"
            value={own}
            placeholder="8 to 64 characters"
            autocomplete="new-password"
            onInput={(e) => setOwn((e.target as HTMLInputElement).value)}
          />
          <button
            disabled={busy || own.trim() === ""}
            onClick={() =>
              void run("Set the fleet key", () => api.setFleetKey(own.trim()))
            }
          >
            Save
          </button>
        </div>
      )}

      {busy && <p class="muted small">Changing the key on your devices…</p>}
      {inlineErrors[ACT_KEY] !== undefined && (
        <p class="warn-text small" role="alert">
          Did not work: {inlineErrors[ACT_KEY]}
        </p>
      )}
    </div>
  );
}
