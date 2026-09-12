import { Effect } from "effect";
import { openDocumentFileStore } from "../dist/index.js";

const [sourcePath, documentsDir, stagingDir] = process.argv.slice(2);
if (sourcePath === undefined || documentsDir === undefined || stagingDir === undefined) {
  throw new Error("The FIFO stage worker requires source, documents, and staging paths.");
}

try {
  const store = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
  try {
    await store.stageSourceFile(sourcePath);
    process.exitCode = 1;
  } finally {
    store.close();
  }
} catch {
  process.exitCode = 0;
}
