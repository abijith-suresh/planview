import { createRouteHandler } from "uploadthing/server";

import { uploadRouter } from "~/server/uploadthing";

const handler = createRouteHandler({
  router: uploadRouter,
  config: {
    token: process.env.UPLOADTHING_TOKEN,
    callbackUrl: process.env.UPLOADTHING_CALLBACK_URL,
  },
});

export const GET = ({ request }: { request: Request }) => handler(request);
export const POST = ({ request }: { request: Request }) => handler(request);
