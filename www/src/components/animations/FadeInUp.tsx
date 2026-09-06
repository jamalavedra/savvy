import type { ReactNode } from "react";

export function FadeInUp({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div className={`fade-in-up ${className}`} style={{ animationDelay: `${delay}s` }}>
      {children}
    </div>
  );
}
