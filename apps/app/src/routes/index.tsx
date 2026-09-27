import { Meta, Title } from "@solidjs/meta";
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
      <Meta
        name="description"
        content="Your agent made a page. Give it somewhere useful to live."
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
        <main class="sign-in-panel">
          <div class="sign-in-shell">
            <div class="sign-in-card">
              <div class="sign-in-copy">
                <p class="eyebrow">plansplease · private workspace</p>
                <h1>
                  Your agent made a page.
                  <span>Give it somewhere useful to live.</span>
                </h1>
                <p class="sign-in-lede">
                  Specs, dashboards, code reviews, tiny tools — your agent writes them as HTML.
                  Every file gets a URL: instant on your machine, private in the cloud, open from
                  your phone.
                </p>
                <div class="sign-in-actions">
                  <a class="button-primary" href="/auth/github">
                    <Icon name="github" size={18} />
                    <span>Continue with GitHub</span>
                  </a>
                </div>
                <p class="sign-in-note">
                  Free during alpha · GitHub sign-in only · Private by default
                </p>
              </div>
              <div
                class="term"
                role="img"
                aria-label="Terminal example: an agent publishes an HTML page with planview publish, which serves it at a local URL and saves a private copy to the workspace."
              >
                <div class="term-bar" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div class="term-body" aria-hidden="true">
                  <p class="tl is-prompt">
                    <span class="prompt-glyph">❯</span>
                    <span class="prompt-text">
                      keep the migration plan somewhere I can open later
                    </span>
                  </p>
                  <p class="tl is-step">
                    <span class="step-bullet">●</span> Wrote auth-migration-spec.html
                  </p>
                  <p class="tl is-step">
                    <span class="step-bullet">●</span> planview publish ./auth-migration-spec.html
                  </p>
                  <p class="tl">
                    <span class="check">✓</span> served at{" "}
                    <span class="url">http://localhost:4777/…</span>
                  </p>
                  <p class="tl">
                    <span class="check">✓</span> saved to workspace{" "}
                    <span class="url is-cloud">until you delete it</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </main>
      </Show>
    </>
  );
}
