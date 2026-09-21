import { createEffect } from "solid-js";

import { authClient } from "~/lib/auth";

export function useWorkspaceAuth() {
  const session = authClient.useSession();
  let authRedirectStarted = false;
  let isSigningOut = false;

  const redirectToSignIn = () => {
    if (typeof window !== "undefined") window.location.assign("/auth/github");
  };

  createEffect(() => {
    const currentSession = session();

    if (currentSession.isPending) return;

    if (!currentSession.data && !isSigningOut && !authRedirectStarted) {
      authRedirectStarted = true;
      redirectToSignIn();
    }
  });

  const signOut = async () => {
    isSigningOut = true;

    try {
      await authClient.signOut();
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
