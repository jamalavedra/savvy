import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import "./style.css";
import googleSignIn from "./google-signin.png?url&inline";
const client = createAuthClient({
  disableDefaultFetchPlugins: true,
  plugins: [emailOTPClient(), oauthProviderClient()],
});
function callbackURL(raw: string) {
  const url = new URL(raw);
  if (url.searchParams.has("error") || !url.searchParams.get("code"))
    throw new Error("Sign-in was not completed. Try again in Savvy.");
  if (
    url.protocol !== "com.alamaslabs.savvy:" ||
    url.pathname !== "/oauth/callback" ||
    url.host
  )
    throw new Error("Invalid app callback. Start sign-in again in Savvy.");
  return url.href;
}
function initialCompletion() {
  if (location.pathname !== "/complete" || !location.hash)
    return { callback: "", error: "" };
  try {
    return {
      callback: callbackURL(decodeURIComponent(location.hash.slice(1))),
      error: "",
    };
  } catch {
    return {
      callback: "",
      error: "Could not complete sign-in. Start again in Savvy.",
    };
  }
}
export function App() {
  const [initial] = useState(initialCompletion);
  const [creating, setCreating] = useState(location.pathname === "/sign-up");
  const registrationFlow =
    new URLSearchParams(location.search)
      .get("prompt")
      ?.split(" ")
      .includes("create") ?? false;
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [activity, setActivity] = useState<
    "sending" | "verifying" | "google" | null
  >(null);
  const busy = activity !== null;
  const [resent, setResent] = useState(false);
  const [error, setError] = useState(initial.error);
  const [until, setUntil] = useState(0);
  const [expires, setExpires] = useState(0);
  const pending = useRef(false);
  const [now, setNow] = useState(Date.now);
  const [callback, setCallback] = useState("");
  const [checkingReturn, setCheckingReturn] = useState(
    Boolean(initial.callback),
  );
  const complete = useCallback(
    (raw: string) => setCallback(callbackURL(raw)),
    [],
  );
  useEffect(() => {
    if (!initial.callback) return;
    let cancelled = false;
    void client
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        if (data?.session) complete(initial.callback);
        else
          setError(
            "Sign-in could not be verified. Return to Savvy and start again.",
          );
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "Sign-in could not be verified. Return to Savvy and start again.",
          );
      })
      .finally(() => {
        if (!cancelled) setCheckingReturn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initial.callback, complete]);
  const [google, setGoogle] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    void fetch("/configuration")
      .then((r) => r.json())
      .then((c) => setGoogle(c.google))
      .catch(() => {});
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    input.current?.focus();
  }, [sent, error]);
  useEffect(() => {
    if (location.pathname === "/complete" && location.hash) {
      history.replaceState(null, "", "/complete");
    }
  }, []);
  useEffect(() => {
    if (!registrationFlow) return;
    void client
      .getSession()
      .then(async ({ data }) => {
        if (!data?.session) return;
        const next = await client.oauth2.continue({ created: true });
        if (next.data?.url) complete(next.data.url);
        else if (next.error)
          setError(next.error.message ?? "Could not finish account creation.");
      })
      .catch(() =>
        setError("Could not finish account creation. Try again in Savvy."),
      );
  }, [registrationFlow, complete]);
  async function run(
    action: () => Promise<void>,
    kind: "sending" | "verifying" | "google",
  ) {
    if (pending.current) return;
    pending.current = true;
    setActivity(kind);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed. Try again.");
    } finally {
      pending.current = false;
      setActivity(null);
    }
  }
  async function send() {
    const result = await client.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    if (result.error)
      throw new Error(result.error.message ?? "Email delivery failed.");
    setResent(sent);
    setSent(true);
    setOtp("");
    setUntil(Date.now() + 30_000);
    setExpires(Date.now() + 600_000);
  }
  async function verify() {
    const result = await client.signIn.emailOtp({ email, otp });
    if (result.error)
      throw new Error(
        result.error.code === "INVALID_OTP"
          ? "That code is incorrect. Try again."
          : (result.error.message ?? "This code is incorrect or expired."),
      );
    const data = result.data as { url?: string };
    if (data.url && !registrationFlow) complete(data.url);
    else {
      const next = await client.oauth2.continue({ created: registrationFlow });
      if (next.error)
        throw new Error(next.error.message ?? "Could not continue sign-in.");
      if (next.data?.url) complete(next.data.url);
      else throw new Error("Start sign-in from the Savvy app to continue.");
    }
  }
  const expired = sent && expires > 0 && now >= expires;
  const remaining = Math.min(30, Math.max(0, Math.ceil((until - now) / 1000)));
  function changeEmail() {
    setSent(false);
    setOtp("");
    setError("");
    setResent(false);
  }
  return (
    <main className={callback ? "handoff" : undefined}>
      <strong className="wordmark">savvy</strong>
      {!callback && (
        <h1 id="page-title">
          {checkingReturn
            ? "Checking sign-in"
            : sent
              ? "Check your email"
              : creating
                ? "Create account"
                : "Sign in"}
        </h1>
      )}
      <section className="account-card" aria-labelledby="page-title">
        {checkingReturn ? (
          <p role="status">Confirming your browser session…</p>
        ) : callback ? (
          <>
            <h1 id="page-title">You are signed in</h1>
            <p>
              Open Savvy to continue where you left off. Savvy will confirm your
              account before continuing.
            </p>
            <a className="button" href={callback}>
              Open Savvy
            </a>
            <p>
              If nothing opens, select Savvy in your Dock or Applications
              folder. Your meeting stays paused.
            </p>
          </>
        ) : (
          <>
            {sent ? (
              <>
                <p>Enter the 6-digit code sent to:</p>
                <div className="recipient">
                  <strong>{email}</strong>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={changeEmail}
                  >
                    Change email
                  </button>
                </div>
              </>
            ) : (
              google && (
                <>
                  <button
                    className="google-button"
                    aria-label={
                      activity === "google"
                        ? "Opening Google…"
                        : "Sign in with Google"
                    }
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await client.signIn.social({
                          provider: "google",
                          callbackURL: registrationFlow
                            ? location.pathname + location.search
                            : "/complete",
                        });
                        if (result.error) throw new Error(result.error.message);
                        if (result.data?.url) location.assign(result.data.url);
                      }, "google")
                    }
                  >
                    {activity === "google" ? (
                      "Opening Google…"
                    ) : (
                      <img src={googleSignIn} alt="" width="180" height="40" />
                    )}
                  </button>
                  <p className="divider">or use email</p>
                </>
              )
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const verifying = sent && !expired;
                void run(
                  verifying ? verify : send,
                  verifying ? "verifying" : "sending",
                );
              }}
            >
              <label htmlFor="credential">
                {sent ? "Email code" : "Email"}
              </label>
              <input
                ref={input}
                id="credential"
                type={sent ? "text" : "email"}
                inputMode={sent ? "numeric" : "email"}
                autoComplete={sent ? "one-time-code" : "email"}
                placeholder={sent ? "6-digit code" : "you@example.com"}
                pattern={sent ? "[0-9]{6}" : undefined}
                maxLength={sent ? 6 : 254}
                value={sent ? otp : email}
                onChange={(event) =>
                  sent
                    ? setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))
                    : setEmail(event.target.value)
                }
                required
                disabled={busy || expired}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "error" : "credential-help"}
              />
              {error && (
                <p id="error" role="alert">
                  {error}
                </p>
              )}
              {!error && (
                <p id="credential-help" role={sent ? "status" : undefined}>
                  {sent
                    ? expired
                      ? "This code has expired. Send a new one."
                      : activity === "verifying"
                        ? "Checking your code. Keep this page open."
                        : activity === "sending"
                          ? "Sending a new code…"
                          : resent
                            ? "New code sent. Use the latest email. Expires in 10 minutes."
                            : "Expires in 10 minutes. Use the latest code."
                    : "We will email you a 6-digit sign-in code. No password to remember."}
                </p>
              )}
              <button disabled={busy}>
                {activity === "sending"
                  ? "Sending code…"
                  : activity === "verifying"
                    ? "Checking code…"
                    : expired
                      ? "Send a new code"
                      : sent
                        ? "Continue"
                        : "Email me a code"}
              </button>
            </form>
            {sent ? (
              expired ? (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    changeEmail();
                    setCreating(false);
                  }}
                >
                  Back to sign in
                </button>
              ) : (
                <button
                  className="secondary"
                  disabled={busy || remaining > 0}
                  onClick={() => void run(send, "sending")}
                >
                  {remaining ? `Resend in ${remaining} seconds` : "Resend code"}
                </button>
              )
            ) : (
              <button
                className="text-button account-switch"
                disabled={busy}
                onClick={() => setCreating(!creating)}
              >
                {creating
                  ? "Already have an account? Sign in"
                  : "New to Savvy? Create account"}
              </button>
            )}
          </>
        )}
      </section>
      {!callback && (
        <p className="pricing">
          <a href="https://savvycopilot.com/pricing/">View plans</a> · No
          purchase required.
        </p>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
