import { parentPort, workerData } from "node:worker_threads";
import { Effect } from "effect";
import { openStorage } from "../dist/index.js";

parentPort.postMessage("ready");
await new Promise((resolve) => parentPort.once("message", resolve));
parentPort.postMessage("opening");
const storage = Effect.runSync(openStorage(workerData.databasePath));
parentPort.postMessage("opened");
await new Promise((resolve) => parentPort.once("message", resolve));
storage.close();
parentPort.postMessage("closed");
