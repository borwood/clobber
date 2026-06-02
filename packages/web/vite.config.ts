import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolvePort } from "@clobber/shared";

const serverPort = resolvePort(process.env["CLOBBER_PORT"], 3370);
const webPort = resolvePort(process.env["CLOBBER_WEB_PORT"], 3470);
const serverBase = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: webPort,
    host: "127.0.0.1",
    proxy: {
      "/hook": serverBase,
      "/events": serverBase,
      "/sessions": serverBase,
      "/spawn": serverBase,
      "/workspaces": serverBase,
      "/persistent-agents": serverBase,
      "/roles": serverBase,
      "/fs": serverBase,
    },
  },
});
