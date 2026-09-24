import { convexSiteUrl } from "~/lib/convex-server";
import { startGitHubSignIn } from "~/lib/github-sign-in";

export const GET = ({ request }: { request: Request }) =>
  startGitHubSignIn(request, {
    convexSiteUrl,
    railwayPublicDomain: process.env["RAILWAY_PUBLIC_DOMAIN"],
  });
