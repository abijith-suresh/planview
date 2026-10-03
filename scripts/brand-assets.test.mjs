import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import sharp from "sharp";

test("all three apps serve matching icons and correctly sized preview images", async () => {
  const expectedIcon = await readFile(new URL("../assets/brand/icon.svg", import.meta.url));
  let expectedIco;
  for (const app of ["site", "app", "docs"]) {
    const directory = new URL(`../apps/${app}/public/`, import.meta.url);
    assert.deepEqual(await readFile(new URL("favicon.svg", directory)), expectedIcon);
    const ico = await readFile(new URL("favicon.ico", directory));
    expectedIco ??= ico;
    assert.deepEqual(ico, expectedIco);
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 3);
    for (const [index, size] of [16, 32, 48].entries()) {
      const entry = 6 + index * 16;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      assert.ok(offset + length <= ico.length, "ICO frame stays within the file");
      const image = await sharp(ico.subarray(offset, offset + length)).metadata();
      assert.equal(image.width, size);
      assert.equal(image.height, size);
    }
    for (const [name, width, height] of [
      ["apple-touch-icon.png", 180, 180],
      ["icon-192.png", 192, 192],
      ["icon-512.png", 512, 512],
      ["social-preview.png", 1200, 630],
    ]) {
      const bytes = await readFile(new URL(name, directory));
      const image = await sharp(bytes).metadata();
      assert.equal(image.format, "png");
      assert.equal(image.width, width);
      assert.equal(image.height, height);
      assert.ok(bytes.length < 100_000, `${app}/${name} stays below 100 KB`);
      if (name === "apple-touch-icon.png") assert.equal(image.hasAlpha, false);
    }
  }
});
