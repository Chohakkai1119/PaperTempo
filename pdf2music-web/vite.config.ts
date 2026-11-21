import { defineConfig } from "vite";

// homr publishes its ONNX weights as GitHub release assets, which are served
// without CORS headers and so cannot be fetched cross-origin by the browser.
// The dev and preview servers proxy them under "/models/" on this origin.
// For a static deployment, host the zips yourself and set VITE_MODEL_BASE_URL.
const modelProxy = {
  "/models": {
    target: "https://github.com/liebharc/homr/releases/download/onnx_checkpoints",
    changeOrigin: true,
    followRedirects: true,
    rewrite: (path: string) => path.replace(/^\/models/, ""),
  },
};

export default defineConfig({
  base: "./",
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
  build: {
    target: "esnext",
    outDir: "../dist/pdf2music",
    emptyOutDir: true,
  },
  worker: {
    format: "es",
  },
  server: {
    proxy: modelProxy,
  },
  preview: {
    proxy: modelProxy,
  },
});
