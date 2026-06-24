import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev/preview proxy so the SPA's /api + /ws calls reach a running omp-squad
// daemon. Override the target with OMP_SQUAD_PROXY. No effect on the build.
const daemon = process.env.OMP_SQUAD_PROXY ?? "http://127.0.0.1:7878";
const proxy = {
  "/api": { target: daemon, changeOrigin: true },
  "/ws": { target: daemon.replace(/^http/, "ws"), ws: true, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: { proxy },
  preview: { proxy },
  build: {
    outDir: "dist",
  },
});
