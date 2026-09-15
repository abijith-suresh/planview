import { Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";

export default function NotFound() {
  return (
    <main class="not-found">
      <Title>Not Found</Title>
      <HttpStatusCode code={404} />
      <p class="eyebrow">
        <span class="signal-dot" aria-hidden="true" /> 404 / nowhere to keep this
      </p>
      <h1>That address is still empty.</h1>
      <p>Try returning to the workspace entrance.</p>
      <A class="dashboard-link" href="/">
        Return home <span aria-hidden="true">↗</span>
      </A>
    </main>
  );
}
