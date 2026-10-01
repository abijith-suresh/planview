import { createApi } from "@convex-dev/better-auth";

import { createAuthOptions } from "../authConfig";
import schema from "./schema";

export const { create, findOne, findMany, updateOne, updateMany, deleteOne, deleteMany } =
  createApi(schema, createAuthOptions as Parameters<typeof createApi>[1]);
