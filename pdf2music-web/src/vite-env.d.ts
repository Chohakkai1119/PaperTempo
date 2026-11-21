/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MODEL_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "@techstark/opencv-js" {
  const cv: any;
  export default cv;
}
