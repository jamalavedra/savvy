#!/usr/bin/env python3
"""Offline checks: invalid sandbox configuration cannot reach the Stripe CLI."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class SandboxPreflight(unittest.TestCase):
    def test_live_keys_missing_auth_and_remote_origins_stop_before_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selectors = root / "stripe.env"
            env = {
                "PATH": "",
                "SAVVY_E2E_DIR": str(root / "state"),
                "SAVVY_STRIPE_TEST_ENV": str(selectors),
            }
            script = Path(__file__).with_name("stripe-sandbox.py")
            def run(message):
                result = subprocess.run([sys.executable, str(script)], env=env, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((root / "state").exists())
                self.assertNotIn("sk_live_do_not_send", result.stderr)
            selectors.write_text("SAVVY_STRIPE_SECRET_KEY=sk_live_do_not_send\n")
            run("requires a test secret")
            selectors.write_text("SAVVY_STRIPE_SECRET_KEY=sk_test_offline_fixture\n")
            run("missing BETTER_AUTH_SECRET")
            env.update({name: "synthetic" for name in ["SMTP_HOST", "SMTP_FROM", "SAVVY_ANTHROPIC_API_KEY", "SAVVY_DEEPGRAM_API_KEY"]})
            env.update(BETTER_AUTH_SECRET="private-test-secret-" * 3, BETTER_AUTH_URL="https://production.example.test")
            run("must be http://127.0.0.1:PORT")
            env.update(BETTER_AUTH_URL="http://127.0.0.1:18788", SAVVY_OIDC_ISSUER="http://127.0.0.1:18787")
            run("issuer must equal")


if __name__ == "__main__":
    unittest.main()
