import { useEffect } from "preact/hooks";
import { useStore } from "./store.js";
import { FleetPage } from "./pages/Fleet.js";
import { StorePage } from "./pages/Store.js";
import { DevicePage } from "./pages/Device.js";

/** How often the fleet view re-reads the server while a page is open. */
const REFRESH_MS = 5000;

export function App() {
  const {
    page,
    refresh,
    loading,
    needsLogin,
    error,
    notice,
    dismiss,
    fleet,
    jobs,
    go,
  } = useStore();

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  if (needsLogin) {
    return (
      <main class="shell">
        <h1>espOS Manager</h1>
        <div class="card notice">
          <p>
            Managing devices needs an administrator login. Sign in to the Signal
            K admin interface, then reload this page.
          </p>
          <p>
            <a href="/admin/#/login">Go to the login page</a>
          </p>
        </div>
      </main>
    );
  }

  const running = (jobs?.jobs ?? []).filter(
    (job) => job.state !== "done" && job.state !== "failed",
  ).length;

  return (
    <main class="shell">
      <header>
        <h1>espOS Manager</h1>
        <nav>
          <button
            class={page === "fleet" ? "tab active" : "tab"}
            onClick={() => go("fleet")}
          >
            Devices{fleet !== undefined ? ` (${fleet.summary.total})` : ""}
          </button>
          <button
            class={page === "store" ? "tab active" : "tab"}
            onClick={() => go("store")}
          >
            Firmware
          </button>
          {running > 0 && <span class="pill busy">{running} updating</span>}
          {loading && <span class="pill">refreshing…</span>}
        </nav>
      </header>

      {error !== undefined && (
        <div class="card error" onClick={dismiss} role="alert">
          {error}
        </div>
      )}
      {notice !== undefined && (
        <div class="card notice" onClick={dismiss}>
          {notice}
        </div>
      )}

      {page === "fleet" && <FleetPage />}
      {page === "store" && <StorePage />}
      {page === "device" && <DevicePage />}
    </main>
  );
}
