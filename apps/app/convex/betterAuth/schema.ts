import { defineSchema } from "convex/server";

import { tables as latestTables } from "./generatedSchema";
import { tables as legacyTables } from "./legacySchema";

export const tables = {
  ...legacyTables,
  ...latestTables,
  // Existing users may have optional fields from the bundled component's schema.
  user: legacyTables.user,
};

export default defineSchema(tables);
