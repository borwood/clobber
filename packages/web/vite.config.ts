import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3470,
    host: "127.0.0.1",
    proxy: {
      "/hook": "http://127.0.0.1:3370",
      "/events": "http://127.0.0.1:3370",
      "/sessions": "http://127.0.0.1:3370",
      "/spawn": "http://127.0.0.1:3370",
      "/workspaces": "http://127.0.0.1:3370",
      "/persistent-agents": "http://127.0.0.1:3370",
      "/roles": "http://127.0.0.1:3370",
      "/fs": "http://127.0.0.1:3370",
    },
  },
});
