#!/usr/bin/env python3
"""Launch the backend with real Better Auth and Stripe TEST webhooks.

Load private backend configuration first. Authentication uses the normal browser
PKCE flow and configured SMTP/Google. No synthetic issuer, supplier responses,
allowance grants, Checkout submission or payment is created by this launcher.
"""

import json
import os
import re
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    os.umask(0o077)
    output = Path(os.environ.get("SAVVY_E2E_DIR", ROOT / "target/unified-stripe-e2e")).resolve()
    secret_file = Path(os.environ.get("SAVVY_STRIPE_TEST_ENV", Path.home() / ".config/savvy/stripe-test.env"))
    selectors = {}
    for line in secret_file.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            if key.startswith("SAVVY_STRIPE_"):
                selectors[key] = value
    if not selectors.get("SAVVY_STRIPE_SECRET_KEY", "").startswith("sk_test_"):
        raise ValueError("Stripe sandbox requires a test secret")
    for name in ["BETTER_AUTH_SECRET", "SMTP_HOST", "SMTP_FROM", "SAVVY_ANTHROPIC_API_KEY", "SAVVY_DEEPGRAM_API_KEY"]:
        if not os.environ.get(name):
            raise ValueError(f"Load private backend configuration: missing {name}")
    if len(os.environ["BETTER_AUTH_SECRET"]) < 32:
        raise ValueError("BETTER_AUTH_SECRET must have at least 32 characters; retain it across restarts")
    origin = os.environ.get("BETTER_AUTH_URL", "http://127.0.0.1:18788")
    url = urllib.parse.urlsplit(origin)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.path or url.query or url.fragment or url.username or url.password:
        raise ValueError("Sandbox BETTER_AUTH_URL must be http://127.0.0.1:PORT with no path")
    if os.environ.get("SAVVY_OIDC_ISSUER", origin) != origin:
        raise ValueError("Sandbox issuer must equal the configured Better Auth origin")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", url.port))
    backend = ROOT / "backend"
    if not (backend / "build/server.js").is_file():
        raise ValueError("Build the backend first: pnpm --dir backend build")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.chmod(0o700)
    state_path = output / "state.json"
    cli_env = os.environ | {"STRIPE_API_KEY": selectors["SAVVY_STRIPE_SECRET_KEY"]}
    webhook_secret = subprocess.check_output(
        ["stripe", "listen", "--print-secret", "--skip-update"], env=cli_env,
        stderr=subprocess.DEVNULL, text=True, timeout=40,
    ).strip()
    if not re.fullmatch("whsec_[A-Za-z0-9]+", webhook_secret):
        raise ValueError("Unexpected Stripe listener response")
    env = os.environ | selectors | {
        "BETTER_AUTH_URL": origin,
        "SAVVY_OIDC_ISSUER": origin,
        "SAVVY_OIDC_CLIENT_ID": os.environ.get("SAVVY_OIDC_CLIENT_ID", "savvy-desktop"),
        "SAVVY_OIDC_AUDIENCE": os.environ.get("SAVVY_OIDC_AUDIENCE", "https://api.savvycopilot.com"),
        "SAVVY_AUTH_DATABASE": str(output / "auth.sqlite"),
        "SAVVY_DB_PATH": str(output / "service.sqlite"),
        "SAVVY_HOST": "127.0.0.1", "PORT": str(url.port),
        "SAVVY_STRIPE_WEBHOOK_SECRET": webhook_secret,
        "SAVVY_CHECKOUT_RETURN_URL": os.environ.get("SAVVY_CHECKOUT_RETURN_URL", "http://127.0.0.1:18789/checkout-complete/"),
    }
    env.pop("SAVVY_DEV_FIXTURES", None)
    env.pop("SAVVY_OIDC_JWKS_URL", None)
    processes = []
    try:
        with (output / "backend.log").open("a") as log, (output / "stripe-listener.log").open("a") as stripe_log:
            subprocess.run(["node", "build/migrate.js"], cwd=backend, env=env, stdout=log, stderr=log, check=True, timeout=30)
            service = subprocess.Popen(["node", "build/server.js"], cwd=backend, env=env, stdout=log, stderr=log)
            processes.append(service)
            for _ in range(100):
                if service.poll() is not None:
                    raise RuntimeError("Backend exited; inspect the private backend log")
                try:
                    with urllib.request.urlopen(origin + "/readyz", timeout=1) as response:
                        if response.status == 204:
                            break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.1)
            else:
                raise RuntimeError("Backend did not become ready")
            listener = subprocess.Popen([
                "stripe", "listen", "--skip-update", "--forward-to", origin + "/v1/billing/webhook",
                "--events", "checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,invoice.paid,invoice.payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,charge.dispute.closed",
            ], env=cli_env, stdout=stripe_log, stderr=stripe_log)
            processes.append(listener)
            state_path.write_text(json.dumps({
                "service": origin, "issuer": origin, "clientId": env["SAVVY_OIDC_CLIENT_ID"],
                "audience": env["SAVVY_OIDC_AUDIENCE"], "authentication": "better-auth-pkce",
                "mode": "stripe-test", "pids": {"backend": service.pid, "stripeListener": listener.pid},
            }, indent=2) + "\n")
            print("Backend ready. Sign in through Savvy using the configured SMTP/Google. Stripe TEST webhooks are forwarded; no payment has been made.", flush=True)
            while service.poll() is None and listener.poll() is None:
                time.sleep(1)
    finally:
        # Stop webhook intake, then drain the sole application backend.
        for process in reversed(processes):
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=150)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise RuntimeError("Sandbox process exceeded its shutdown deadline")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
