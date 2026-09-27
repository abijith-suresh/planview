import { Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";

export default function NotFound() {
  return (
    <main class="panel-page">
      <Title>Not Found</Title>
      <HttpStatusCode code={404} />
      <p class="eyebrow">
        <span class="signal-dot" aria-hidden="true" /> 404 / nowhere to keep this
      </p>
      <h1>That address is still empty.</h1>
      <p class="panel-lede">Try returning to the workspace entrance.</p>
      <div class="panel-actions">
        <A class="button-secondary" href="/">
          Return home <span aria-hidden="true">↗</span>
        </A>
      </div>
    </main>
  );
}
