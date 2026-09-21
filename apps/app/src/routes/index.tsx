import { Meta, Title } from "@solidjs/meta";
import { createEffect } from "solid-js";
import { authClient } from "~/lib/auth";

export default function Home() {
  const session = authClient.useSession();

  createEffect(() => {
    const currentSession = session();

    if (typeof window === "undefined" || currentSession.isPending) return;

    window.location.replace(currentSession.data ? "/dashboard" : "/auth/github");
  });

  return (
    <>
      <Title>plansplease</Title>
      <Meta
        name="description"
        content="Your private plansplease workspace for HTML pages made by your coding agent."
      />
      <main class="auth-loading" aria-live="polite">
        <span class="signal-dot" aria-hidden="true" />
        Opening your workspace...
      </main>
    </>
  );
}
