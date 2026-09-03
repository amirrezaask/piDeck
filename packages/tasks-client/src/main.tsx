import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "@tasks/App";
import "@tasks/styles/globals.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Dispatch could not find the root element.");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
