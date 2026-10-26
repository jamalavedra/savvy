import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Slider } from "./Slider";

it("fills the rail within its bounds, including a zero-length recording", () => {
  const { rerender } = render(
    <Slider aria-label="Position" min={0} max={10} value={5} readOnly />,
  );
  const slider = screen.getByRole("slider", { name: "Position" });
  expect(slider.style.backgroundImage).toContain("50%");
  rerender(
    <Slider aria-label="Position" min={0} max={10} value={20} readOnly />,
  );
  expect(slider.style.backgroundImage).toContain("100%");
  rerender(<Slider aria-label="Position" min={0} max={0} value={0} readOnly />);
  expect(slider.style.backgroundImage).toContain("0%");
  expect(slider.style.backgroundImage).not.toMatch(/NaN|Infinity/);
});

it("preserves native range labels, focus, change events and disabled state", () => {
  const ref = createRef<HTMLInputElement>();
  const change = vi.fn();
  const { rerender } = render(
    <Slider
      ref={ref}
      aria-label="Volume"
      min={0}
      max={1}
      step={0.05}
      value={0.5}
      onChange={change}
    />,
  );
  ref.current?.focus();
  const slider = screen.getByRole("slider", { name: "Volume" });
  expect(slider).toHaveFocus();
  fireEvent.change(slider, { target: { value: "0.75" } });
  expect(change).toHaveBeenCalledOnce();
  rerender(<Slider aria-label="Volume" min={0} max={1} value={0.5} disabled />);
  expect(slider).toBeDisabled();
});
