import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5175,
    proxy: {
      "/tasks/api": {
        target: `http://127.0.0.1:${process.env.YAADE_PORT ?? 7774}`,
        changeOrigin: true,
      },
    },
  },
});
