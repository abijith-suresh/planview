import { createEffect } from "solid-js";

import { authClient } from "~/lib/auth";
import { clearAuthAttemptCookie, hasAuthAttemptCookie } from "~/lib/auth-attempt";

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

    if (currentSession.data) return;

    if (!isSigningOut && !authRedirectStarted) {
      authRedirectStarted = true;
      redirectToSignIn();
    }
  });

  const signOut = async () => {
    isSigningOut = true;

    try {
      await authClient.signOut();
      document.cookie = clearAuthAttemptCookie;
      window.location.assign("/signed-out");
    } catch (error) {
      isSigningOut = false;
      throw error;
    }
  };

  const userName = () => session().data?.user.name || session().data?.user.email || "Workspace";
  const userInitial = () => userName().slice(0, 1).toUpperCase();

  return { session, redirectToSignIn, signOut, userName, userInitial };
}
