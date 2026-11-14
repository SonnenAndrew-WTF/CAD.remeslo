import { defineConfig } from "vite";

export default defineConfig({
  // OpenCascade поставляется как wasm + emscripten-загрузчик — не даём Vite его пере-бандлить
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  server: { host: true },
});
