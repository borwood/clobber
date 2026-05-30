import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { bootstrapTheme } from "./lib/apply-theme.ts";
import "./index.css";

// Repaint the cached active-workspace theme before React renders, so a light or
// paper workspace doesn't flash dark on reload (#369).
bootstrapTheme();

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
