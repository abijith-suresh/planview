// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";
import { readAppOrigin } from "~/lib/public-app-url";

// These public values describe the app, never the requested document or account.
const appOrigin = readAppOrigin(process.env["SITE_URL"]);
const socialImage = `${appOrigin}/social-preview.png?v=2`;
const socialTitle = "plansplease";
const socialDescription = "Review and manage the pages your agent makes.";
const socialImageAlt = "plansplease. Your pages, ready to review.";

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <link rel="icon" href="/favicon.ico?v=2" sizes="16x16 32x32 48x48" />
          <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" sizes="any" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2" sizes="180x180" />
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content="plansplease" />
          <meta property="og:title" content={socialTitle} />
          <meta property="og:description" content={socialDescription} />
          <meta property="og:url" content={`${appOrigin}/`} />
          <meta property="og:image" content={socialImage} />
          <meta property="og:image:type" content="image/png" />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:image:alt" content={socialImageAlt} />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content={socialTitle} />
          <meta name="twitter:description" content={socialDescription} />
          <meta name="twitter:image" content={socialImage} />
          <meta name="twitter:image:alt" content={socialImageAlt} />
          {assets}
        </head>
        <body>
          <div id="app">{children}</div>
          {scripts}
        </body>
      </html>
    )}
  />
));
