import { Meta, Title } from "@solidjs/meta";
import { createEffect } from "solid-js";
import { authClient } from "~/lib/auth";
import { clearAuthAttemptCookie, hasAuthAttemptCookie } from "~/lib/auth-attempt";

export default function Home() {
  const session = authClient.useSession();

  createEffect(() => {
    const currentSession = session();

    if (typeof window === "undefined" || currentSession.isPending) return;
    if (currentSession.error) return;
    if (currentSession.data) document.cookie = clearAuthAttemptCookie;

    window.location.replace(
      currentSession.data
        ? "/dashboard"
        : hasAuthAttemptCookie(document.cookie)
          ? "/auth/problem"
          : "/auth/github"
    );
  });

  return (
    <>
      <Title>plansplease</Title>
      <Meta
        name="description"
        content="Your plansplease workspace for HTML pages made by your coding agent."
      />
      <main class="auth-loading" aria-live="polite">
        {session().error ? (
          <p role="alert">Could not check your session. Refresh this page to try again.</p>
        ) : (
          <>
            <span class="signal-dot" aria-hidden="true" />
            Opening your workspace...
          </>
        )}
      </main>
    </>
  );
}
