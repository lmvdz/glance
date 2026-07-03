import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  server: {
    proxy,
    hmr: process.env.DISABLE_HMR !== "true",
    watch: process.env.DISABLE_HMR === "true" ? null : {},
  },
  preview: { proxy },
  // The app ships as one ~1.3MB bundle; the 500kB default warning is just noise
  // for a dev-tool SPA (and kept nerd-sniping fleet agents into off-task chunking).
  build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
