"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

// Stable component identities: creating these per render (motion.create(as))
// gives a new component each time, so any parent re-render remounts the
// subtree and replays the entrance animation.
const MOTION = {
  div: motion.div,
  li: motion.li,
  section: motion.section,
} as const;

export function FadeInUp({
  children,
  delay = 0,
  className,
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: keyof typeof MOTION;
}) {
  const Component = MOTION[as];

  return (
    <Component
      // y-only: content stays visible even if the animation never runs.
      initial={{ y: 16 }}
      whileInView={{ y: 0 }}
      viewport={{ once: true, margin: "-10%" }}
      transition={{ duration: 0.6, ease: [0.25, 0.1, 0.35, 1], delay }}
      className={className}
    >
      {children}
    </Component>
  );
}
