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
  // The icon lives at the package root because that is where Signal K's
  // plugin list reads it from (`signalk.appIcon` in package.json). The webapp
  // asks for it under the webapp mount, which serves `public/`, so without
  // this the page's <link rel="icon"> 404s -- one file, two consumers, and
  // copying it beats keeping a second copy in step by hand.
  publicDir: "../static",
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
