import { defineConfig } from "vitest/config";

export default defineConfig({
  // zustand imports "react"; the webapp build maps it to preact/compat through
  // @preact/preset-vite, which vitest does not load. Without the same mapping
  // any test that imports the webapp store cannot even resolve it. zustand is
  // inlined because an external dependency is loaded by Node itself, and an
  // alias never reaches it.
  resolve: {
    alias: { react: "preact/compat" },
  },
  test: {
    include: ["test/**/*.test.ts"],
    server: { deps: { inline: ["zustand"] } },
  },
});
