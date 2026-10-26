import type { ComponentPropsWithRef } from "react";

export type ButtonVariant =
  "primary" | "secondary" | "danger" | "ghost" | "plain";

export function Button({
  variant = "secondary",
  type = "button",
  className = "",
  ...props
}: ComponentPropsWithRef<"button"> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      type={type}
      className={
        variant === "plain"
          ? className
          : `button ${variant} ${className}`.trim()
      }
    />
  );
}

export function Input({
  className = "",
  ...props
}: ComponentPropsWithRef<"input">) {
  return <input {...props} className={`ui-input ${className}`.trim()} />;
}

export function Textarea({
  className = "",
  ...props
}: ComponentPropsWithRef<"textarea">) {
  return <textarea {...props} className={`ui-textarea ${className}`.trim()} />;
}

export { Select } from "./Select";
export { Slider } from "./Slider";

export function Alert({
  variant = "error",
  role,
  className = "",
  ...props
}: ComponentPropsWithRef<"div"> & {
  variant?: "error" | "warning" | "success" | "info";
}) {
  return (
    <div
      {...props}
      role={
        role ??
        (variant === "error" || variant === "warning" ? "alert" : "status")
      }
      className={`ui-alert ui-alert-${variant} ${className}`.trim()}
    />
  );
}
