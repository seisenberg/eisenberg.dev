import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src/ui") },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    // No public source maps: the private webmail code ships from the same origin as the public site.
    sourcemap: false,
    chunkSizeWarningLimit: 1024,
  },
});
