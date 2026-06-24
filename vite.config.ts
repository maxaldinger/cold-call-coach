import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port. @see https://tauri.app
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Prevent Vite from obscuring Rust errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Don't watch the Rust backend; cargo handles that.
      ignored: ["**/src-tauri/**"],
    },
  },
});
