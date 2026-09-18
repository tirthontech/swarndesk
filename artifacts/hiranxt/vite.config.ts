import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const port = Number(process.env.PORT ?? "5173");
const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Third-party code changes only when a dependency is upgraded, app code changes
        // on every deploy, so keeping libraries in their own chunk lets them keep their
        // content hash and stay in the browser cache across deploys.
        //
        // Only ONE library group is split off, and deliberately so. Splitting the
        // remaining vendors further (react / radix / the rest) produced chunks that
        // import each other — rollup reported "Circular chunk: vendor -> vendor-react ->
        // vendor" — and circular ES chunks blow up with a temporal-dead-zone error during
        // module initialisation, which renders as a blank page. A chunk is only safe to
        // separate when nothing in the remaining bundle imports it back.
        //
        // Charting qualifies: recharts/d3 import React, React imports nothing of theirs,
        // so the edge runs one way. It is also the single heaviest dependency and is
        // reached from only two pages, so keeping it out of the entry is the bulk of the
        // benefit anyway — the rest of the vendors are needed by the shell regardless and
        // gain nothing from being split apart.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("recharts") || id.includes("d3-")) return "vendor-charts";
          return "vendor";
        },
      },
    },
    // The split above leaves every chunk well under this; keep the warning meaningful
    // rather than silencing it.
    chunkSizeWarningLimit: 600,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? 3001}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
