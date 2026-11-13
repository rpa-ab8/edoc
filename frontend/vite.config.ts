import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Read the shared .env from the repo root instead of frontend/.env
  envDir: path.resolve(dirname, ".."),
  server: {
    port: 5173,
    // Listen on every interface so phones/PCs on the office LAN can open the dev server.
    host: true,
  },
});
