import { createUploadthing, UploadThingError, UTFiles } from "uploadthing/server";
import { z } from "zod";

import { api, getAuthedConvexClient } from "~/lib/convex-server";

const f = createUploadthing();

export const uploadRouter = {
  htmlDocument: f(
    {
      "text/html": {
        maxFileSize: "8MB",
        maxFileCount: 1,
        minFileCount: 1,
        contentDisposition: "inline",
        // The free UploadThing tier is public-read. Application routes still
        // authorize workspace access before serving document previews.
        acl: "public-read",
      },
    },
    { awaitServerData: true }
  )
    .input(z.object({ title: z.string().trim().min(1).max(200) }))
    .middleware(async ({ req, input, files }) => {
      const { client, token } = await getAuthedConvexClient(req);

      if (!token) {
        throw new UploadThingError("Authentication required");
      }

      const identity = await client.query(api.auth.currentUser, {});

      if (!identity) {
        throw new UploadThingError("Authentication required");
      }

      return {
        ownerId: identity.subject,
        title: input.title,
        [UTFiles]: files.map((file) => ({
          ...file,
          // This gives the metadata-completion request a lightweight binding
          // to the authenticated uploader without coupling it to UploadThing.
          customId: `${identity.subject}:${crypto.randomUUID()}`,
        })),
      };
    })
    .onUploadComplete(async ({ metadata, file }) => ({
      ownerId: metadata.ownerId,
      customId: file.customId,
    })),
};

export type UploadRouter = typeof uploadRouter;
