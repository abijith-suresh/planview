import assert from "node:assert/strict";
import { test } from "node:test";

import { completeSignOut, signOutDestination } from "../src/lib/sign-out-navigation.ts";

const appOrigin = "https://plansplease-app-staging.up.railway.app";
const marketingOrigin = "https://plansplease-site-staging.up.railway.app/";

test("official staging sign-out returns to marketing while self-hosting stays local", () => {
  assert.equal(signOutDestination(appOrigin), marketingOrigin);
  assert.equal(signOutDestination("https://plans.example"), "/signed-out");
  assert.equal(signOutDestination("http://localhost:3000"), "/signed-out");
  assert.equal(
    signOutDestination("https://plans.example", "https://www.example/plans/"),
    "https://www.example/plans/"
  );
  assert.equal(
    signOutDestination("http://localhost:3000", "http://localhost:4321"),
    "http://localhost:4321/"
  );
});

test("invalid or app-origin destinations cannot start a login loop", () => {
  for (const configured of [
    "javascript:alert(1)",
    "//evil.example",
    "http://public.example",
    "https://user:password@example.com",
    "https://www.example/?token=secret",
    "https://www.example/#token",
    `${appOrigin}/`,
    `${appOrigin}/dashboard`,
  ]) {
    assert.equal(signOutDestination(appOrigin, configured), marketingOrigin);
  }
  assert.equal(
    signOutDestination("https://plans.example", "https://plans.example/"),
    "/signed-out"
  );
});

test("successful sign-out clears the attempt marker and navigates only after the session ends", async () => {
  const events: string[] = [];
  await completeSignOut({
    signOut: async () => {
      events.push("session ended");
      return { error: null };
    },
    clearAuthAttempt: () => {
      events.push("marker cleared");
    },
    redirect: (destination) => {
      events.push(destination);
    },
    destination: signOutDestination(appOrigin),
  });
  assert.deepEqual(events, ["session ended", "marker cleared", marketingOrigin]);
});

test("returned and thrown auth errors keep the page and marker untouched", async () => {
  for (const signOut of [
    async () => ({ error: { message: "Session revocation failed" } }),
    async (): Promise<never> => {
      throw new Error("Session revocation failed");
    },
  ]) {
    await assert.rejects(
      completeSignOut({
        signOut,
        clearAuthAttempt: () => assert.fail("must keep marker"),
        redirect: () => assert.fail("must stay on page"),
        destination: marketingOrigin,
      }),
      /Session revocation failed/
    );
  }
});
