import { fetchClientMetadataResource } from "@better-auth/cimd/node";

import { createCimdFetchHandler } from "~/lib/cimd-fetch-handler";

export const POST = createCimdFetchHandler(
  fetchClientMetadataResource,
  process.env["CIMD_FETCH_SECRET"]
);
