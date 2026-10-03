import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStaticDocsServer } from "./server/static-server.mjs";

const rootDirectory = fileURLToPath(new URL("./dist/", import.meta.url));
const { basePath } = JSON.parse(
  await readFile(new URL("./dist/docs-runtime.json", import.meta.url), "utf8")
);
const port = Number(process.env.PORT ?? "4322");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535");
const server = await createStaticDocsServer({ rootDirectory, basePath });
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`plansplease docs listening on ${port}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    server.close();
    const timer = setTimeout(() => server.closeAllConnections(), 5000);
    timer.unref();
  });
}
