import { Meta, Title } from "@solidjs/meta";

export default function AuthProblem() {
  return (
    <>
      <Title>Sign-in interrupted | plansplease</Title>
      <Meta name="robots" content="noindex" />
      <main class="signed-out-page">
        <span class="wordmark">plansplease</span>
        <h1>Sign-in didn't finish.</h1>
        <p>
          Your workspace session could not be confirmed. If GitHub is limiting requests, wait before
          trying again.
        </p>
        <p>For cloud agent access, start authorization again from your agent after signing in.</p>
        <a class="dashboard-link" href="/auth/github">
          Try GitHub sign-in again <span aria-hidden="true">→</span>
        </a>
      </main>
    </>
  );
}
