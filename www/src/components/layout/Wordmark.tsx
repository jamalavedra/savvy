import Link from "next/link";

export function Wordmark({ size }: { size: number }) {
  return (
    <Link href="/" aria-label="Savvy home" className="inline-flex items-center">
      <span className="savvy-wordmark" style={{ fontSize: size }}>
        savvy
      </span>
    </Link>
  );
}
