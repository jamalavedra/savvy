import Image from "next/image";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <Image src="/images/mascot/savvy-muted.png" alt="" width={96} height={96} />
      <h1 className="text-3xl font-medium tracking-tight">Nothing here</h1>
      <p className="text-sm text-muted">
        Savvy checked its notes and this page isn&apos;t in them.
      </p>
      <Link
        href="/"
        className="rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background hover:opacity-80"
      >
        Back to the homepage
      </Link>
    </main>
  );
}
