import { parentPort, workerData } from "node:worker_threads";
import { Effect } from "effect";
import { openStorage } from "../dist/index.js";

if (parentPort === null) {
  throw new Error("The concurrent opener worker requires a parent port.");
}
const port = parentPort;

const { databasePath } = workerData as { readonly databasePath: string };
port.postMessage("ready");
await new Promise<void>((resolve) => port.once("message", resolve));
port.postMessage("opening");
const storage = Effect.runSync(openStorage(databasePath));
port.postMessage("opened");
await new Promise<void>((resolve) => port.once("message", resolve));
storage.close();
port.postMessage("closed");
