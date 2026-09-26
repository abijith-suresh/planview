import { createAuth } from "../authConfig";

// Used by the Better Auth CLI to generate this local component's schema.
export const auth = createAuth({} as Parameters<typeof createAuth>[0]);
