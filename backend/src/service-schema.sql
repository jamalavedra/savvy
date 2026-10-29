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
        CREATE TABLE IF NOT EXISTS composio_sessions (
            account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
            session_id TEXT NOT NULL UNIQUE,
            user_id TEXT NOT NULL DEFAULT ''
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

CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, stripe_customer_id TEXT UNIQUE,
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_members (
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id),
    role TEXT NOT NULL CHECK(role IN ('owner','member')), display_email TEXT,
    created_at_ms INTEGER NOT NULL, PRIMARY KEY(organization_id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_single_owner
    ON organization_members(organization_id) WHERE role='owner';
CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id),
    seat_number INTEGER NOT NULL CHECK(seat_number>0),
    status TEXT NOT NULL CHECK(status IN ('active','retiring','retired')),
    created_at_ms INTEGER NOT NULL, UNIQUE(organization_id,seat_number)
);
CREATE TABLE IF NOT EXISTS seat_assignments (
    id INTEGER PRIMARY KEY, seat_id INTEGER NOT NULL REFERENCES seats(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id), assigned_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER, end_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS seat_one_open_assignment
    ON seat_assignments(seat_id) WHERE ended_at_ms IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS account_one_open_assignment
    ON seat_assignments(account_id) WHERE ended_at_ms IS NULL;
CREATE TABLE IF NOT EXISTS seat_periods (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id),
    seat_id INTEGER NOT NULL REFERENCES seats(id), invoice_id TEXT NOT NULL,
    starts_ms INTEGER NOT NULL, ends_ms INTEGER NOT NULL CHECK(ends_ms>starts_ms),
    price_id TEXT NOT NULL, budget_ms INTEGER NOT NULL CHECK(budget_ms>=0),
    budget_briefs INTEGER NOT NULL CHECK(budget_briefs>=0),
    financial_status TEXT NOT NULL CHECK(financial_status IN ('paid','reversed')),
    UNIQUE(seat_id,invoice_id)
);
CREATE TABLE IF NOT EXISTS organization_invitations (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id),
    email_normalized TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    assign_seat INTEGER NOT NULL DEFAULT 0 CHECK(assign_seat IN (0,1)),
    expires_ms INTEGER NOT NULL,
    delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','sent','failed')),
    accepted_account_id INTEGER REFERENCES accounts(id), accepted_at_ms INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_subscriptions (
    organization_id INTEGER PRIMARY KEY REFERENCES organizations(id),
    stripe_subscription_id TEXT NOT NULL UNIQUE, stripe_item_id TEXT,
    price_id TEXT NOT NULL, status TEXT NOT NULL,
    quantity_next INTEGER NOT NULL DEFAULT 0 CHECK(quantity_next BETWEEN 0 AND 50),
    external_change INTEGER NOT NULL DEFAULT 0, paid_through_ms INTEGER,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL, checked_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS organization_checkouts (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id),
    request_key TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50),
    price_id TEXT NOT NULL, return_url TEXT NOT NULL,
    stripe_idempotency_key TEXT NOT NULL UNIQUE, stripe_session_id TEXT UNIQUE,
    stripe_subscription_id TEXT, stripe_item_id TEXT, state TEXT NOT NULL, search_cursor TEXT,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    UNIQUE(organization_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_one_pending_checkout
    ON organization_checkouts(organization_id) WHERE state IN ('pending','payment_pending','unknown');
CREATE TABLE IF NOT EXISTS organization_quantity_changes (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id),
    request_key TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50),
    stripe_subscription_id TEXT NOT NULL, stripe_item_id TEXT NOT NULL, price_id TEXT NOT NULL,
    retire_seat_ids TEXT NOT NULL, previous_retire_seat_ids TEXT NOT NULL DEFAULT '[]', stripe_idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
    UNIQUE(organization_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_one_pending_quantity_change
    ON organization_quantity_changes(organization_id) WHERE state IN ('pending','unknown');
CREATE TABLE IF NOT EXISTS organization_payments (
    stripe_object_id TEXT PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id),
    invoice_id TEXT, amount_cents INTEGER NOT NULL CHECK(amount_cents>=0), created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_reversals (
    stripe_object_id TEXT PRIMARY KEY, organization_id INTEGER REFERENCES organizations(id),
    invoice_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_customers (
    stripe_customer_id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL CHECK(owner_kind IN ('account','organization')),
    owner_id INTEGER NOT NULL, UNIQUE(owner_kind,owner_id)
);
CREATE TABLE IF NOT EXISTS service_capabilities (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, set_at_ms INTEGER NOT NULL
);
