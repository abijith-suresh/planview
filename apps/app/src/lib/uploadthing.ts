import { generateSolidHelpers } from "@uploadthing/solid";

import type { UploadRouter } from "~/server/uploadthing";

export const { createUploadThing } = generateSolidHelpers<UploadRouter>({
  url: "/api/uploadthing",
  fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
});
