import type { YaadeHostAPI } from "@yaade/workspace"

declare global {
  interface Window {
    yaade?: YaadeHostAPI
  }
}

declare module "*.css" {
  const content: string
  export default content
}

declare module "*.png" {
  const src: string
  export default src
}
