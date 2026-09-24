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
  /**
   * The same image somewhere a browser may read it.
   *
   * Absent for a project that has not mirrored its release images. GitHub
   * serves release downloads without CORS headers, so with only `mergedUrl`
   * a web page cannot download the firmware at all -- the plugin can, because
   * it fetches server-side.
   */
  mergedWebUrl?: string;
  mergedBytes?: number;
  mergedSha256?: string;
  boardId?: string;
  /** True when the build was made with a throwaway key: no future updates. */
  unsigned?: boolean;
  /**
   * The release channel, so a prerelease can be labelled rather than silently
   * offered as though it were stable.
   */
  channel?: string;
  /**
   * Presentation, carried so a chooser can say what a thing IS rather than
   * only its version and chip. All of it is already in the registry index and
   * was simply unused: two board variants of one release rendered as two
   * identical rows reading "P4 Cockpit 1.3.1 · esp32p4".
   */
  boardName?: string;
  summary?: string;
  repo?: string;
  notesUrl?: string;
  official?: boolean;
}

export interface FlashProgress {
  writtenBytes: number;
  totalBytes: number;
  startedAt: number;
}
