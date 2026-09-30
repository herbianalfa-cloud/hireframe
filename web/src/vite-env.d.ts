/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public reCAPTCHA Enterprise site key for App Check (prod builds only). */
  readonly VITE_RECAPTCHA_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
