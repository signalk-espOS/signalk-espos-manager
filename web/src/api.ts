/**
 * The plugin's HTTP API, as the webapp sees it.
 *
 * Everything here lives under `/plugins/signalk-espos-manager/`, which the
 * server gates to administrators. The webapp itself is served from the
 * unauthenticated mount, so it can be opened by anyone on the boat network —
 * and every call it makes can therefore come back 401. That is a normal state
 * to render, not an error to throw at the user.
 */

const PLUGIN_BASE = "/plugins/signalk-espos-manager/api";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the caller simply is not logged in as an administrator. */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function call<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${PLUGIN_BASE}${path}`, {
    method: init?.method ?? "GET",
    // The admin session is a cookie; without this the API always 401s.
    credentials: "same-origin",
    headers:
      init?.body === undefined ? {} : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        typeof (body as { error?: unknown }).error === "string"
      ) {
        detail = (body as { error: string }).error;
      }
    } catch {
      // Not JSON; the status is all we have.
    }
    throw new ApiError(detail, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface DeviceDto {
  id: string;
  identified: boolean;
  hostname?: string;
  addresses: string[];
  port: number;
  reachability: "online" | "stale" | "offline" | "unreachable";
  auth: "open" | "authorized" | "needs-key" | "locked-out" | "unknown";
  hasKey: boolean;
  lockedOutUntil?: string;
  lastSeenAt: string;
  lastOkProbeAt?: string;
  lastError?: string;
  app?: string;
  version?: string;
  esposVersion?: string;
  target?: string;
  board?: string;
  chip?: string;
  uptimeS?: number;
  freeHeap?: number;
  otaState?: string;
  otaError?: string;
  manifestUrl?: string;
  otaNeedsRepair?: boolean;
  otaRepairReason?: string;
  sources: string[];
}

export interface FleetDto {
  devices: DeviceDto[];
  summary: {
    total: number;
    online: number;
    offline: number;
    needKey: number;
    updatesAvailable: number;
  };
  warnings: string[];
}

export interface AvailableDto {
  project?: { id: string; name: string; repo: string; official: boolean };
  build?: {
    version: string;
    target: string;
    channel: string;
    otaBytes?: number;
    mergedUrl?: string;
    notes?: string;
    notesUrl?: string;
    publishedAt?: string;
  };
  reason?: string;
  requiresUsb?: boolean;
  needsConfirmation?: boolean;
}

export interface MirrorDto {
  mode: "mirror" | "upstream";
  reason?: string;
  publicBase: string;
  cachedBytes: number;
  files: {
    app: string;
    version: string;
    filename: string;
    sizeBytes: number;
  }[];
}

export interface RegistryBoardDto {
  id: string;
  target: string;
  /** The name someone would recognise on a shop page. */
  name: string;
  notes?: string;
  buyUrl?: string;
  flashMinBytes?: number;
}

export interface RegistryDto {
  projects: {
    id: string;
    app: string;
    name: string;
    summary?: string;
    repo: string;
    targets: string[];
    boards?: RegistryBoardDto[];
    official?: boolean;
    deprecated?: boolean | string;
    releases?: {
      version: string;
      channel: string;
      notesUrl?: string;
      builds?: { target: string; boardId?: string; mergedUrl?: string }[];
    }[];
  }[];
  stale: boolean;
  fetchedAt?: string;
  reason?: string;
  warnings: string[];
}

export interface JobDto {
  deviceId: string;
  state:
    | "queued"
    | "installing"
    | "rebooting"
    | "verifying"
    | "confirming"
    | "done"
    | "rolled-back"
    | "failed";
  fromVersion: string;
  toVersion: string;
  progress?: { receivedBytes: number; totalBytes: number };
  devicePhase?: string;
  error?: string;
  confirmBy?: number;
}

/**
 * A job in one of these states has finished; anything else is still in
 * flight. `rolled-back` belongs here — the device protected itself and is
 * running again, so the UI must let the user act rather than showing a
 * spinner forever.
 */
const TERMINAL: ReadonlySet<JobDto["state"]> = new Set([
  "done",
  "failed",
  "rolled-back",
]);

export function isJobFinished(job: JobDto | undefined): boolean {
  return job === undefined || TERMINAL.has(job.state);
}

export interface JobsDto {
  jobs: JobDto[];
  paused: boolean;
  pausedReason?: string;
}

export const api = {
  fleet: () => call<FleetDto>("/fleet"),
  device: (id: string) => call<DeviceDto>(`/fleet/${encodeURIComponent(id)}`),
  available: (id: string) =>
    call<AvailableDto>(`/fleet/${encodeURIComponent(id)}/available`),
  mirror: () => call<MirrorDto>("/mirror"),
  registry: () => call<RegistryDto>("/registry"),
  jobs: () => call<JobsDto>("/jobs"),

  rescan: () => call<{ ok: boolean }>("/discovery/rescan", { method: "POST" }),
  refreshRegistry: () =>
    call<{ ok: boolean }>("/registry/refresh", { method: "POST" }),
  resumeJobs: () => call<{ ok: boolean }>("/jobs/resume", { method: "POST" }),

  setKey: (id: string, key: string) =>
    call<{ ok: boolean }>(`/fleet/${encodeURIComponent(id)}/key`, {
      method: "POST",
      body: { key },
    }),
  configureOta: (id: string) =>
    call<{ ok: boolean; manifestPath: string; restartRequired: boolean }>(
      `/fleet/${encodeURIComponent(id)}/configure-ota`,
      { method: "POST" },
    ),
  update: (id: string, confirmDowngrade = false) =>
    call<{ ok: boolean; job?: JobDto }>(
      `/fleet/${encodeURIComponent(id)}/update`,
      { method: "POST", body: { confirmDowngrade } },
    ),
  confirm: (id: string) =>
    call<{ ok: boolean }>(`/fleet/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
    }),
  rollback: (id: string) =>
    call<{ ok: boolean }>(`/fleet/${encodeURIComponent(id)}/rollback`, {
      method: "POST",
    }),
  cancelJob: (id: string) =>
    call<{ cancelled: boolean; reason?: string }>(
      `/fleet/${encodeURIComponent(id)}/job`,
      { method: "DELETE" },
    ),
  forget: (id: string) =>
    call<{ ok: boolean }>(`/fleet/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};

/**
 * Whether this browser may use the admin API.
 *
 * The webapp is served from the unauthenticated mount, so anyone on the boat
 * network can open it, and every admin call can come back 401. The page has to
 * be able to say "log in to manage these devices" rather than show a wall of
 * errors.
 *
 * Contract read from signalk-server's `getLoginStatus`
 * (src/tokensecurity.ts): `{status: 'loggedIn' | 'notLoggedIn',
 * readOnlyAccess, authenticationRequired, userLevel}`. With security disabled
 * there is no strategy at all and the endpoint reports
 * `authenticationRequired: false`, which is the case where everything is
 * permitted without logging in.
 */
export async function loginStatus(): Promise<{
  loggedIn: boolean;
  username?: string;
  authenticationRequired: boolean;
}> {
  try {
    const response = await fetch("/skServer/loginStatus", {
      credentials: "same-origin",
    });
    if (!response.ok) {
      // Cannot tell; assume a login is needed so the UI prompts rather than
      // pretending the API will work.
      return { loggedIn: false, authenticationRequired: true };
    }
    const body = (await response.json()) as {
      status?: string;
      username?: string;
      authenticationRequired?: boolean;
    };
    const authenticationRequired = body.authenticationRequired !== false;
    return {
      // Security off means no login is needed and everything is permitted.
      loggedIn: !authenticationRequired || body.status === "loggedIn",
      username: body.username,
      authenticationRequired,
    };
  } catch {
    return { loggedIn: false, authenticationRequired: true };
  }
}
