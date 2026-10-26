import type { ComponentPropsWithRef } from "react";

type SliderProps = Omit<
  ComponentPropsWithRef<"input">,
  "type" | "value" | "min" | "max"
> & {
  value: number;
  min: number;
  max: number;
};

export function Slider({
  value,
  min,
  max,
  className = "",
  style,
  ...props
}: SliderProps) {
  const progress =
    max > min
      ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
      : 0;
  return (
    <input
      {...props}
      type="range"
      value={value}
      min={min}
      max={max}
      className={`ui-slider ${className}`.trim()}
      style={{
        backgroundImage: `linear-gradient(to right, var(--accent) ${progress}%, var(--border) ${progress}%)`,
        ...style,
      }}
    />
  );
}
