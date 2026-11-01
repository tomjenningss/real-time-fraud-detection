"""Persistent fictional banking data for the Glaramara demo application."""

from alembic import op

revision = "0006_glaramara_banking"
down_revision = "0005_shadow_decision_engine"
branch_labels = None
depends_on = None


SEED_STATEMENTS = (
    """
      INSERT INTO banking_customers
        (customer_id, demo_slug, first_name, last_name, initials, email)
      VALUES
        ('cabcc662-0c08-5a82-b350-847e713ca3b7', 'alex-morgan', 'Alex', 'Morgan', 'AM',
         'alex.morgan@example.test'),
        ('cf874fb6-1429-5a1a-9538-961c82062156', 'priya-shah', 'Priya', 'Shah', 'PS',
         'priya.shah@example.test'),
        ('1a2cbd9a-b406-5b87-9dc0-d1dd9a51ae2c', 'daniel-evans', 'Daniel', 'Evans', 'DE',
         'daniel.evans@example.test')
      ON CONFLICT (customer_id) DO NOTHING
    """,
    """
      INSERT INTO banking_accounts
        (account_id, customer_id, account_name, sort_code, account_number, currency,
         available_balance, card_last_four, balance_as_of)
      VALUES
        ('a4af9cb1-1c67-599b-93b6-a0233710941a', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'Glaramara Current Account', '041120', '00007281', 'GBP', 24862.80, '7281',
         '2026-10-31 13:42:00+00'),
        ('19c30a44-4d8d-532a-b9d1-ae3225c8a1a6', 'cf874fb6-1429-5a1a-9538-961c82062156',
         'Glaramara Current Account', '041120', '00005418', 'GBP', 8421.16, '5418',
         '2026-10-31 13:42:00+00'),
        ('a8aa6e7a-e56e-5499-889a-43dec77a5340', '1a2cbd9a-b406-5b87-9dc0-d1dd9a51ae2c',
         'Glaramara Current Account', '041120', '00003962', 'GBP', 13987.42, '3962',
         '2026-10-31 13:42:00+00')
      ON CONFLICT (account_id) DO NOTHING
    """,
    """
      INSERT INTO banking_beneficiaries
        (beneficiary_id, customer_id, display_name, initials, sort_code, account_number, is_seeded)
      VALUES
        ('1f8a727f-40f8-5b81-b3d7-a52033395fc6', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'Sam Bennett', 'SB', '040941', '82645281', true),
        ('20c56d45-024d-5ce3-a41b-b68174bdc8d3', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'Chloe Williams', 'CW', '201625', '49018272', true),
        ('13062dbd-38da-5e47-b1d6-c118bd3d16c1', 'cf874fb6-1429-5a1a-9538-961c82062156',
         'Maya Shah', 'MS', '110092', '28160413', true),
        ('a38833a4-a3c0-5a69-a8cc-58ad80548827', '1a2cbd9a-b406-5b87-9dc0-d1dd9a51ae2c',
         'Evans Energy Services', 'EE', '309477', '10293847', true)
      ON CONFLICT (beneficiary_id) DO NOTHING
    """,
    """
      INSERT INTO banking_demo_locations
        (location_id, customer_id, location_key, label, latitude, longitude, device_id, is_usual)
      VALUES
        ('45bb3ab3-2b73-5bd7-8c8a-d9b8d2398c74', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'alex-usual-london', 'London · usual location', 51.507400, -0.127800,
         'glaramara-alex-primary', true),
        ('337be7de-621b-5ca0-9602-09fc1539fba4', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'alex-unusual-keswick', 'Keswick · unusual-location demo', 54.601300, -3.134700,
         'glaramara-alex-demo-unusual', false),
        ('5494dfec-6e48-57a1-8ea9-5f064e6ec965', 'cf874fb6-1429-5a1a-9538-961c82062156',
         'priya-usual-manchester', 'Manchester · usual location', 53.480800, -2.242600,
         'glaramara-priya-primary', true),
        ('4c2149a7-27c8-5e15-bde1-404b029086e4', 'cf874fb6-1429-5a1a-9538-961c82062156',
         'priya-unusual-penrith', 'Penrith · unusual-location demo', 54.664100, -2.752700,
         'glaramara-priya-demo-unusual', false),
        ('0c55e00a-97bd-5d3d-9bca-8064bbcc60e4', '1a2cbd9a-b406-5b87-9dc0-d1dd9a51ae2c',
         'daniel-usual-bristol', 'Bristol · usual location', 51.454500, -2.587900,
         'glaramara-daniel-primary', true),
        ('225380c3-a8c7-530e-8f53-418127233830', '1a2cbd9a-b406-5b87-9dc0-d1dd9a51ae2c',
         'daniel-unusual-ambleside', 'Ambleside · unusual-location demo', 54.432600, -2.961300,
         'glaramara-daniel-demo-unusual', false)
      ON CONFLICT (location_id) DO NOTHING
    """,
    """
      INSERT INTO banking_transactions
        (transaction_id, customer_id, account_id, beneficiary_id, direction, amount, currency,
         display_name, category, booked_at, reference, external_reference)
      VALUES
        ('938b6013-7659-5df4-b288-7e458bb97c92', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', NULL, 'DEBIT', 42.85, 'GBP',
         'Whole Foods Market', 'EVERYDAY', '2026-10-31 13:42:00+00', NULL, 'alex-whole-foods-2026-10-31'),
        ('156d6214-5e2e-5576-afda-882a68e011be', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', NULL, 'DEBIT', 6.95, 'GBP',
         'Pret A Manger', 'FOOD_AND_DRINK', '2026-10-30 09:17:00+00', NULL, 'alex-pret-2026-10-30'),
        ('b275ebf7-6862-57f6-b455-24517c78d067', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', NULL, 'CREDIT', 3250.00, 'GBP',
         'Salary · Fable Studio', 'INCOME', '2026-10-28 08:30:00+00', NULL, 'alex-salary-2026-10-28'),
        ('e163cdfd-669b-5689-8811-0d003c4da372', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', NULL, 'DEBIT', 29.10, 'GBP',
         'South Western Railway', 'TRAVEL', '2026-10-27 18:14:00+00', NULL, 'alex-swr-2026-10-27'),
        ('fa1b4677-d9f9-51c1-8c29-c533af990fd4', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', NULL, 'DEBIT', 9.70, 'GBP',
         'The Coffee Lab', 'FOOD_AND_DRINK', '2026-10-26 11:31:00+00', NULL,
         'alex-coffee-lab-2026-10-26'),
        ('09eda551-47b0-56bd-8cb5-13fb5429797c', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', NULL, 'DEBIT', 1200.00, 'GBP',
         'Rent · High Street Homes', 'HOUSING', '2026-10-25 10:00:00+00', NULL,
         'alex-rent-2026-10-25'),
        ('445c5d80-e309-5a79-9aa1-b90b6504a688', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', NULL, 'DEBIT', 21.85, 'GBP',
         'Tesco Express', 'EVERYDAY', '2026-10-24 16:32:00+00', NULL, 'alex-tesco-2026-10-24'),
        ('421e7b7e-5c20-5a12-9919-d3ea1f9cbefc', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', NULL, 'DEBIT', 65.21, 'GBP',
         'British Gas', 'BILLS', '2026-10-22 08:10:00+00', NULL, 'alex-british-gas-2026-10-22'),
        ('d6080d3d-4e40-5079-b7d0-fe2c184d00d2', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', '1f8a727f-40f8-5b81-b3d7-a52033395fc6',
         'DEBIT', 75.00, 'GBP', 'Sam Bennett', 'TRANSFER', '2026-09-18 17:05:00+00',
         'Dinner', 'alex-sam-2026-09-18'),
        ('e6657510-1486-5825-b65a-bda6ff9fdc18', 'cabcc662-0c08-5a82-b350-847e713ca3b7',
         'a4af9cb1-1c67-599b-93b6-a0233710941a', '20c56d45-024d-5ce3-a41b-b68174bdc8d3',
         'DEBIT', 48.50, 'GBP', 'Chloe Williams', 'TRANSFER', '2026-09-04 12:20:00+00',
         'Tickets', 'alex-chloe-2026-09-04'),
        ('dafc2623-a0be-5365-b88a-5dd627be009f', 'cf874fb6-1429-5a1a-9538-961c82062156',
         '19c30a44-4d8d-532a-b9d1-ae3225c8a1a6', NULL, 'CREDIT', 2875.00, 'GBP',
         'Salary · Northstar Health', 'INCOME', '2026-10-28 08:00:00+00', NULL,
         'priya-salary-2026-10-28'),
        ('a75cb229-ad19-567c-8da6-9db1ff51b575', 'cf874fb6-1429-5a1a-9538-961c82062156',
         '19c30a44-4d8d-532a-b9d1-ae3225c8a1a6', '13062dbd-38da-5e47-b1d6-c118bd3d16c1',
         'DEBIT', 120.00, 'GBP', 'Maya Shah', 'TRANSFER', '2026-10-20 19:15:00+00',
         'Birthday', 'priya-maya-2026-10-20'),
        ('3d0c97da-6ae8-5735-a301-3586f46836f9', '1a2cbd9a-b406-5b87-9dc0-d1dd9a51ae2c',
         'a8aa6e7a-e56e-5499-889a-43dec77a5340', NULL, 'CREDIT', 4100.00, 'GBP',
         'Salary · Alder Engineering', 'INCOME', '2026-10-25 08:15:00+00', NULL,
         'daniel-salary-2026-10-25'),
        ('01a29f94-4e87-5cd9-9c94-4a942498229b', '1a2cbd9a-b406-5b87-9dc0-d1dd9a51ae2c',
         'a8aa6e7a-e56e-5499-889a-43dec77a5340', 'a38833a4-a3c0-5a69-a8cc-58ad80548827',
         'DEBIT', 94.20, 'GBP', 'Evans Energy Services', 'BILLS', '2026-10-16 09:40:00+00',
         'Service plan', 'daniel-energy-2026-10-16')
      ON CONFLICT (transaction_id) DO NOTHING
    """,
)


def upgrade() -> None:
    op.execute("""
      CREATE TABLE banking_customers (
        customer_id uuid PRIMARY KEY,
        demo_slug text NOT NULL UNIQUE CHECK (demo_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        first_name text NOT NULL CHECK (btrim(first_name) <> ''),
        last_name text NOT NULL CHECK (btrim(last_name) <> ''),
        initials text NOT NULL CHECK (initials ~ '^[A-Z]{2}$'),
        email text NOT NULL UNIQUE,
        fictional boolean NOT NULL DEFAULT true CHECK (fictional),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE TABLE banking_accounts (
        account_id uuid PRIMARY KEY,
        customer_id uuid NOT NULL REFERENCES banking_customers(customer_id) ON DELETE RESTRICT,
        account_name text NOT NULL CHECK (btrim(account_name) <> ''),
        sort_code text NOT NULL CHECK (sort_code ~ '^[0-9]{6}$'),
        account_number text NOT NULL CHECK (account_number ~ '^[0-9]{8}$'),
        currency text NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
        available_balance numeric(14,2) NOT NULL CHECK (available_balance >= 0),
        card_last_four text NOT NULL CHECK (card_last_four ~ '^[0-9]{4}$'),
        is_primary boolean NOT NULL DEFAULT true,
        status text NOT NULL DEFAULT 'OPEN' CHECK (status = 'OPEN'),
        balance_as_of timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (sort_code, account_number),
        UNIQUE (account_id, customer_id)
      )
    """)
    op.execute("""
      CREATE UNIQUE INDEX banking_accounts_one_primary_idx
      ON banking_accounts (customer_id) WHERE is_primary
    """)
    op.execute("""
      CREATE TABLE banking_beneficiaries (
        beneficiary_id uuid PRIMARY KEY,
        customer_id uuid NOT NULL REFERENCES banking_customers(customer_id) ON DELETE RESTRICT,
        display_name text NOT NULL CHECK (btrim(display_name) <> ''),
        initials text NOT NULL CHECK (initials ~ '^[A-Z]{1,3}$'),
        sort_code text NOT NULL CHECK (sort_code ~ '^[0-9]{6}$'),
        account_number text NOT NULL CHECK (account_number ~ '^[0-9]{8}$'),
        is_seeded boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (customer_id, sort_code, account_number),
        UNIQUE (beneficiary_id, customer_id)
      )
    """)
    op.execute("""
      CREATE TABLE banking_demo_locations (
        location_id uuid PRIMARY KEY,
        customer_id uuid NOT NULL REFERENCES banking_customers(customer_id) ON DELETE RESTRICT,
        location_key text NOT NULL UNIQUE CHECK (location_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        label text NOT NULL CHECK (btrim(label) <> ''),
        latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
        longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
        device_id text NOT NULL CHECK (btrim(device_id) <> ''),
        is_usual boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (location_id, customer_id)
      )
    """)
    op.execute("""
      CREATE UNIQUE INDEX banking_demo_locations_one_usual_idx
      ON banking_demo_locations (customer_id) WHERE is_usual AND active
    """)
    op.execute("""
      CREATE TABLE banking_transactions (
        transaction_id uuid PRIMARY KEY,
        customer_id uuid NOT NULL REFERENCES banking_customers(customer_id) ON DELETE RESTRICT,
        account_id uuid NOT NULL,
        beneficiary_id uuid,
        direction text NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        currency text NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
        display_name text NOT NULL CHECK (btrim(display_name) <> ''),
        category text NOT NULL CHECK (btrim(category) <> ''),
        booked_at timestamptz NOT NULL,
        reference text,
        external_reference text NOT NULL,
        source text NOT NULL DEFAULT 'DEMO_SEED' CHECK (source = 'DEMO_SEED'),
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (account_id, customer_id)
          REFERENCES banking_accounts(account_id, customer_id) ON DELETE RESTRICT,
        FOREIGN KEY (beneficiary_id, customer_id)
          REFERENCES banking_beneficiaries(beneficiary_id, customer_id) ON DELETE RESTRICT,
        UNIQUE (account_id, external_reference)
      )
    """)
    op.execute("""
      CREATE INDEX banking_transactions_customer_booked_idx
      ON banking_transactions (customer_id, booked_at DESC)
    """)
    op.execute("""
      CREATE INDEX banking_transactions_beneficiary_idx
      ON banking_transactions (beneficiary_id, booked_at DESC) WHERE beneficiary_id IS NOT NULL
    """)
    op.execute("""
      CREATE TABLE banking_payment_attempts (
        payment_id uuid PRIMARY KEY,
        transaction_id text NOT NULL UNIQUE CHECK (
          transaction_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
        customer_id uuid NOT NULL REFERENCES banking_customers(customer_id) ON DELETE RESTRICT,
        account_id uuid NOT NULL,
        beneficiary_id uuid NOT NULL,
        demo_location_id uuid NOT NULL,
        amount numeric(14,2) NOT NULL CHECK (amount BETWEEN 0.01 AND 1000000.00),
        currency text NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
        payment_reference text NOT NULL CHECK (
          char_length(btrim(payment_reference)) BETWEEN 1 AND 24
        ),
        idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
        request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        raw_event_payload jsonb NOT NULL CHECK (jsonb_typeof(raw_event_payload) = 'object'),
        trusted_context_snapshot jsonb NOT NULL CHECK (
          jsonb_typeof(trusted_context_snapshot) = 'object'
        ),
        event_time timestamptz NOT NULL,
        ledger_effect text NOT NULL DEFAULT 'NONE' CHECK (ledger_effect = 'NONE'),
        is_simulated boolean NOT NULL DEFAULT true CHECK (is_simulated),
        submitted_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (account_id, customer_id)
          REFERENCES banking_accounts(account_id, customer_id) ON DELETE RESTRICT,
        FOREIGN KEY (beneficiary_id, customer_id)
          REFERENCES banking_beneficiaries(beneficiary_id, customer_id) ON DELETE RESTRICT,
        FOREIGN KEY (demo_location_id, customer_id)
          REFERENCES banking_demo_locations(location_id, customer_id) ON DELETE RESTRICT,
        UNIQUE (customer_id, idempotency_key)
      )
    """)
    op.execute("""
      CREATE INDEX banking_payment_attempts_customer_submitted_idx
      ON banking_payment_attempts (customer_id, submitted_at DESC)
    """)
    op.execute("""
      CREATE FUNCTION reject_banking_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
      END $$
    """)
    op.execute("""
      CREATE TRIGGER banking_transactions_immutable
      BEFORE UPDATE OR DELETE ON banking_transactions
      FOR EACH ROW EXECUTE FUNCTION reject_banking_immutable_mutation()
    """)
    op.execute("""
      CREATE TRIGGER banking_payment_attempts_immutable
      BEFORE UPDATE OR DELETE ON banking_payment_attempts
      FOR EACH ROW EXECUTE FUNCTION reject_banking_immutable_mutation()
    """)
    op.execute("""
      CREATE FUNCTION protect_banking_account_balance() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.available_balance IS DISTINCT FROM OLD.available_balance THEN
          RAISE EXCEPTION 'banking account balances are immutable in the demo'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END $$
    """)
    op.execute("""
      CREATE TRIGGER banking_accounts_balance_immutable
      BEFORE UPDATE OF available_balance ON banking_accounts
      FOR EACH ROW EXECUTE FUNCTION protect_banking_account_balance()
    """)

    for statement in SEED_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE banking_payment_attempts")
    op.execute("DROP TABLE banking_transactions")
    op.execute("DROP TABLE banking_demo_locations")
    op.execute("DROP TABLE banking_beneficiaries")
    op.execute("DROP TABLE banking_accounts")
    op.execute("DROP TABLE banking_customers")
    op.execute("DROP FUNCTION protect_banking_account_balance")
    op.execute("DROP FUNCTION reject_banking_immutable_mutation")
