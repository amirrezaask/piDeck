import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  resolve: {
    alias: {
      "@yaade/ui/styles.css": path.resolve(__dirname, "../yaade-ui/src/styles/globals.css"),
      "@": path.resolve(__dirname, "../yaade-ui/src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
