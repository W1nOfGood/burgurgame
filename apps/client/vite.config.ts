import { defineConfig, defaultClientConditions } from "vite";

/**
 * Builds static HTML/JS/CSS for Nginx (spec §2). The realtime origin is configured at build time
 * through VITE_REALTIME_URL; nothing secret is ever bundled.
 */
export default defineConfig({
  resolve: {
    conditions: ["source", ...defaultClientConditions],
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: "es2022",
    sourcemap: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("@babylonjs")) return "babylon";
          if (id.includes("rapier")) return "rapier";
          if (id.includes("@colyseus")) return "colyseus";
          return undefined;
        },
      },
    },
  },
});
