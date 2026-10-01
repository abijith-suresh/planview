const DEFAULT_APP_URL = "https://plansplease-app-staging.up.railway.app";

// biome-ignore lint/complexity/useLiteralKeys: PUBLIC_APP_URL is a build-time config key.
const appUrl = process.env["PUBLIC_APP_URL"] ?? DEFAULT_APP_URL;

// The app entry checks the session before choosing the dashboard or GitHub.
export const appSignInUrl = `${appUrl.replace(/\/$/, "")}/`;
