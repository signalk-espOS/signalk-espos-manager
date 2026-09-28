/**
 * View state that must survive a route round-trip.
 *
 * Component `useState` resets when a component unmounts — open a device, go
 * back, and the selection is gone, which users read as "it lost my place".
 * Zustand is what the Signal K admin UI itself uses, so this adds no new
 * concept to the stack.
 */

import { create } from "zustand";
import {
  api,
  ApiError,
  loginStatus,
  type AvailableDto,
  type FleetDto,
  type JobsDto,
  type MirrorDto,
  type RegistryDto,
} from "./api.js";

export type Page = "fleet" | "store" | "device" | "flash";

export interface ActOptions {
  /**
   * Report a failure beside the control that started it rather than in the
   * banner at the top of the page, which is off-screen on a long device page.
   */
  errorInline?: boolean;
  /**
   * Identifies the action for `acting` and `inlineError`. Defaults to the
   * label, which is shown to people and need not be unique -- a key built
   * from a device id keeps one device's action off another's page.
   */
  key?: string;
}

interface ManagerState {
  page: Page;
  selectedDevice?: string;
  fleet?: FleetDto;
  mirror?: MirrorDto;
  registry?: RegistryDto;
  jobs?: JobsDto;
  available: Record<string, AvailableDto>;
  loading: boolean;
  /** Set when the API says we are not an administrator. */
  needsLogin: boolean;
  /** Why the last background refresh failed; cleared by the next one. */
  loadError?: string;
  /**
   * The outcome of the last action. Kept apart from loadError so the 5 s
   * refresh cannot clear it: it did, and a failed action was on screen for
   * about two seconds -- which reads as the button doing nothing at all.
   */
  error?: string;
  notice?: string;
  /** A failed action that asked for its error beside its control. */
  inlineError?: { key: string; message: string };
  /** Key of the action running now, so its control can show it is busy. */
  acting?: string;
  lastRefresh?: number;

  go: (page: Page, deviceId?: string) => void;
  refresh: () => Promise<void>;
  loadAvailable: (id: string) => Promise<void>;
  act: (
    what: string,
    fn: () => Promise<unknown>,
    options?: ActOptions,
  ) => Promise<void>;
  dismiss: () => void;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const useStore = create<ManagerState>((set, get) => ({
  page: "fleet",
  available: {},
  loading: false,
  needsLogin: false,

  go: (page, deviceId) => {
    set({
      page,
      selectedDevice: deviceId,
      notice: undefined,
      error: undefined,
      inlineError: undefined,
    });
    if (page === "device" && deviceId !== undefined) {
      void get().loadAvailable(deviceId);
    }
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const status = await loginStatus();
      if (!status.loggedIn) {
        // Not an error: the webapp is reachable without a login by design.
        set({ needsLogin: true, loading: false });
        return;
      }
      const [fleet, mirror, jobs] = await Promise.all([
        api.fleet(),
        api.mirror(),
        api.jobs(),
      ]);
      // Show the fleet immediately. The registry is a separate, slower fetch
      // over the internet, and awaiting it here delayed the device list behind
      // a request that may take seconds or never finish at all.
      set({
        fleet,
        mirror,
        jobs,
        needsLogin: false,
        loading: false,
        loadError: undefined,
        lastRefresh: Date.now(),
      });
      // Not awaited: an action awaits this refresh before showing its
      // outcome, and would otherwise stay "busy" for as long as the internet
      // fetch takes, or forever.
      void api.registry().then(
        (registry) => {
          set({ registry });
        },
        () => {
          // Keep whatever we had; the store page shows the staleness itself.
        },
      );
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        set({ needsLogin: true, loading: false });
        return;
      }
      set({ loadError: describe(error), loading: false });
    }
  },

  loadAvailable: async (id) => {
    try {
      const result = await api.available(id);
      set((state) => ({ available: { ...state.available, [id]: result } }));
    } catch (error) {
      set((state) => ({
        available: {
          ...state.available,
          [id]: { reason: describe(error) },
        },
      }));
    }
  },

  /** Run an action, then refresh — with the outcome shown either way. */
  act: async (what, fn, options) => {
    set({
      loading: true,
      acting: options?.key ?? what,
      error: undefined,
      notice: undefined,
      inlineError: undefined,
    });
    let outcome: Partial<ManagerState>;
    try {
      await fn();
      outcome = { notice: `${what} — done` };
    } catch (error) {
      outcome =
        options?.errorInline === true
          ? {
              inlineError: {
                key: options.key ?? what,
                message: describe(error),
              },
            }
          : { error: `${what} — ${describe(error)}` };
    }
    // Refreshed before the outcome is shown, so a control that is still on
    // screen reflects the result -- a fixed device's warning is gone by then.
    await get().refresh();
    set({ ...outcome, acting: undefined });
    const selected = get().selectedDevice;
    if (selected !== undefined) await get().loadAvailable(selected);
  },

  dismiss: () => {
    set({ notice: undefined, error: undefined, inlineError: undefined });
  },
}));
