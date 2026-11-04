#!/usr/bin/env python3
"""Read-only production checks. Emit only aggregate metadata to journald."""

import json
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request

DATABASE = pathlib.Path("/var/lib/savvy/service.sqlite")
LOCAL_ORIGIN = "http://127.0.0.1:8788"
PUBLIC_ORIGIN = "https://api.savvycopilot.com"
BACKEND = "savvy-backend.service"


def command(*args):
    return subprocess.run(
        args, capture_output=True, text=True, timeout=10, check=True
    ).stdout


def unit(name):
    return dict(
        line.split("=", 1)
        for line in command(
            "systemctl", "show", name, "--property=ActiveState,Result,LoadState"
        ).splitlines()
        if "=" in line
    )


def ready(origin, path, expected):
    headers = {"User-Agent": "SavvyMonitor/0.1"}
    if origin == LOCAL_ORIGIN:
        headers["CF-Connecting-IP"] = "127.0.0.1"
    request = urllib.request.Request(origin + path, headers=headers)
    with urllib.request.urlopen(request, timeout=5) as response:
        # A login/challenge redirect must never count as readiness.
        return response.status == expected and response.url == origin + path


def database_counts(path, now):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        queries = {
            "stale_session_reservations": (
                "SELECT count(*) FROM managed_sessions WHERE reserved_ms>0 AND (state!='active' OR lease_expires_ms IS NULL OR lease_expires_ms<?)",
                now - 60000,
            ),
            "stale_provider_requests": (
                "SELECT count(*) FROM provider_requests WHERE state='pending' AND (deadline_ms IS NULL OR deadline_ms<?)",
                now - 60000,
            ),
            "billing_events_pending_5m": (
                "SELECT count(*) FROM billing_events WHERE status='pending' AND created_at_ms<?",
                now - 300000,
            ),
            "provider_operations_failed_5m": (
                "SELECT count(*) FROM provider_requests WHERE state='failed' AND created_at_ms>=?",
                now - 300000,
            ),
        }
        result = {
            name: db.execute(sql, (timestamp,)).fetchone()[0]
            for name, (sql, timestamp) in queries.items()
        }
        result["negative_allowances"] = db.execute(
            "SELECT count(*) FROM allowance_grants WHERE meeting_ms_used<0 OR meeting_ms_reserved<0 OR briefs_used<0 OR briefs_reserved<0 OR meeting_ms_used+meeting_ms_reserved>meeting_ms_total OR briefs_used+briefs_reserved>briefs_total"
        ).fetchone()[0]
        return result
    finally:
        db.close()


def check():
    result = {"checked_at_ms": int(time.time() * 1000)}
    failures = []
    try:
        status = unit(BACKEND)
        result["backend_active"] = status.get("ActiveState") == "active"
        if status.get("LoadState") != "loaded" or status.get("Result") != "success":
            failures.append("backend_unit_failed")
    except Exception:
        failures.append("backend_unit_unreadable")
    if not result.get("backend_active"):
        failures.append("backend_inactive")
    for origin, label in [(LOCAL_ORIGIN, "origin"), (PUBLIC_ORIGIN, "public")]:
        for path, expected in [("/ready", 200), ("/readyz", 204)]:
            key = label + path.replace("/", "_")
            try:
                result[key] = ready(origin, path, expected)
            except Exception:
                result[key] = False
            if not result[key]:
                failures.append(key)
    try:
        result.update(database_counts(DATABASE, result["checked_at_ms"]))
        # Failed operations include cancellations, so report that count without paging.
        for key in [
            "stale_session_reservations",
            "stale_provider_requests",
            "billing_events_pending_5m",
            "negative_allowances",
        ]:
            if result[key]:
                failures.append(key)
    except Exception:
        failures.append("database_unreadable")
    try:
        disk = shutil.disk_usage(DATABASE.parent)
        result["disk_free_bytes"] = disk.free
        if disk.free < 1024**3 or disk.free / disk.total < 0.1:
            failures.append("disk_low")
    except Exception:
        failures.append("disk_unreadable")
    try:
        logs = command(
            "journalctl",
            "--unit=" + BACKEND,
            "--since=-5min",
            "--lines=10000",
            "--output=cat",
            "--no-pager",
            "--quiet",
        )
        if len(logs.splitlines()) >= 10000:
            failures.append("journal_sample_truncated")
        result["reasoning_http_errors_5m"] = len(
            re.findall(r"^reasoning provider returned [45][0-9]{2}$", logs, re.M)
        )
        result["transcription_provider_failures_5m"] = len(
            re.findall(r"^transcription provider unavailable$", logs, re.M)
        )
        result["billing_retries_5m"] = len(
            re.findall(r"^billing .+ requires retry code=[a-z_]+$", logs, re.M)
        )
        for key in [
            "reasoning_http_errors_5m",
            "transcription_provider_failures_5m",
            "billing_retries_5m",
        ]:
            if result[key]:
                failures.append(key)
    except Exception:
        failures.append("journal_unreadable")
    result["failures"] = failures
    result["healthy"] = not failures
    return result


if __name__ == "__main__":
    report = check()
    print(json.dumps(report, sort_keys=True))
    sys.exit(0 if report["healthy"] else 1)
