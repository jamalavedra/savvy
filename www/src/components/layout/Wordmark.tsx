import Link from "next/link";

/** The app's sidebar lockup (`.savvy-wordmark`), lowercase and tilted. */
export function Wordmark({ size = 28, href = "/" }: { size?: number; href?: string }) {
  return (
    <Link href={href} aria-label="Savvy home" className="inline-flex items-center">
      <span className="savvy-wordmark" style={{ fontSize: size }}>
        savvy
      </span>
    </Link>
  );
}
