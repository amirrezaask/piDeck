import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { TerminalClient } from "./client.js"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TerminalClient />
  </StrictMode>,
)
