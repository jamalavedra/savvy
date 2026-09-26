CREATE TABLE IF NOT EXISTS audio_pacing (
            account_id INTEGER NOT NULL REFERENCES accounts(id), source TEXT NOT NULL,
            debt INTEGER NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY(account_id,source)
        );
        CREATE TABLE IF NOT EXISTS attempt_counters (
            scope INTEGER NOT NULL, operation TEXT NOT NULL, window_ms INTEGER NOT NULL,
            started_ms INTEGER NOT NULL, count INTEGER NOT NULL,
            PRIMARY KEY(scope,operation,window_ms)
        );
        CREATE TABLE IF NOT EXISTS cancellation_tombstones (
            account_id INTEGER NOT NULL REFERENCES accounts(id), request_key TEXT NOT NULL,
            expires_ms INTEGER NOT NULL, PRIMARY KEY(account_id,request_key)
        );
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY,
            issuer TEXT NOT NULL,
            subject TEXT NOT NULL,
            stripe_customer_id TEXT UNIQUE,
            disabled INTEGER NOT NULL DEFAULT 0,
            terms_version TEXT,
            created_at_ms INTEGER NOT NULL,
            UNIQUE (issuer, subject)
        );
        CREATE TABLE IF NOT EXISTS subscriptions (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts (id),
            stripe_subscription_id TEXT NOT NULL UNIQUE,
            price_id TEXT NOT NULL,
            status TEXT NOT NULL,
            paid_through_ms INTEGER,
            cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS allowance_grants (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts (id),
            origin TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            meeting_ms_total INTEGER NOT NULL,
            meeting_ms_used INTEGER NOT NULL DEFAULT 0,
            meeting_ms_reserved INTEGER NOT NULL DEFAULT 0,
            briefs_total INTEGER NOT NULL,
            briefs_used INTEGER NOT NULL DEFAULT 0,
            briefs_reserved INTEGER NOT NULL DEFAULT 0,
            valid_from_ms INTEGER NOT NULL,
            valid_until_ms INTEGER,
            revoked INTEGER NOT NULL DEFAULT 0,
            policy_version TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage_events (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts (id),
            grant_id INTEGER,
            session_id TEXT,
            request_id TEXT,
            kind TEXT NOT NULL,
            amount_ms INTEGER NOT NULL DEFAULT 0,
            amount_briefs INTEGER NOT NULL DEFAULT 0,
            operation_key TEXT NOT NULL UNIQUE,
            created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS managed_sessions (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts (id),
            local_session_id TEXT NOT NULL,
            state TEXT NOT NULL,
            lease_version INTEGER NOT NULL DEFAULT 0,
            lease_expires_ms INTEGER,
            reserved_ms INTEGER NOT NULL DEFAULT 0,
            settled_ms INTEGER NOT NULL DEFAULT 0,
            billable_since_ms INTEGER,
            interruption TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            UNIQUE (account_id, local_session_id)
        );
        CREATE TABLE IF NOT EXISTS session_reservations (
            session_id INTEGER NOT NULL REFERENCES managed_sessions(id),
            grant_id INTEGER NOT NULL REFERENCES allowance_grants(id),
            amount_ms INTEGER NOT NULL CHECK(amount_ms >= 0),
            PRIMARY KEY(session_id, grant_id)
        );
        CREATE TABLE IF NOT EXISTS provider_requests (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts (id),
            request_key TEXT NOT NULL,
            operation TEXT NOT NULL,
            state TEXT NOT NULL,
            grant_id INTEGER,
            vendor_request_id TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cost_microdollars INTEGER,
            deadline_ms INTEGER,
            created_at_ms INTEGER NOT NULL,
            UNIQUE (account_id, request_key)
        );
        CREATE TABLE IF NOT EXISTS catalog_prices (price_id TEXT PRIMARY KEY, product TEXT NOT NULL, offer_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkouts (
            account_id INTEGER NOT NULL REFERENCES accounts(id),
            request_key TEXT NOT NULL, product TEXT NOT NULL, state TEXT NOT NULL, stripe_id TEXT UNIQUE,
            PRIMARY KEY(account_id,request_key)
        );
        CREATE TABLE IF NOT EXISTS subscription_periods (
            subscription_id TEXT NOT NULL, starts_ms INTEGER NOT NULL, ends_ms INTEGER NOT NULL, invoice_id TEXT NOT NULL UNIQUE,
            PRIMARY KEY(subscription_id,starts_ms,ends_ms)
        );
        CREATE TABLE IF NOT EXISTS stripe_payments (payment_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id));
        CREATE TABLE IF NOT EXISTS reversals (origin TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), refunded INTEGER NOT NULL DEFAULT 0, disputed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS billing_sync (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT);
        INSERT OR IGNORE INTO billing_sync(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS billing_events (
            id INTEGER PRIMARY KEY,
            stripe_event_id TEXT NOT NULL UNIQUE,
            event_type TEXT NOT NULL,
            status TEXT NOT NULL,
            related_ids TEXT,
            created_at_ms INTEGER NOT NULL
        );
