/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REOWN_PROJECT_ID?: string;
  readonly NEXT_PUBLIC_REOWN_PROJECT_ID?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_ALCHEMY_ID?: string;
  readonly NEXT_PUBLIC_ALCHEMY_ID?: string;
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
