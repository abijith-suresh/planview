import { hostname } from "node:os";

export const LOCAL_HOSTNAME = hostname();

export const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but cannot be probed. Treat every result
    // other than a definite ESRCH as alive so recovery never guesses.
    const code =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : undefined;
    return code !== "ESRCH";
  }
};
