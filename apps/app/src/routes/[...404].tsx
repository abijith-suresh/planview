import { Title } from "@solidjs/meta";
import { A, useLocation } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { onMount } from "solid-js";

const loginAliases = new Set(["/signin", "/sign-in", "/auth/login", "/log-in"]);

export default function NotFound() {
  const location = useLocation();
  const normalizedPath = () => location.pathname.replace(/\/+$/, "") || "/";
  const isLoginAlias = () => loginAliases.has(normalizedPath());

  onMount(() => {
    if (isLoginAlias()) window.location.replace("/");
  });

  return (
    <main class="panel-page">
      <Title>Not Found</Title>
      <HttpStatusCode code={404} />
      <p class="eyebrow">
        <span class="signal-dot" aria-hidden="true" /> 404 / nowhere to keep this
      </p>
      <h1>That address is still empty.</h1>
      <p class="panel-lede">
        {isLoginAlias()
          ? "The sign-in screen moved to the front door — taking you there."
          : "Try returning to the workspace entrance."}
      </p>
      <div class="panel-actions">
        <A class="button-secondary" href="/">
          Return home <span aria-hidden="true">↗</span>
        </A>
      </div>
    </main>
  );
}
