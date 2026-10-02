const officialAppOrigin = "https://plansplease-app-staging.up.railway.app";
const officialSiteOrigin = "https://plansplease-site-staging.up.railway.app";

export function signOutDestination(appOrigin: string, configuredSiteUrl?: string): string {
  if (configuredSiteUrl) {
    try {
      const url = new URL(configuredSiteUrl);
      const localHttp =
        url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        (url.protocol === "https:" || localHttp) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.origin !== appOrigin
      ) {
        return url.href;
      }
    } catch {
      // Invalid configuration uses the safe destination below.
    }
  }
  return appOrigin === officialAppOrigin ? `${officialSiteOrigin}/` : "/signed-out";
}

type SignOutResult = { error?: { message?: string | undefined } | null };

export async function completeSignOut({
  signOut,
  clearAuthAttempt,
  redirect,
  destination,
}: {
  signOut: () => Promise<SignOutResult>;
  clearAuthAttempt: () => void;
  redirect: (destination: string) => void;
  destination: string;
}) {
  const result = await signOut();
  if (result.error) throw new Error(result.error.message || "Could not sign out. Try again.");
  clearAuthAttempt();
  redirect(destination);
}
