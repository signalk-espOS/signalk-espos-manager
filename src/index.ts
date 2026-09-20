/**
 * signalk-espos-manager — the boat-side manager for espOS devices.
 *
 * Phase 0: discovery and the fleet list. The firmware mirror, updates and the
 * browser flasher follow.
 */

import type { Plugin, ServerAPI } from "@signalk/server-api";
import {
  applyDefaults,
  PLUGIN_ID,
  PLUGIN_NAME,
  SettingsSchema,
} from "./config.js";
import { ManagerService } from "./service.js";
import { registerRoutes, type PluginRouter } from "./api/routes.js";

export { ManagerService };
export * from "./config.js";
export * from "./types.js";

export default function createPlugin(app: ServerAPI): Plugin {
  let service: ManagerService | undefined;

  // Constructed lazily and kept for the process lifetime: registerWithRouter
  // is called even when the plugin is disabled, and Express routes cannot be
  // deregistered, so the persistent routes need something stable to delegate
  // to. Construction is side-effect free — nothing opens a socket until
  // start().
  const getService = (): ManagerService => {
    service ??= new ManagerService(app);
    return service;
  };

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      "Finds espOS devices on the boat network, mirrors signed firmware " +
      "locally, and drives over-the-air updates.",

    // TypeBox emits plain JSON Schema, which the Admin UI renders as-is.
    schema: () => SettingsSchema as unknown as object,

    start(config: object) {
      // start() must never throw: Signal K neither awaits nor catches it, so
      // an exception here takes down more than this plugin.
      try {
        void getService().start(applyDefaults(config));
      } catch (error) {
        app.setPluginError(
          `failed to start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async stop() {
      await service?.stop();
    },

    registerWithRouter(router: unknown) {
      registerRoutes(router as PluginRouter, getService);
    },
  };
}
