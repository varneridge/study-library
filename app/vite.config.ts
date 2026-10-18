import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Fills the service worker in with this build's name and its scripts and
// style sheets, so each deploy gets a fresh cache and old ones are cleared.
function serviceWorker(): Plugin {
  return {
    name: "study-service-worker",
    apply: "build",
    closeBundle() {
      const dist = join(__dirname, "dist");
      const assets = readdirSync(join(dist, "assets"))
        .filter((name) => /\.(js|css)$/.test(name))
        .sort()
        .map((name) => `/assets/${name}`);
      const hash = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 12);
      const build = `${Date.now()}-${hash}`;
      const path = join(dist, "sw.js");
      const source = readFileSync(path, "utf8");
      if (!source.includes("__BUILD__")) throw new Error("sw.js has no __BUILD__ placeholder");
      writeFileSync(path, source.replace("__BUILD__", build).replace("/*__PRECACHE__*/[]", JSON.stringify(assets)));
    },
  };
}

// During development, run `npm run dev:api` alongside `npm run dev`.
export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: { proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1500 },
});
