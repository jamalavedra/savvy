import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "monitor", ROOT / "deploy/savvy-monitor.py"
)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)
REAL_READY = monitor.ready
NOW = 1700000000000


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = pathlib.Path(self.directory.name) / "service.sqlite"
        self.db = sqlite3.connect(self.database)
        self.addCleanup(self.db.close)
        self.db.executescript((ROOT / "backend/src/service-schema.sql").read_text())
        self.db.commit()
        for context in [
            patch.object(monitor, "DATABASE", self.database),
            patch.object(monitor.time, "time", return_value=NOW / 1000),
            patch.object(
                monitor,
                "unit",
                side_effect=lambda name: {
                    "ActiveState": "active" if name == monitor.BACKEND else "inactive",
                    "Result": "success",
                    "LoadState": "loaded",
                },
            ),
            patch.object(monitor, "ready", return_value=True),
            patch.object(
                monitor.shutil,
                "disk_usage",
                return_value=SimpleNamespace(total=20 * 1024**3, free=10 * 1024**3),
            ),
            patch.object(monitor, "command", return_value=""),
        ]:
            context.start()
            self.addCleanup(context.stop)

    def test_healthy_and_read_only(self):
        before = self.database.read_bytes()
        result = monitor.check()
        self.assertTrue(result["healthy"])
        self.assertEqual(self.database.read_bytes(), before)
        self.assertEqual(result["failures"], [])
        missing = self.database.parent / "missing.sqlite"
        with self.assertRaises(sqlite3.OperationalError):
            monitor.database_counts(missing, NOW)
        self.assertFalse(missing.exists())

    def test_database_ages_and_balances_including_live_wal(self):
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "INSERT INTO managed_sessions(account_id,local_session_id,state,reserved_ms,lease_expires_ms,created_at_ms,updated_at_ms) VALUES(1,'private-session','active',30000,?,0,0)",
            (NOW - 60001,),
        )
        self.db.execute(
            "INSERT INTO provider_requests(account_id,request_key,operation,state,deadline_ms,created_at_ms) VALUES(1,'private-request','brief','pending',?,0)",
            (NOW - 60001,),
        )
        self.db.execute(
            "INSERT INTO billing_events(stripe_event_id,event_type,status,created_at_ms) VALUES('private-event','private-type','pending',?)",
            (NOW - 300001,),
        )
        self.db.execute(
            "INSERT INTO allowance_grants(account_id,origin,kind,meeting_ms_total,meeting_ms_used,briefs_total,valid_from_ms,policy_version,created_at_ms) VALUES(1,'private-grant','pack',1,2,1,0,'v1',0)"
        )
        self.db.commit()
        result = monitor.check()
        self.assertFalse(result["healthy"])
        self.assertEqual(
            set(result["failures"]),
            {
                "stale_session_reservations",
                "stale_provider_requests",
                "billing_events_pending_5m",
                "negative_allowances",
            },
        )
        self.assertNotIn("private", json.dumps(result))
        self.db.execute(
            "UPDATE managed_sessions SET lease_expires_ms=?", (NOW + 30000,)
        )
        self.db.execute("UPDATE provider_requests SET deadline_ms=?", (NOW + 120000,))
        self.db.execute("UPDATE billing_events SET created_at_ms=?", (NOW,))
        self.db.execute("UPDATE allowance_grants SET meeting_ms_used=0")
        self.db.commit()
        self.assertTrue(monitor.check()["healthy"])

    def test_failures_are_metadata_only(self):
        monitor.command.return_value = "reasoning provider returned 503\ntranscription provider unavailable\nbilling reconciliation requires retry code=provider_unavailable\nprivate-context synthetic-key\n"
        result = monitor.check()
        self.assertEqual(
            set(result["failures"]),
            {
                "reasoning_http_errors_5m",
                "transcription_provider_failures_5m",
                "billing_retries_5m",
            },
        )
        self.assertNotIn("private-context", json.dumps(result))
        self.assertNotIn("synthetic-key", json.dumps(result))
        monitor.command.side_effect = RuntimeError("private-context synthetic-key")
        self.assertIn("journal_unreadable", monitor.check()["failures"])
        self.assertNotIn("synthetic-key", json.dumps(monitor.check()))

    def test_failed_operations_include_cancellation_without_alert(self):
        self.db.execute(
            "INSERT INTO provider_requests(account_id,request_key,operation,state,created_at_ms) VALUES(1,'canceled','brief','failed',?)",
            (NOW,),
        )
        self.db.commit()
        result = monitor.check()
        self.assertTrue(result["healthy"])
        self.assertEqual(result["provider_operations_failed_5m"], 1)

    def test_outage_disk_and_restart_failure(self):
        monitor.ready.return_value = False
        monitor.unit.side_effect = lambda name: {
            "ActiveState": "failed",
            "Result": "exit-code",
            "LoadState": "loaded",
        }
        monitor.shutil.disk_usage.return_value = SimpleNamespace(
            total=20 * 1024**3, free=1024
        )
        failures = monitor.check()["failures"]
        for key in [
            "backend_unit_failed",
            "backend_inactive",
            "origin_ready",
            "origin_readyz",
            "public_ready",
            "public_readyz",
            "disk_low",
        ]:
            self.assertIn(key, failures)

    def test_readiness_rejects_redirect(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = SimpleNamespace(
            status=200, url="https://login.invalid"
        )
        with patch.object(
            monitor.urllib.request, "urlopen", return_value=response
        ) as opened:
            self.assertFalse(REAL_READY(monitor.PUBLIC_ORIGIN, "/ready", 200))
            self.assertEqual(
                opened.call_args.args[0].get_header("User-agent"), "SavvyMonitor/0.1"
            )
            self.assertIsNone(opened.call_args.args[0].get_header("Cf-connecting-ip"))
            response.__enter__.return_value.url = monitor.PUBLIC_ORIGIN + "/ready"
            self.assertTrue(REAL_READY(monitor.PUBLIC_ORIGIN, "/ready", 200))
            response.__enter__.return_value.url = monitor.LOCAL_ORIGIN + "/ready"
            self.assertTrue(REAL_READY(monitor.LOCAL_ORIGIN, "/ready", 200))
            self.assertEqual(
                opened.call_args.args[0].get_header("Cf-connecting-ip"), "127.0.0.1"
            )


if __name__ == "__main__":
    unittest.main()
