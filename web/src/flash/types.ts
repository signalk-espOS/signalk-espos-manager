/** Shared types for the flasher. */

export type Target =
  | "esp32"
  | "esp32c2"
  | "esp32c3"
  | "esp32c5"
  | "esp32c6"
  | "esp32c61"
  | "esp32h2"
  | "esp32p4"
  | "esp32s2"
  | "esp32s3"
  | "esp8266";

export type FlashStep =
  "select" | "connect" | "verify" | "write" | "done" | "error";

export interface FlashBuild {
  projectId: string;
  projectName: string;
  version: string;
  target: Target;
  /** Full-flash image: the only kind that can be written to a blank board. */
  mergedUrl: string;
  mergedBytes?: number;
  mergedSha256?: string;
  boardId?: string;
  /** True when the build was made with a throwaway key: no future updates. */
  unsigned?: boolean;
}

export interface FlashProgress {
  writtenBytes: number;
  totalBytes: number;
  startedAt: number;
}
