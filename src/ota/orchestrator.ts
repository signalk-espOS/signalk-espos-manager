/**
 * The update queue.
 *
 * Serial by default, and that default is a safety property rather than a
 * performance one: several devices pulling firmware over the same boat wifi
 * while this server serves the bytes is how a fleet update browns out, and six
 * bricked displays at sea is the worst thing this plugin could produce.
 *
 * The queue also pauses itself after the first job that ends badly. One bad
 * build should not walk through the whole boat — an operator gets to look at
 * what happened and say "continue" before the rest proceed.
 */

import { OtaJob, type JobOptions, type JobView } from "./job.js";
import type { DeviceId } from "../types.js";

export interface OrchestratorOptions {
  maxConcurrent: number;
  log?: (message: string) => void;
  onChange?: (view: JobView) => void;
}

interface QueueEntry {
  deviceId: DeviceId;
  options: Omit<JobOptions, "onChange">;
}

export class OtaOrchestrator {
  private readonly queue: QueueEntry[] = [];
  private readonly running = new Map<DeviceId, OtaJob>();
  /** Last known view per device, kept after the job finishes. */
  private readonly views = new Map<DeviceId, JobView>();
  private paused = false;
  private pausedReason?: string;
  private draining = false;
  private readonly log: (message: string) => void;

  constructor(private readonly options: OrchestratorOptions) {
    this.log = options.log ?? ((): void => {});
  }

  get isPaused(): boolean {
    return this.paused;
  }

  getPausedReason(): string | undefined {
    return this.pausedReason;
  }

  /** Every job this session knows about, running or finished. */
  list(): JobView[] {
    const out = [...this.views.values()];
    for (const entry of this.queue) {
      if (!this.views.has(entry.deviceId)) {
        out.push({
          deviceId: entry.deviceId,
          state: "queued",
          fromVersion: entry.options.fromVersion,
          toVersion: entry.options.toVersion,
          url: entry.options.url,
          startedAt: 0,
          updatedAt: 0,
        });
      }
    }
    return out;
  }

  get(deviceId: DeviceId): JobView | undefined {
    return this.views.get(deviceId);
  }

  isBusy(deviceId: DeviceId): boolean {
    return (
      this.running.has(deviceId) ||
      this.queue.some((entry) => entry.deviceId === deviceId)
    );
  }

  /**
   * Queue an update. One job per device, ever: a second install while the first
   * is mid-flight is how an image gets written over a half-written one.
   */
  enqueue(options: Omit<JobOptions, "onChange">): {
    queued: boolean;
    reason?: string;
  } {
    if (this.isBusy(options.deviceId)) {
      return {
        queued: false,
        reason: "an update is already running or queued for this device",
      };
    }
    this.queue.push({ deviceId: options.deviceId, options });
    this.views.set(options.deviceId, {
      deviceId: options.deviceId,
      state: "queued",
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      url: options.url,
      startedAt: 0,
      updatedAt: 0,
    });
    void this.drain();
    return { queued: true };
  }

  /** Remove a device's job while it is still queued. */
  cancel(deviceId: DeviceId): { cancelled: boolean; reason?: string } {
    if (this.running.has(deviceId)) {
      // A device that is already writing flash cannot be interrupted, and
      // pretending otherwise would be worse than saying no.
      return {
        cancelled: false,
        reason: "this update has already started and cannot be cancelled",
      };
    }
    const index = this.queue.findIndex((entry) => entry.deviceId === deviceId);
    if (index < 0) return { cancelled: false, reason: "no queued update" };
    this.queue.splice(index, 1);
    this.views.delete(deviceId);
    return { cancelled: true };
  }

  /** Resume after a failure paused the queue. */
  resume(): void {
    this.paused = false;
    this.pausedReason = undefined;
    void this.drain();
  }

  /** Stop starting new jobs; those already running are left to finish. */
  pause(reason: string): void {
    this.paused = true;
    this.pausedReason = reason;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (
        !this.paused &&
        this.queue.length > 0 &&
        this.running.size < Math.max(1, this.options.maxConcurrent)
      ) {
        const entry = this.queue.shift();
        if (entry === undefined) break;
        await this.start(entry);
      }
    } finally {
      this.draining = false;
    }
  }

  private async start(entry: QueueEntry): Promise<void> {
    const job = new OtaJob({
      ...entry.options,
      onChange: (view) => {
        this.views.set(view.deviceId, view);
        this.options.onChange?.(view);
      },
    });
    this.running.set(entry.deviceId, job);
    const view = await job.run();
    this.running.delete(entry.deviceId);
    this.views.set(entry.deviceId, view);

    if (view.state === "failed" || view.state === "rolled-back") {
      // One bad build must not walk through the whole boat.
      if (this.queue.length > 0) {
        this.pause(
          `${entry.deviceId} ended in "${view.state}" — ${
            view.error ?? "no reason given"
          }. The remaining ${this.queue.length} update(s) are held.`,
        );
        this.log(`update queue paused: ${this.pausedReason ?? ""}`);
      }
      return;
    }
    // Keep draining; the loop in drain() handles the rest.
    void this.drain();
  }
}
