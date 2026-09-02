import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { applyDevBuildBrandingToHtml } from "../../packages/yaade-app/src/build-branding-html.js";

const appRoot = path.resolve(__dirname, "../../packages/yaade-app");
const uiRoot = path.resolve(__dirname, "../../packages/yaade-ui/src");

const browserTargets = ["chrome107", "edge107", "firefox104", "safari16"];
const viteHost = process.env.YAADE_WEB_HOST ?? process.env.YAADE_HOST ?? "127.0.0.1";
const rawProxyHost =
  process.env.YAADE_PROXY_HOST ??
  (viteHost === "0.0.0.0" || viteHost === "::" ? "127.0.0.1" : viteHost);
const proxyHost =
  rawProxyHost.includes(":") && !rawProxyHost.startsWith("[") ? `[${rawProxyHost}]` : rawProxyHost;
const configuredAllowedHosts = (process.env.YAADE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const isLoopbackHost = (host: string): boolean =>
  ["localhost", "127.0.0.1", "::1"].includes(
    host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, ""),
  );
const allowedHosts =
  configuredAllowedHosts.length > 0
    ? configuredAllowedHosts
    : isLoopbackHost(viteHost)
      ? ["ide.local"]
      : true;

function yaadeBuildBranding(command: "build" | "serve"): Plugin {
  return {
    name: "yaade-build-branding",
    transformIndexHtml(html) {
      // `vite` / `vite --mode development` → badged favicon + DEV title seed.
      // Production `vite build` keeps the release icons in index.html as-is.
      if (command !== "serve") return html;
      return applyDevBuildBrandingToHtml(html);
    },
  };
}

export default defineConfig(({ command }) => ({
  base: "/",
  build: {
    target: browserTargets,
    cssTarget: browserTargets,
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    rolldownOptions: {
      input: { index: path.resolve(appRoot, "index.html") },

    },
  },
  plugins: [
    yaadeBuildBranding(command),
    // The app still contains imperative integrations and third-party hooks that
    // are not safe for infer-mode compilation. Adopt the compiler explicitly
    // with "use memo" once a component has been audited.
    react({ compiler: { compilationMode: "annotation" } }) as unknown as Plugin,
    tailwindcss() as unknown as Plugin,
  ],
  root: appRoot,
  resolve: {
    alias: {
      "@yaade/ui/styles.css": path.resolve(uiRoot, "styles/globals.css"),
      "@": uiRoot,
    },
  },
  server: {
    port: Number(process.env.YAADE_WEB_PORT ?? 5174),
    // Tauri's dev shell targets this exact URL, so never silently move ports.
    strictPort: true,
    host: viteHost,
    allowedHosts,
    proxy: {
      "/terminal": {
        target: `http://${proxyHost}:${process.env.YAADE_PORT ?? 7774}`,
        ws: true,
      },
    },
  },
  clearScreen: false,
}));
