import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { createEffect, createMemo, Show } from "solid-js";

import Icon from "~/components/Icon";
import { authClient } from "~/lib/auth";

export default function Home() {
  const session = authClient.useSession();

  createEffect(() => {
    const currentSession = session();

    if (typeof window === "undefined" || currentSession.isPending || !currentSession.data) return;

    window.location.replace("/dashboard");
  });

  const isSignedOut = createMemo(() => {
    const currentSession = session();
    return !currentSession.isPending && !currentSession.data;
  });

  return (
    <>
      <Title>plansplease | Keep the pages your agent makes</Title>
      <Meta name="description" content="Sign in to your plansplease workspace." />
      <Show
        when={isSignedOut()}
        fallback={
          <main class="auth-loading" aria-live="polite">
            <span class="signal-dot" aria-hidden="true" />
            Opening your workspace...
          </main>
        }
      >
        <main class="sign-in-panel">
          <div class="sign-in-shell">
            <A class="wordmark" href="/">
              <span class="brand-name">
                <span class="brand-plans">plans</span>
                <span class="brand-please">please</span>
              </span>
            </A>
            <h1>Sign in to your private workspace.</h1>
            <div class="sign-in-actions">
              <a class="button-primary" href="/auth/github">
                <Icon name="github" size={18} />
                <span>Continue with GitHub</span>
              </a>
            </div>
          </div>
        </main>
      </Show>
    </>
  );
}
