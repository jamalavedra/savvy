"use client";

import { useEffect, useState } from "react";

import { CONSENT_KEY as KEY, readConsent, CONSENT_YEAR as YEAR } from "@/lib/consent";

export function Analytics() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let allowed = false;
    let expires = 0;
    try {
      const saved = readConsent(localStorage.getItem(KEY));
      allowed = saved?.allowed ?? false;
      expires = saved?.expires ?? 0;
    } catch {
      // Unavailable storage or an invalid record leaves analytics off.
    }
    setOpen(!expires);
    const reload = () => location.reload();
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) reload();
    };
    window.addEventListener("storage", onStorage);
    const timer = expires
      ? window.setTimeout(reload, Math.min(expires - Date.now(), 2147483647))
      : undefined;
    let script: HTMLScriptElement | undefined;
    if (allowed) {
      script = document.createElement("script");
      script.src = "https://analytics.jamalavedra.com/script.js";
      script.dataset.websiteId = "8a7ddcdb-2cee-4719-a8f2-9c18aa8239e7";
      script.dataset.domains = "savvycopilot.com";
      script.defer = true;
      document.head.append(script);
    }
    return () => {
      script?.remove();
      window.clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  function choose(allowed: boolean) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ allowed, expires: Date.now() + YEAR }));
      // Reload also removes the tracker's listeners when consent is withdrawn.
      location.reload();
    } catch {
      setError(
        "Your browser could not save this choice. You can clear this site's storage in your browser settings.",
      );
    }
  }

  return (
    <aside
      aria-label="Privacy preferences"
      className="fixed bottom-4 left-4 right-4 z-50 sm:left-auto sm:max-w-md"
    >
      {open ? (
        <div className="rounded-xl border border-border bg-surface p-5 shadow-lg">
          <h2 className="font-medium">Optional website analytics</h2>
          <p className="mt-2 text-sm text-muted">
            Allow Umami to count visits and show us how this website is used? Analytics stays off
            until you allow it. You can change your choice here at any time.
          </p>
          <a href="/privacy/" className="focus-ring mt-2 inline-block text-sm underline">
            Privacy policy
          </a>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => choose(false)}
              className="focus-ring rounded-full border border-border px-4 py-2 text-sm"
            >
              Reject analytics
            </button>
            <button
              type="button"
              onClick={() => choose(true)}
              className="focus-ring rounded-full border border-border px-4 py-2 text-sm"
            >
              Allow analytics
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="focus-ring px-2 text-sm underline"
            >
              Close
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm">
              {error}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="focus-ring ml-auto block rounded-full border border-border bg-surface px-4 py-2 text-xs shadow-sm"
        >
          Privacy preferences
        </button>
      )}
    </aside>
  );
}
