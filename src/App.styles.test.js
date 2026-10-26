import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const appStyles = readFileSync("src/App.css", "utf8");

it("keeps both theme palettes' semantic text above the AA contrast threshold", () => {
  function luminance(hex) {
    const rgb = [1, 3, 5].map(
      (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
    );
    return rgb.reduce(
      (sum, channel, index) =>
        sum +
        [0.2126, 0.7152, 0.0722][index] *
          (channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4),
      0,
    );
  }
  for (const theme of ["light", "dark"]) {
    const background = appStyles.match(
      new RegExp(`--${theme}-background:\\s*(#[0-9a-f]{6})`, "i"),
    )[1];
    for (const token of ["text", "muted", "success", "warning", "danger"]) {
      const foreground = appStyles.match(
        new RegExp(`--${theme}-${token}:\\s*(#[0-9a-f]{6})`, "i"),
      )[1];
      const values = [luminance(background), luminance(foreground)].sort(
        (left, right) => left - right,
      );
      expect(
        (values[1] + 0.05) / (values[0] + 0.05),
        `${theme} ${token}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});
