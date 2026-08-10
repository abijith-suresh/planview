import { chmodSync } from "node:fs";

const file = process.argv[2];
if (file === undefined) {
  throw new Error("An output file is required");
}

if (process.platform !== "win32") {
  chmodSync(file, 0o755);
}
