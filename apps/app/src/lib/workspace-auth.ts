import { createEffect } from "solid-js";

import { authClient } from "~/lib/auth";
import { clearAuthAttemptCookie, hasAuthAttemptCookie } from "~/lib/auth-attempt";
import { completeSignOut, signOutDestination } from "~/lib/sign-out-navigation";

export function useWorkspaceAuth() {
  const session = authClient.useSession();
  let authRedirectStarted = false;
  let isSigningOut = false;

  const redirectToSignIn = () => {
    if (typeof window === "undefined") return;
    window.location.assign(
      hasAuthAttemptCookie(document.cookie) ? "/auth/problem" : "/auth/github"
    );
  };

  createEffect(() => {
    const currentSession = session();

    if (currentSession.isPending) return;

    if (currentSession.data) {
      document.cookie = clearAuthAttemptCookie;
      return;
    }

    if (currentSession.error) return;

    if (!isSigningOut && !authRedirectStarted) {
      authRedirectStarted = true;
      redirectToSignIn();
    }
  });

  const signOut = async () => {
    isSigningOut = true;

    try {
      await completeSignOut({
        signOut: () => authClient.signOut(),
        clearAuthAttempt: () => {
          document.cookie = clearAuthAttemptCookie;
        },
        redirect: (destination) => window.location.assign(destination),
        destination: signOutDestination(
          window.location.origin,
          import.meta.env.VITE_PUBLIC_SITE_URL
        ),
      });
    } catch (error) {
      isSigningOut = false;
      throw error;
    }
  };

  const userName = () => session().data?.user.name || session().data?.user.email || "Workspace";
  const userInitial = () => userName().slice(0, 1).toUpperCase();

  return { session, redirectToSignIn, signOut, userName, userInitial };
}
