import { Meta, Title } from "@solidjs/meta";

export default function SignedOut() {
  return (
    <>
      <Title>Signed out | plansplease</Title>
      <Meta
        name="description"
        content="You have signed out of your plansplease workspace."
      />
      <main class="signed-out-page">
        <span class="wordmark">plansplease</span>
        <h1>You're signed out.</h1>
        <p>Return to your private workspace whenever you are ready.</p>
        <a class="dashboard-link" href="/auth/github">
          Sign in with GitHub <span aria-hidden="true">→</span>
        </a>
      </main>
    </>
  );
}
