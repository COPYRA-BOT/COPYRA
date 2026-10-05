/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REOWN_PROJECT_ID?: string;
  readonly NEXT_PUBLIC_REOWN_PROJECT_ID?: string;
  readonly VITE_VENLY_CLIENT_ID?: string;
  readonly NEXT_PUBLIC_VENLY_CLIENT_ID?: string;
  readonly VITE_VENLY_ENVIRONMENT?: string;
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
