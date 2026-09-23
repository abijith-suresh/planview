import type { Stats } from "node:fs";

export type FileIdentity = Pick<Stats, "dev" | "ino" | "birthtimeMs">;

export const usableBirthtime = (value: number) => Number.isFinite(value) && value > 0;

export const sameFileIdentity = (left: FileIdentity, right: FileIdentity) => {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    return false;
  }

  // Device/inode is the usual POSIX identity, but birthtime distinguishes an
  // inode that has been recycled while both observations retain the same
  // device/inode pair. Node exposes birthtimeMs on the supported platforms;
  // if it reports a non-positive/non-finite value, fall back to dev/ino rather
  // than claiming creation-time precision on a platform that does not provide it.
  const leftBirthtime = usableBirthtime(left.birthtimeMs) ? left.birthtimeMs : undefined;
  const rightBirthtime = usableBirthtime(right.birthtimeMs) ? right.birthtimeMs : undefined;
  if (leftBirthtime !== undefined && rightBirthtime !== undefined) {
    return leftBirthtime === rightBirthtime;
  }

  // When birthtime is unavailable, dev/ino is still useful if the filesystem
  // reports either component. With all three fields unavailable there is no
  // identity proof, so cleanup must fail closed.
  return left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0;
};
