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
    outDir: "../public",
    emptyOutDir: false,
    // A boat is often on a marina LTE connection; keep it small and one file.
    assetsInlineLimit: 8192,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "app-[hash].js",
        assetFileNames: "app.[ext]",
      },
    },
  },
});
