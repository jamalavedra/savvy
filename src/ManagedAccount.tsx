import ConfirmDialog from "./ConfirmDialog";
import catalog from "../config/managed-catalog.json";
import { useCallback, useEffect, useState, useRef } from "react";
import {
  getAppSettings,
  updateAppSettings,
  managedAccount,
  managedBilling,
  managedSignInBegin,
  managedSignInCancel,
  managedSignInFinish,
  managedSignOut,
} from "./lib/api";
import type { ManagedAccount as Account } from "./types";

export default function ManagedAccount({
  compact = false,
  pricingOnly = false,
}: {
  compact?: boolean;
  pricingOnly?: boolean;
}) {
  const [dismissedPurchase, setDismissedPurchase] = useState("");
  const accountHeading = useRef<HTMLHeadingElement>(null);
  const [showUsage, setShowUsage] = useState(false);
  const usageTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (showUsage) accountHeading.current?.focus();
  }, [showUsage]);
  const [showPlans, setShowPlans] = useState(false);
  const plansTrigger = useRef<HTMLButtonElement>(null);
  const plansHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (showPlans) plansHeading.current?.focus();
  }, [showPlans]);
  const [product, setProduct] = useState<"monthly" | "pack">("monthly");
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const refreshGeneration = useRef(0);
  const operationPending = useRef(false);
  const refresh = useCallback(async () => {
    if (operationPending.current) return;
    const generation = ++refreshGeneration.current;
    try {
      const next = await managedAccount();
      if (generation === refreshGeneration.current) {
        setAccount(next);
        setError("");
      }
    } catch (reason) {
      if (generation !== refreshGeneration.current) return;
      const message = String(reason);
      if (message.includes("sign_in_required")) {
        setAccount(null);
        setError("Sign in again to use Savvy managed.");
      } else if (message.includes("payment_pending"))
        setError("Payment is still processing. Refresh after confirmation.");
      else
        setError(
          "Savvy is offline. Reconnect to refresh your balance and use managed assistance.",
        );
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const onFocus = () => void refresh();
    const initial = window.setTimeout(onFocus, 0);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, compact ? 5000 : 60_000);
    return () => {
      window.clearTimeout(initial);
      refreshGeneration.current += 1;
      void managedSignInCancel().catch(() => undefined);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh, compact]);
  async function run(action: () => Promise<void>) {
    if (operationPending.current) return;
    operationPending.current = true;
    refreshGeneration.current += 1;
    setBusy(true);
    setError("");
    try {
      await action();
      operationPending.current = false;
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }
  const offers = account?.catalog ?? catalog;
  const unbilled = account?.catalog === null;
  const pending = (product: string) =>
    account?.pendingPurchases?.some((purchase) => purchase.product === product);
  const remaining = account
    ? account.meetingMsAvailable + account.meetingMsReserved
    : 0;
  const paymentPending =
    !!account?.paymentPending || !!account?.pendingPurchases?.length;
  const confirmedPurchase = account?.latestConfirmedPurchase;
  const purchaseKey = JSON.stringify([
    account?.identity?.issuer,
    account?.identity?.subject,
    account?.accountIdentity,
    confirmedPurchase?.attemptId,
  ]);
  const failedProduct =
    !paymentPending &&
    confirmedPurchase &&
    ["failed", "expired"].includes(confirmedPurchase.status) &&
    ["monthly", "pack"].includes(confirmedPurchase.product)
      ? (confirmedPurchase.product as "monthly" | "pack")
      : null;
  const recoveryVisible = !!failedProduct && dismissedPurchase !== purchaseKey;
  const noPlan =
    !!account &&
    !account.subscription &&
    remaining === 0 &&
    account.briefsAvailable === 0 &&
    !paymentPending &&
    !account.pendingPurchases?.length &&
    !account.latestConfirmedPurchase;
  const warning =
    account &&
    !noPlan &&
    (paymentPending && remaining <= 0
      ? "Assistance paused while payment is processing. Refresh after confirmation, then explicitly resume."
      : remaining <= 0
        ? "Assistance paused. Buy a pack, then explicitly resume your meeting."
        : remaining <= 120000
          ? "Two minutes or less remain."
          : remaining <= 600000
            ? "Ten minutes or less remain."
            : account.monthlyMsTotal > 0 &&
                account.monthlyMsUsed >= account.monthlyMsTotal * 0.8
              ? "80% of your included meeting time has been used."
              : "");
  const pricing = (
    <section
      className="settings-group managed-pricing"
      aria-label="Plans and pricing"
    >
      <fieldset disabled={busy}>
        <legend className="sr-only">Choose your allowance</legend>
        {(["monthly", "pack"] as const).map((option) => (
          <label
            key={option}
            className={`onboarding-provider managed-offer ${product === option ? "selected" : ""}`}
          >
            <input
              type="radio"
              name="managed-offer"
              checked={product === option}
              onChange={() => setProduct(option)}
            />
            <span>
              <span className="managed-offer-title">
                <strong>
                  {option === "monthly" ? "Monthly plan" : "Hours pack"}
                </strong>
                <strong>
                  ${offers[option].amountCents / 100}
                  {option === "monthly" ? " / month" : " once"}
                </strong>
              </span>
              {offers[option].hours} meeting hours and {offers[option].briefs}{" "}
              briefs.
              <span className="managed-offer-terms">
                {option === "monthly"
                  ? "Renews monthly. Included time expires at the period end."
                  : "One payment. No scheduled expiry."}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <p>
        Account creation is free. Checkout is a separate step, hosted by Stripe.
      </p>
      <button
        className="button primary"
        disabled={
          loading || busy || account?.purchaseAvailability?.[product] === false
        }
        onClick={() =>
          void run(async () => {
            if (!account) {
              const authorization = await managedSignInBegin();
              setAccount(await managedSignInFinish(authorization));
            }
            const settings = await getAppSettings();
            await updateAppSettings({ ...settings, serviceMode: "managed" });
            await managedBilling(product);
          })
        }
      >
        {busy
          ? "Opening…"
          : pending(product)
            ? "Reopen pending checkout"
            : "Continue to checkout"}
      </button>
      {busy && !account && (
        <button
          className="button secondary"
          onClick={() =>
            void managedSignInCancel().catch((reason) =>
              setError(String(reason)),
            )
          }
        >
          Cancel sign-in
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        Returning from checkout does not confirm payment. Refresh your account
        to check the result.
      </p>
    </section>
  );
  if (pricingOnly) return pricing;
  if (compact)
    return (
      <section aria-label="Managed assistance status">
        <p role="status" aria-live="polite">
          {error ||
            warning ||
            (account
              ? `${Math.floor(remaining / 60000)} managed minutes and ${account.briefsAvailable} briefs remain.`
              : loading
                ? "Loading your account…"
                : "Sign in to Savvy in Account before using managed assistance.")}
        </p>
        {unbilled ? (
          <p>This backend has no billing.</p>
        ) : (
          <>
            <button
              className="button secondary"
              disabled={busy || !account}
              onClick={() => void run(() => managedBilling("pack"))}
            >
              {pending("pack") ? "Retry pending hours pack" : "Buy hours pack"}
            </button>
            <p>After buying, explicitly resume paused assistance.</p>
          </>
        )}
      </section>
    );
  return (
    <section
      aria-label="Savvy managed account"
      className={`settings-group ${noPlan ? "managed-empty-account" : ""}`}
    >
      <h2 ref={accountHeading} tabIndex={-1}>
        {showUsage && account && !recoveryVisible
          ? "Plan and usage"
          : "Your account"}
      </h2>

      {loading && !account ? (
        <p role="status">Loading your account…</p>
      ) : !account ? (
        <>
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const authorization = await managedSignInBegin();
                setCode("waiting");
                setAccount(await managedSignInFinish(authorization));
                setCode("");
              })
            }
          >
            Sign in to Savvy
          </button>
          {code && (
            <>
              <p role="status">
                Continue sign-in in your browser. Your meeting stays paused.
              </p>
              <button
                className="button secondary"
                onClick={() =>
                  void managedSignInCancel()
                    .then(() => setCode(""))
                    .catch((reason) => setError(String(reason)))
                }
              >
                Cancel sign-in
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <p>
            Signed in as{" "}
            {account.identity?.name ??
              account.identity?.email ??
              account.accountIdentity ??
              "Synthetic demo account"}
            {!noPlan && !recoveryVisible && !paymentPending && (
              <>
                . {Math.floor(remaining / 60000)} meeting minutes and{" "}
                {account.briefsAvailable} briefs remain.
              </>
            )}
          </p>
          {!noPlan &&
            !recoveryVisible &&
            !paymentPending &&
            (account.allowances ? (
              <div className="managed-allowances">
                {(["monthly", "pack"] as const).map((kind) => {
                  const balance = account.allowances![kind];
                  const minutes = Math.floor(
                    (balance.meetingMsAvailable + balance.meetingMsReserved) /
                      60000,
                  );
                  const label =
                    kind === "monthly"
                      ? "Monthly remaining"
                      : "Purchased packs";
                  return (
                    <section
                      key={kind}
                      aria-label={label}
                      className="managed-empty-card"
                    >
                      <h3 className="group-title">{label}</h3>
                      <div className="managed-empty-balances">
                        <strong>
                          {Math.floor(minutes / 60)} h {minutes % 60} min
                        </strong>
                        <strong>{balance.briefsAvailable} briefs</strong>
                      </div>
                      <p>
                        {kind === "monthly"
                          ? "Included usage expires at the paid period end."
                          : "No scheduled expiry."}
                      </p>
                    </section>
                  );
                })}
              </div>
            ) : (
              <p>
                Monthly and pack breakdown is unavailable. The total balance
                above remains available.
              </p>
            ))}
          {account.subscription && !recoveryVisible && !paymentPending && (
            <p>
              Subscription: {account.subscription.status}.{" "}
              {account.subscription.cancelAtPeriodEnd ||
              account.subscription.status === "canceled"
                ? "Renewal canceled. Paid access ends"
                : account.subscription.status === "past_due"
                  ? "Payment overdue. Paid access ends"
                  : "Renews"}{" "}
              {account.subscription.paidThroughMs || account.periodEndMs
                ? new Date(
                    account.subscription.paidThroughMs ?? account.periodEndMs!,
                  ).toLocaleDateString()
                : "on a date not yet confirmed"}
              . Purchased packs remain available.
            </p>
          )}
          {paymentPending && (
            <section
              aria-label="Payment pending"
              className="managed-empty-card managed-payment-recovery"
            >
              <h3>
                {pending("pack") && !pending("monthly")
                  ? "Hours pack payment"
                  : pending("monthly") && !pending("pack")
                    ? "Monthly plan payment"
                    : "Payment confirmation"}
              </h3>
              <p role="status">Payment pending.</p>
              <p>
                We are checking your payment. You can keep using any remaining
                allowance.
              </p>
              <p>
                {Math.floor(remaining / 60000)} meeting minutes and{" "}
                {account.briefsAvailable} briefs remain.
              </p>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void refresh()}
              >
                Refresh account
              </button>
              {(["monthly", "pack"] as const).map((kind) =>
                pending(kind) ? (
                  <button
                    key={kind}
                    className="button secondary"
                    disabled={
                      busy || account.purchaseAvailability?.[kind] === false
                    }
                    onClick={() => void run(() => managedBilling(kind))}
                  >
                    {kind === "monthly"
                      ? "Retry pending monthly plan"
                      : "Retry pending hours pack"}
                  </button>
                ) : null,
              )}
              <p>
                Payment is confirmed by Savvy. Returning from the browser does
                not confirm it.
              </p>
            </section>
          )}
          {!noPlan && !recoveryVisible && !paymentPending && (
            <p>Updated {new Date(account.nowMs).toLocaleTimeString()}.</p>
          )}
          {warning && !recoveryVisible && (
            <p role="status" aria-live="polite">
              {warning}
            </p>
          )}
          {unbilled && <p>This backend has no billing.</p>}
          {!unbilled && !noPlan && !recoveryVisible && !paymentPending && (
            <>
              {!showUsage && !paymentPending && (
                <button
                  ref={usageTrigger}
                  className="button primary"
                  onClick={() => setShowUsage(true)}
                >
                  Plan and usage
                </button>
              )}
              {showUsage && (
                <section
                  aria-label="Hours pack offer"
                  className="managed-empty-card"
                >
                  <h3>Hours pack · ${offers.pack.amountCents / 100} once</h3>
                  <p>
                    {offers.pack.hours} meeting hours · {offers.pack.briefs}{" "}
                    briefs
                  </p>
                  <p>No scheduled expiry. Monthly allowance is used first.</p>
                </section>
              )}
              {(showUsage || paymentPending || failedProduct) && (
                <>
                  <button
                    className="button"
                    disabled={
                      busy ||
                      account.purchaseAvailability?.monthly === false ||
                      (!pending("monthly") &&
                        !!account.subscription &&
                        !["canceled", "incomplete_expired"].includes(
                          account.subscription.status,
                        ))
                    }
                    onClick={() => void run(() => managedBilling("monthly"))}
                  >
                    {pending("monthly")
                      ? "Retry pending monthly plan"
                      : "Monthly plan"}
                  </button>
                  <button
                    className="button secondary"
                    disabled={
                      busy || account.purchaseAvailability?.pack === false
                    }
                    onClick={() => void run(() => managedBilling("pack"))}
                  >
                    {pending("pack")
                      ? "Retry pending hours pack"
                      : "Buy hours pack"}
                  </button>
                </>
              )}
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void run(() => managedBilling("portal"))}
              >
                Manage billing
              </button>
              {showUsage && (
                <button
                  className="button secondary"
                  onClick={() => {
                    setShowUsage(false);
                    requestAnimationFrame(() => usageTrigger.current?.focus());
                  }}
                >
                  Back to account
                </button>
              )}
              <p>
                Checkout can take time to confirm. Returning from the browser
                does not activate allowance.
              </p>
            </>
          )}
        </>
      )}
      {noPlan && (
        <>
          <div className="managed-empty-card">
            <p className="group-title">No plan yet</p>
            <div className="managed-empty-balances">
              <strong>0 meeting hours</strong>
              <strong>0 briefs</strong>
            </div>
            <p>Choose a plan when you are ready to use Savvy.</p>
          </div>
          {showPlans ? (
            <>
              <h3 ref={plansHeading} tabIndex={-1}>
                Plans and pricing
              </h3>
              {pricing}
              <button
                className="button secondary"
                onClick={() => {
                  setShowPlans(false);
                  requestAnimationFrame(() => plansTrigger.current?.focus());
                }}
              >
                Back to account
              </button>
            </>
          ) : (
            <button
              ref={plansTrigger}
              className="button primary"
              onClick={() => setShowPlans(true)}
            >
              View plans and pricing
            </button>
          )}
          <p>
            You can browse local history and prepare your context without a
            purchase.
          </p>
        </>
      )}
      {failedProduct && recoveryVisible && (
        <section
          aria-label="Payment not completed"
          className="managed-empty-card managed-payment-recovery"
        >
          <h3>Payment not completed</h3>
          <p role="status">
            This checkout attempt is closed. No time or briefs were added.
          </p>
          <p>
            Your existing allowance is unchanged. You can try again when you are
            ready.
          </p>
          <button
            className="button primary"
            disabled={
              busy || account?.purchaseAvailability?.[failedProduct] === false
            }
            onClick={() => void run(() => managedBilling(failedProduct))}
          >
            Try checkout again
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setDismissedPurchase(purchaseKey);
              accountHeading.current?.focus();
            }}
          >
            Back to account
          </button>
        </section>
      )}
      {confirmSignOut && (
        <ConfirmDialog
          title="Sign out of Savvy?"
          confirm="Sign out"
          busy={busy}
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() =>
            void run(async () => {
              await managedSignOut();
              setShowUsage(false);
              setConfirmSignOut(false);
            })
          }
        >
          <p>
            End your meeting first. Local history stays on this Mac. Signing out
            does not cancel your subscription.
          </p>
          {!unbilled && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void run(() => managedBilling("portal"))}
            >
              Manage billing
            </button>
          )}
          {error && <p role="alert">{error}</p>}
        </ConfirmDialog>
      )}
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => setConfirmSignOut(true)}
      >
        Sign out
      </button>
      <p>Signing out or choosing your own providers does not cancel billing.</p>
      {!paymentPending && (
        <button className="button secondary" onClick={() => void refresh()}>
          Refresh account
        </button>
      )}
      {!noPlan && !recoveryVisible && !paymentPending && (
        <details className="managed-processing">
          <summary>Pricing and data processing</summary>
          <p>
            Audio passes through Savvy to Deepgram Nova-3 with training opt-out.
            Selected brief evidence and meeting context pass through Savvy to
            Fireworks GLM-5.3. Documents and history stay on this Mac.
          </p>
          <p>
            {`$${offers.monthly.amountCents / 100} monthly includes ${offers.monthly.hours} meeting hours and ${offers.monthly.briefs} briefs. `}
            {`$${offers.pack.amountCents / 100} once includes ${offers.pack.hours} hours and ${offers.pack.briefs} briefs with no scheduled expiry. `}
            Included usage expires at the paid period end. Two audio sources
            count as one meeting clock. Pause stops usage. No automatic
            overages.
          </p>
        </details>
      )}
      {error && !confirmSignOut && <p role="alert">{error}</p>}
    </section>
  );
}
