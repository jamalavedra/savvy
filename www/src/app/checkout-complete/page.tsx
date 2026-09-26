import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Return to Savvy | Savvy",
  description: "Return to the desktop app and refresh your account to check payment status.",
  robots: { index: false, follow: false },
};

export default function CheckoutReturn() {
  return (
    <main className="min-h-screen bg-[#fbfbfb] px-4 py-14 text-sm text-[#0f0f0f] dark:bg-[#2c2b29] dark:text-[#fbfbfb]">
      <div className="mx-auto max-w-[420px]">
        <div className="text-center">
          <strong className="savvy-wordmark text-[40px]">savvy</strong>
        </div>
        <section
          aria-labelledby="return-title"
          className="mt-16 rounded-xl border border-[#dcdad8] bg-white p-5 dark:border-[#474643] dark:bg-[#302f2d]"
        >
          <h1 id="return-title" className="text-[22px] font-semibold leading-tight">
            Return to Savvy
          </h1>
          <p className="mt-6 leading-relaxed text-[#69655f] dark:text-[#c6c2bc]">
            Open Savvy to check your payment. It may still be pending.
          </p>
          <a
            className="mt-8 flex min-h-11 items-center justify-center rounded-lg border border-[#e8697a] bg-[#f9b5bb] px-3 py-2.5 text-center font-semibold text-[#1f1f1f] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#aa3d50] dark:border-[#f9a3ab] dark:bg-[#f9a3ab] dark:focus-visible:outline-[#f9a3ab]"
            href="com.alamaslabs.savvy:/billing/return"
          >
            Open Savvy
          </a>
          <p className="mt-8 leading-relaxed text-[#69655f] dark:text-[#c6c2bc]">
            If nothing opens, select Savvy in your Dock or Applications folder.
          </p>
        </section>
        <div className="mt-6 space-y-4 leading-relaxed text-[#69655f] dark:text-[#c6c2bc]">
          <p>
            In Account, choose Refresh account. This page does not confirm payment. Allowance
            appears only after Savvy verifies payment with Stripe.
          </p>
          <p>
            If payment is pending, refresh later or reopen the pending checkout. When allowance
            appears, explicitly resume any paused meeting.
          </p>
          <a
            className="inline-flex min-h-11 items-center text-[#aa3d50] underline focus-visible:outline-2 focus-visible:outline-offset-4 dark:text-[#f9a3ab]"
            href="/pricing/"
          >
            View pricing
          </a>
        </div>
      </div>
    </main>
  );
}
