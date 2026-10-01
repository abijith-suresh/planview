import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "retry pending document deletions",
  { minutes: 1 },
  internal.documents.reconcileDeletions
);

crons.interval(
  "retry abandoned upload cleanup",
  { minutes: 1 },
  internal.documents.reconcileUploads
);

export default crons;
