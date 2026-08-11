import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

const [lockPath] = process.argv.slice(2);
const now = Date.now();
await mkdir(lockPath);
await writeFile(
  `${lockPath}/owner.json`,
  JSON.stringify({
    version: 1,
    owner: { pid: process.pid, host: hostname(), token: "crashed-owner" },
    acquiredAt: now - 60_000,
    leaseExpiresAt: now - 30_000,
  })
);
process.exitCode = 42;
