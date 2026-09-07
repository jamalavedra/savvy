import type { ReactNode } from "react";

export function FadeInUp({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <div className="fade-in-up" style={{ animationDelay: `${delay}s` }}>
      {children}
    </div>
  );
}
