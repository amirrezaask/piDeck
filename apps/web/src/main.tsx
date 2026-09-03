import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.js"

const root = document.getElementById("root")
if (!root) throw new Error("piDeck could not find the client root element")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
