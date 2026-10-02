import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const icon = await readFile(new URL("assets/brand/icon.svg", root));
const sizes = [16, 32, 48];
const frames = await Promise.all(
  sizes.map((size) => sharp(icon).resize(size, size).png().toBuffer())
);
const directory = Buffer.alloc(6 + frames.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(frames.length, 4);
let offset = directory.length;
for (const [index, frame] of frames.entries()) {
  const start = 6 + index * 16;
  directory[start] = sizes[index];
  directory[start + 1] = sizes[index];
  directory.writeUInt16LE(1, start + 4);
  directory.writeUInt16LE(32, start + 6);
  directory.writeUInt32LE(frame.length, start + 8);
  directory.writeUInt32LE(offset, start + 12);
  offset += frame.length;
}
const ico = Buffer.concat([directory, ...frames]);

for (const app of ["site", "app", "docs"]) {
  const publicDirectory = new URL(`apps/${app}/public/`, root);
  await writeFile(new URL("favicon.svg", publicDirectory), icon);
  await writeFile(new URL("favicon.ico", publicDirectory), ico);
  for (const [filename, size] of [
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ]) {
    await sharp(icon)
      .resize(size, size)
      .flatten({ background: "#0c0c0e" })
      .png()
      .toFile(fileURLToPath(new URL(filename, publicDirectory)));
  }
  await sharp(fileURLToPath(new URL(`assets/brand/social-${app}.svg`, root)))
    .png()
    .toFile(fileURLToPath(new URL("social-preview.png", publicDirectory)));
}
process.stdout.write(
  "Generated favicons, touch icons and social previews for site, app and docs.\n"
);
