import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

/**
 * Builds the webapp into `public/`, which Signal K serves at
 * `/signalk-espos-manager/` with no authentication (the `signalk-webapp`
 * keyword). The firmware mirror is a symlink at `public/fw` created at
 * runtime, so the build must never clear the directory.
 */
export default defineConfig({
  root: "web",
  base: "/signalk-espos-manager/",
  plugins: [preact()],
  build: {
    // Two entries: the plugin's webapp and the standalone flasher. The
    // flasher is deployed to GitHub Pages because browsers only allow USB
    // access from a secure page, and a Signal K server on a boat is plain
    // http on a LAN address.
    rollupOptions: {
      input: {
        index: "web/index.html",
        flash: "web/flash/index.html",
      },
    },
    outDir: "../public",
    emptyOutDir: false,
    // A boat is often on a marina LTE connection; keep it small and one file.
    assetsInlineLimit: 8192,
  },
});
