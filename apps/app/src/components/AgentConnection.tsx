import { createSignal, createUniqueId, onMount, Show } from "solid-js";

import Icon from "~/components/Icon";

export default function AgentConnection() {
  const id = createUniqueId();
  const [method, setMethod] = createSignal<"mcp" | "cli">("mcp");
  const [endpoint, setEndpoint] = createSignal("");
  const [message, setMessage] = createSignal("");
  const mcpId = `${id}-mcp`;
  const cliId = `${id}-cli`;

  onMount(() => setEndpoint(new URL("/mcp", window.location.origin).href));

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(endpoint());
      setMessage("Endpoint copied.");
    } catch {
      setMessage("Select the endpoint and copy it manually.");
    }
  };

  return (
    <section class="card connection-card" id="connect-agent" aria-labelledby={`${id}-title`}>
      <div class="connection-heading">
        <h2 id={`${id}-title`}>Connect your agent</h2>
        <fieldset class="connection-methods">
          <legend class="sr-only">Connection method</legend>
          <button
            type="button"
            aria-pressed={method() === "mcp"}
            aria-controls={mcpId}
            onClick={() => {
              setMethod("mcp");
              setMessage("");
            }}
          >
            MCP
          </button>
          <button
            type="button"
            aria-pressed={method() === "cli"}
            aria-controls={cliId}
            onClick={() => {
              setMethod("cli");
              setMessage("");
            }}
          >
            CLI
          </button>
        </fieldset>
      </div>
      <Show
        when={method() === "mcp"}
        fallback={
          <div id={cliId}>
            <p>Install, sign in, then upload a page.</p>
            <pre class="connection-code">
              <code>
                {
                  "npm install --global @abijith-suresh/planview\nplanview login\nplanview upload ./page.html"
                }
              </code>
            </pre>
          </div>
        }
      >
        <div id={mcpId}>
          <p>Add this remote MCP server to your agent, then sign in and approve access.</p>
          <div class="endpoint-field">
            <code>{endpoint() || "Loading endpoint…"}</code>
            <button
              class="icon-button"
              type="button"
              disabled={!endpoint()}
              aria-label="Copy MCP endpoint"
              title="Copy MCP endpoint"
              onClick={() => void copyEndpoint()}
            >
              <Icon name="copy" />
            </button>
          </div>
          <p class="page-note">Your agent can list, read, upload, and delete your documents.</p>
        </div>
      </Show>
      <p class="connection-feedback" role="status" aria-live="polite">
        {message()}
      </p>
      <p class="page-note alpha-note">Cloud file URLs are public during alpha.</p>
    </section>
  );
}
