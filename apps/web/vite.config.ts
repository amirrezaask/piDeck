import path from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, type Plugin } from "vite-plus"

const repoRoot = path.resolve(import.meta.dirname, "../..")
const agentsRoot = path.join(repoRoot, "packages/agents-client/src")
const tasksRoot = path.join(repoRoot, "packages/tasks-client/src")
const browserTargets = ["chrome107", "edge107", "firefox104", "safari16"]
const viteHost = process.env.YAADE_WEB_HOST ?? process.env.YAADE_HOST ?? "127.0.0.1"
const rawProxyHost =
  process.env.YAADE_PROXY_HOST ??
  (viteHost === "0.0.0.0" || viteHost === "::" ? "127.0.0.1" : viteHost)
const proxyHost =
  rawProxyHost.includes(":") && !rawProxyHost.startsWith("[") ? `[${rawProxyHost}]` : rawProxyHost
const serverOrigin = `http://${proxyHost}:${process.env.YAADE_PORT ?? 7774}`
const configuredAllowedHosts = (process.env.YAADE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map(host => host.trim())
  .filter(Boolean)
const isLoopbackHost = (host: string): boolean =>
  ["localhost", "127.0.0.1", "::1"].includes(
    host.trim().toLowerCase().replace(/^\[|\]$/g, ""),
  )
const allowedHosts =
  configuredAllowedHosts.length > 0
    ? configuredAllowedHosts
    : isLoopbackHost(viteHost)
      ? ["ide.local"]
      : true
const hostProxy = {
  "^/terminal(?:/|$)": { target: serverOrigin, ws: true },
  "/tasks/api": { target: serverOrigin, changeOrigin: true },
  "/agents/v1": { target: serverOrigin, changeOrigin: true, ws: true },
}

export default defineConfig({
  base: "/",
  build: {
    target: browserTargets,
    cssTarget: browserTargets,
    outDir: "dist",
    emptyOutDir: true,
  },
  plugins: [
    react({ compiler: { compilationMode: "annotation" } }) as unknown as Plugin,
    tailwindcss() as unknown as Plugin,
  ],
  publicDir: path.join(repoRoot, "packages/yaade-app/public"),
  resolve: {
    dedupe: ["react", "react-dom", "motion", "framer-motion"],
    alias: {
      "@agents": agentsRoot,
      "@tasks": tasksRoot,
      "@": path.join(repoRoot, "packages/yaade-ui/src"),
      "@nextflow/contracts": path.join(repoRoot, "packages/contracts/src/index.ts"),
    },
  },
  server: {
    port: Number(process.env.YAADE_WEB_PORT ?? 5174),
    strictPort: true,
    host: viteHost,
    allowedHosts,
    proxy: hostProxy,
  },
  preview: {
    proxy: hostProxy,
  },
  clearScreen: false,
})
