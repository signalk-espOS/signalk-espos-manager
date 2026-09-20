/**
 * One device's update, from "install this" to "confirmed running it".
 *
 * The plugin's states are deliberately not the device's. espOS reports what it
 * is doing right now (`downloading`, `verifying`, `ready`); a job also has to
 * represent waiting in a queue, a reboot during which the device is
 * legitimately unreachable, and the window after boot where the image is
 * running but not yet confirmed. Conflating the two loses exactly the
 * information an operator needs.
 *
 * Two rules matter more than the rest:
 *
 * - A connection failure while the device is rebooting is expected, not a
 *   failure. Treating it as one would report every successful update as broken.
 * - A rollback is never retried automatically. The device rolled back because
 *   the new image did not work; installing it again is how a boat ends up in a
 *   reboot loop at sea.
 */

import { DeviceClient, DeviceHttpError } from "../device/client.js";
import { isNewer } from "../mirror/manifest.js";
import type { DeviceId } from "../types.js";

export type JobState =
  | "queued"
  | "installing"
  | "rebooting"
  | "verifying"
  | "confirming"
  | "done"
  | "rolled-back"
  | "failed";

export interface JobProgress {
  receivedBytes: number;
  totalBytes: number;
}

export interface JobView {
  deviceId: DeviceId;
  state: JobState;
  fromVersion: string;
  toVersion: string;
  url: string;
  startedAt: number;
  updatedAt: number;
  progress?: JobProgress;
  /** What the device says it is doing, when it says anything. */
  devicePhase?: string;
  error?: string;
  /** When the device will roll itself back if nobody confirms. */
  confirmBy?: number;
}

export interface JobOptions {
  deviceId: DeviceId;
  client: DeviceClient;
  fromVersion: string;
  toVersion: string;
  url: string;
  /** Give up watching after this long. */
  timeoutMs: number;
  /** Wait this long after boot before confirming. */
  confirmGraceMs: number;
  autoConfirm: boolean;
  pollMs?: number;
  log?: (message: string) => void;
  onChange?: (view: JobView) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 2000;

export class OtaJob {
  private state: JobState = "queued";
  private progress?: JobProgress;
  private devicePhase?: string;
  private error?: string;
  private confirmBy?: number;
  /** The ping that proved the device came back, reused by verifyBoot. */
  private bootPing?: { app: string; version: string };
  private readonly startedAt: number;
  private updatedAt: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(private readonly options: JobOptions) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.log = options.log ?? ((): void => {});
    this.startedAt = this.now();
    this.updatedAt = this.startedAt;
  }

  view(): JobView {
    return {
      deviceId: this.options.deviceId,
      state: this.state,
      fromVersion: this.options.fromVersion,
      toVersion: this.options.toVersion,
      url: this.options.url,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      progress: this.progress,
      devicePhase: this.devicePhase,
      error: this.error,
      confirmBy: this.confirmBy,
    };
  }

  private set(state: JobState, error?: string): void {
    this.state = state;
    this.error = error;
    this.updatedAt = this.now();
    this.options.onChange?.(this.view());
  }

  /** Run the whole update. Never throws; the state carries the outcome. */
  async run(): Promise<JobView> {
    try {
      await this.install();
      await this.watchInstall();
      await this.waitForReboot();
      await this.verifyBoot();
      await this.confirm();
    } catch (error) {
      if (this.state !== "rolled-back" && this.state !== "failed") {
        this.set("failed", message(error));
      }
    }
    return this.view();
  }

  private async install(): Promise<void> {
    this.set("installing");
    try {
      await this.options.client.otaInstall(this.options.url);
      this.log(
        `${this.options.deviceId}: installing ${this.options.toVersion}`,
      );
    } catch (error) {
      if (error instanceof DeviceHttpError && error.status === 409) {
        // Already busy. Adopt the operation in flight rather than failing:
        // a plugin restart mid-update must not lose track of it.
        this.log(
          `${this.options.deviceId}: an update is already running — watching it`,
        );
        return;
      }
      throw error;
    }
  }

  /** Poll the device while it downloads and verifies. */
  private async watchInstall(): Promise<void> {
    const deadline = this.startedAt + this.options.timeoutMs;
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;

    while (this.now() < deadline) {
      let status;
      try {
        status = await this.options.client.otaStatus();
      } catch {
        // Stopped answering mid-install: the reboot has begun.
        this.set("rebooting");
        return;
      }

      this.devicePhase = status.state;
      if (status.progress !== undefined && status.progress.total > 0) {
        this.progress = {
          receivedBytes: status.progress.received,
          totalBytes: status.progress.total,
        };
      }
      this.updatedAt = this.now();
      this.options.onChange?.(this.view());

      if (status.state === "failed") {
        // The device's own message is more useful than anything we could
        // invent: it distinguishes a rejected signature from a bad download.
        this.set("failed", status.lastError ?? "the device reported a failure");
        return;
      }
      if (status.state === "ready") {
        this.set("rebooting");
        return;
      }
      if (status.state === "idle" && this.progress === undefined) {
        // Never started. Either the POST was lost or the device declined.
        this.set(
          "failed",
          status.lastError ?? "the device did not start the update",
        );
        return;
      }
      await this.sleep(pollMs);
    }
    this.set("failed", "the update did not finish in time");
  }

  /**
   * The device is rebooting; being unreachable here is expected.
   *
   * The subtlety is that a device keeps answering for a moment after it reports
   * `ready` — it has not restarted yet. Accepting the first successful ping
   * therefore reads the OLD firmware's version and concludes the update failed.
   * So a ping that still reports the version we are replacing is treated as
   * "not yet rebooted", and only a version change (or a ping after the device
   * has been seen to go away) counts as coming back.
   */
  private async waitForReboot(): Promise<void> {
    if (this.state !== "rebooting") return;
    const deadline = this.startedAt + this.options.timeoutMs;
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    let wentAway = false;

    while (this.now() < deadline) {
      await this.sleep(pollMs);
      try {
        // ping is public, so this works even if auth broke across the update.
        const ping = await this.options.client.ping();
        if (!wentAway && ping.version === this.options.fromVersion) {
          // Still the old image, still up: the restart has not happened yet.
          continue;
        }
        // Keep the answer: asking again in verifyBoot would spend a second
        // round trip and re-read a state that may have moved on.
        this.bootPing = ping;
        this.set("verifying");
        return;
      } catch {
        // Down. Not an error — this is what a reboot looks like — and now a
        // later ping is known to be the new boot rather than the old image.
        wentAway = true;
      }
    }
    this.set("failed", "the device did not come back after the update");
  }

  /** Did it come back running what we installed? */
  private async verifyBoot(): Promise<void> {
    if (this.state !== "verifying") return;
    const ping = this.bootPing ?? (await this.options.client.ping());

    if (ping.version === this.options.toVersion) {
      this.set("confirming");
      return;
    }

    // Came back on a different version. The device's own status says whether
    // it protected itself.
    try {
      const status = await this.options.client.otaStatus();
      if (status.running?.rolledBack === true) {
        this.set(
          "rolled-back",
          `the device rolled back to ${ping.version} — the new image did not ` +
            `run. It will not be retried automatically.`,
        );
        return;
      }
      if (isNewer(ping.version, this.options.fromVersion)) {
        // Newer than before but not what we asked for: still an improvement,
        // but say so rather than claiming success.
        this.set(
          "failed",
          `the device is running ${ping.version}, not the ${this.options.toVersion} that was installed`,
        );
        return;
      }
    } catch {
      // Cannot read status; fall through to the plain mismatch.
    }
    this.set(
      "failed",
      `the device is still running ${ping.version} after the update`,
    );
  }

  /**
   * Confirm the image, or leave it pending with the device's own rollback
   * deadline showing.
   */
  private async confirm(): Promise<void> {
    if (this.state !== "confirming") return;

    let pendingVerify = true;
    try {
      const status = await this.options.client.otaStatus();
      pendingVerify = status.running?.pendingVerify ?? false;
    } catch {
      // Assume it needs confirming; a redundant confirm is harmless.
    }

    if (!pendingVerify) {
      // Already confirmed itself (or never needed to).
      this.set("done");
      return;
    }

    if (!this.options.autoConfirm) {
      // The device's own timer will roll it back if nobody acts, which is the
      // safe default — surface the deadline instead of hiding it.
      this.confirmBy = this.now() + this.options.confirmGraceMs;
      this.set("confirming");
      return;
    }

    await this.sleep(this.options.confirmGraceMs);
    // Still alive after the grace period? A single missed answer is not
    // evidence of a bad image — the device answered moments ago — so a failure
    // here leaves the image pending for the device's own timer to judge rather
    // than declaring the update broken.
    try {
      await this.options.client.ping();
    } catch (error) {
      this.confirmBy = this.now() + this.options.confirmGraceMs;
      this.set(
        "confirming",
        `could not reach the device to confirm the new image (${message(error)}) — ` +
          `it will roll back on its own if it is not confirmed`,
      );
      return;
    }
    await this.options.client.otaConfirm();
    this.log(`${this.options.deviceId}: confirmed ${this.options.toVersion}`);
    this.set("done");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
