import { Meta, Title } from "@solidjs/meta";
import { Show } from "solid-js";
import { createEffect } from "solid-js";
import Wordmark from "~/components/Wordmark";
import { authClient } from "~/lib/auth";

export default function Home() {
  const session = authClient.useSession();

  const isSignedOut = () =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("signedOut");

  createEffect(() => {
    const currentSession = session();

    if (typeof window === "undefined" || currentSession.isPending || isSignedOut()) return;

    window.location.replace(currentSession.data ? "/dashboard" : "/auth/github");
  });

  return (
    <>
      <Title>plansplease</Title>
      <Meta
        name="description"
        content="Your private plansplease workspace for HTML pages made by your coding agent."
      />
      <Show
        when={isSignedOut()}
        fallback={
          <main class="auth-loading" aria-live="polite">
            <span class="signal-dot" aria-hidden="true" />
            Opening your workspace...
          </main>
        }
      >
        <main class="signed-out-page">
          <Wordmark />
          <h1>You're signed out.</h1>
          <p>Return to your private workspace whenever you are ready.</p>
          <a class="dashboard-link" href="/auth/github">
            Sign in with GitHub <span aria-hidden="true">→</span>
          </a>
        </main>
      </Show>
    </>
  );
}
