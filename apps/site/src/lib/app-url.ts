const DEFAULT_APP_URL = "https://app-staging-a39a.up.railway.app";

// biome-ignore lint/complexity/useLiteralKeys: PUBLIC_APP_URL is a build-time config key.
const appUrl = process.env["PUBLIC_APP_URL"] ?? DEFAULT_APP_URL;

export const appSignInUrl = `${appUrl.replace(/\/$/, "")}/dashboard`;
