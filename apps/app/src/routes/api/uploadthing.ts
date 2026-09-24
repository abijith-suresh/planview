import { createRouteHandler } from "uploadthing/server";

import { uploadRouter } from "~/server/uploadthing";

const handler = createRouteHandler({
  router: uploadRouter,
  config: {
    ...(process.env["UPLOADTHING_TOKEN"] === undefined
      ? {}
      : { token: process.env["UPLOADTHING_TOKEN"] }),
    ...(process.env["UPLOADTHING_CALLBACK_URL"] === undefined
      ? {}
      : { callbackUrl: process.env["UPLOADTHING_CALLBACK_URL"] }),
  },
});

export const GET = ({ request }: { request: Request }) => handler(request);
export const POST = ({ request }: { request: Request }) => handler(request);
