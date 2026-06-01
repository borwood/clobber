import { createPortal } from "react-dom";
import type { ReactNode } from "react";

function getPortalRoot(): HTMLElement {
  let el = document.getElementById("portal-root");
  if (el === null) {
    el = document.createElement("div");
    el.id = "portal-root";
    document.body.appendChild(el);
  }
  return el;
}

export function Portal({ children }: { readonly children: ReactNode }) {
  return createPortal(children, getPortalRoot());
}
