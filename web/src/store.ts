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
  error?: string;
  notice?: string;
  lastRefresh?: number;

  go: (page: Page, deviceId?: string) => void;
  refresh: () => Promise<void>;
  loadAvailable: (id: string) => Promise<void>;
  act: (what: string, fn: () => Promise<unknown>) => Promise<void>;
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
        error: undefined,
        lastRefresh: Date.now(),
      });
      try {
        set({ registry: await api.registry() });
      } catch {
        // Keep whatever we had; the store page shows the staleness itself.
      }
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        set({ needsLogin: true, loading: false });
        return;
      }
      set({ error: describe(error), loading: false });
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
  act: async (what, fn) => {
    set({ loading: true, error: undefined, notice: undefined });
    let outcome: { notice?: string; error?: string };
    try {
      await fn();
      outcome = { notice: `${what} — done` };
    } catch (error) {
      outcome = { error: `${what} — ${describe(error)}` };
    }
    // The refresh below clears error/notice on success, so the outcome is
    // re-applied afterwards. Without this a failed action vanished silently,
    // which is the worst way for one to fail.
    await get().refresh();
    set(outcome);
    const selected = get().selectedDevice;
    if (selected !== undefined) await get().loadAvailable(selected);
  },

  dismiss: () => {
    set({ notice: undefined, error: undefined });
  },
}));
