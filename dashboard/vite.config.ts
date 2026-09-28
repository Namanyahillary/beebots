import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const engine = process.env.ENGINE_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Public test tunnels (ngrok etc.): VITE_ALLOWED_HOSTS="foo.ngrok-free.app,bar.ngrok-free.app" pnpm dev
    allowedHosts: (process.env.VITE_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    proxy: Object.fromEntries(["/events", "/snapshot", "/history", "/scout", "/equity", "/visit", "/health", "/profile", "/bee-image", "/setup", "/hive"].map((p) => [p, { target: engine, changeOrigin: false }])),
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
});
