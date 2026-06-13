-- GCI Financial Database Initialization
-- Creates all necessary databases and extensions for GCI platform

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- Create GCI application databases
SELECT 'CREATE DATABASE gci_dify' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gci_dify')\gexec
SELECT 'CREATE DATABASE gci_nocodb' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gci_nocodb')\gexec
SELECT 'CREATE DATABASE gci_windmill' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gci_windmill')\gexec
SELECT 'CREATE DATABASE gci_appsmith' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gci_appsmith')\gexec

-- Grant privileges to gci_user
GRANT ALL PRIVILEGES ON DATABASE gci_n8n TO gci_user;
GRANT ALL PRIVILEGES ON DATABASE gci_dify TO gci_user;
GRANT ALL PRIVILEGES ON DATABASE gci_nocodb TO gci_user;
GRANT ALL PRIVILEGES ON DATABASE gci_windmill TO gci_user;
GRANT ALL PRIVILEGES ON DATABASE gci_appsmith TO gci_user;

-- Create schemas for each application
\c gci_n8n;
CREATE SCHEMA IF NOT EXISTS gci AUTHORIZATION gci_user;
CREATE SCHEMA IF NOT EXISTS n8n AUTHORIZATION gci_user;

\c gci_dify;
CREATE SCHEMA IF NOT EXISTS gci AUTHORIZATION gci_user;
CREATE SCHEMA IF NOT EXISTS dify AUTHORIZATION gci_user;

\c gci_nocodb;
CREATE SCHEMA IF NOT EXISTS gci AUTHORIZATION gci_user;
CREATE SCHEMA IF NOT EXISTS nocodb AUTHORIZATION gci_user;

\c gci_windmill;
CREATE SCHEMA IF NOT EXISTS gci AUTHORIZATION gci_user;
CREATE SCHEMA IF NOT EXISTS windmill AUTHORIZATION gci_user;

\c gci_appsmith;
CREATE SCHEMA IF NOT EXISTS gci AUTHORIZATION gci_user;
CREATE SCHEMA IF NOT EXISTS appsmith AUTHORIZATION gci_user;

-- GCI Core Tables (in gci_n8n.gci schema)
\c gci_n8n;
SET search_path TO gci, public;

-- Members table
CREATE TABLE IF NOT EXISTS members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_number VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE,
    ssn_encrypted TEXT,
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(2),
    zip_code VARCHAR(10),
    country VARCHAR(2) DEFAULT 'US',
    church_id UUID,
    denomination_id UUID,
    status VARCHAR(20) DEFAULT 'active',
    kyc_status VARCHAR(20) DEFAULT 'pending',
    kyc_level VARCHAR(20) DEFAULT 'basic',
    risk_score INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Churches table
CREATE TABLE IF NOT EXISTS churches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    church_number VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    denomination_id UUID,
    ein VARCHAR(20),
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(2),
    zip_code VARCHAR(10),
    phone VARCHAR(20),
    email VARCHAR(255),
    website VARCHAR(255),
    pastor_name VARCHAR(200),
    treasurer_id UUID,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Accounts table
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_number VARCHAR(50) UNIQUE NOT NULL,
    member_id UUID NOT NULL REFERENCES members(id),
    account_type VARCHAR(20) NOT NULL,
    balance_cents BIGINT DEFAULT 0,
    available_cents BIGINT DEFAULT 0,
    currency VARCHAR(3) DEFAULT 'USD',
    status VARCHAR(20) DEFAULT 'active',
    opened_date DATE DEFAULT CURRENT_DATE,
    closed_date DATE,
    interest_rate_bps INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id VARCHAR(50) UNIQUE NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(id),
    member_id UUID NOT NULL REFERENCES members(id),
    type VARCHAR(20) NOT NULL,
    amount_cents BIGINT NOT NULL,
    balance_after_cents BIGINT NOT NULL,
    description TEXT,
    reference VARCHAR(100),
    category VARCHAR(50),
    subcategory VARCHAR(50),
    church_id UUID,
    status VARCHAR(20) DEFAULT 'completed',
    posted_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Church giving table
CREATE TABLE IF NOT EXISTS church_giving (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id VARCHAR(50) UNIQUE NOT NULL,
    church_id UUID NOT NULL REFERENCES churches(id),
    member_id UUID NOT NULL REFERENCES members(id),
    amount_cents BIGINT NOT NULL,
    tithe_type VARCHAR(20) NOT NULL,
    payment_method VARCHAR(20) NOT NULL,
    is_recurring BOOLEAN DEFAULT FALSE,
    frequency VARCHAR(20),
    anonymous BOOLEAN DEFAULT FALSE,
    receipt_number VARCHAR(50) UNIQUE,
    tax_deductible BOOLEAN DEFAULT TRUE,
    budget_allocation JSONB,
    posted_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Church budgets table
CREATE TABLE IF NOT EXISTS church_budgets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    church_id UUID NOT NULL REFERENCES churches(id),
    fiscal_year INTEGER NOT NULL,
    category VARCHAR(50) NOT NULL,
    budgeted_cents BIGINT NOT NULL,
    actual_cents BIGINT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'draft',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(church_id, fiscal_year, category)
);

-- Recurring pledges table
CREATE TABLE IF NOT EXISTS recurring_pledges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    church_id UUID NOT NULL REFERENCES churches(id),
    member_id UUID NOT NULL REFERENCES members(id),
    amount_cents BIGINT NOT NULL,
    tithe_type VARCHAR(20) NOT NULL,
    frequency VARCHAR(20) NOT NULL,
    payment_method VARCHAR(20) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,
    status VARCHAR(20) DEFAULT 'active',
    next_processing_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- KYC records table
CREATE TABLE IF NOT EXISTS kyc_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id UUID NOT NULL REFERENCES members(id),
    verification_level VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    identity_verified BOOLEAN DEFAULT FALSE,
    address_verified BOOLEAN DEFAULT FALSE,
    sanctions_clear BOOLEAN DEFAULT FALSE,
    pep_check BOOLEAN DEFAULT FALSE,
    adverse_media VARCHAR(20) DEFAULT 'not_checked',
    risk_score INTEGER DEFAULT 0,
    recommendation VARCHAR(20) DEFAULT 'review',
    verified_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- AML alerts table
CREATE TABLE IF NOT EXISTS aml_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_id VARCHAR(50) UNIQUE NOT NULL,
    member_id UUID REFERENCES members(id),
    account_id UUID REFERENCES accounts(id),
    alert_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'medium',
    description TEXT,
    amount_cents BIGINT,
    rule_triggered VARCHAR(100),
    status VARCHAR(20) DEFAULT 'open',
    assigned_to UUID,
    resolved_at TIMESTAMPTZ,
    resolution VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- SAR filings table
CREATE TABLE IF NOT EXISTS sar_filings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sar_id VARCHAR(50) UNIQUE NOT NULL,
    case_id UUID NOT NULL,
    alert_ids TEXT[],
    filing_type VARCHAR(20) DEFAULT 'initial',
    activity_category VARCHAR(50),
    subject_member_id UUID REFERENCES members(id),
    total_amount_cents BIGINT,
    date_start DATE,
    date_end DATE,
    narrative TEXT,
    bsa_reference VARCHAR(50),
    status VARCHAR(20) DEFAULT 'draft',
    submitted_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cards table
CREATE TABLE IF NOT EXISTS cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    card_token VARCHAR(100) UNIQUE NOT NULL,
    member_id UUID NOT NULL REFERENCES members(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    card_type VARCHAR(20) NOT NULL,
    last_four VARCHAR(4) NOT NULL,
    expiry_month INTEGER NOT NULL,
    expiry_year INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    daily_limit_cents BIGINT DEFAULT 500000,
    monthly_limit_cents BIGINT DEFAULT 2000000,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Loans table
CREATE TABLE IF NOT EXISTS loans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loan_id VARCHAR(50) UNIQUE NOT NULL,
    member_id UUID NOT NULL REFERENCES members(id),
    loan_type VARCHAR(50) NOT NULL,
    requested_amount_cents BIGINT NOT NULL,
    approved_amount_cents BIGINT,
    term_months INTEGER NOT NULL,
    interest_rate_bps INTEGER,
    purpose TEXT,
    status VARCHAR(20) DEFAULT 'submitted',
    application_id VARCHAR(50),
    dti_ratio DECIMAL(5,2),
    credit_score INTEGER,
    risk_grade VARCHAR(10),
    conditions TEXT[],
    funded_at TIMESTAMPTZ,
    next_payment_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Denomination admins table
CREATE TABLE IF NOT EXISTS denomination_admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    denomination_id UUID NOT NULL,
    member_id UUID NOT NULL REFERENCES members(id),
    role VARCHAR(50) NOT NULL,
    permissions JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    actor_type VARCHAR(20) NOT NULL,
    actor_id UUID,
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Push subscriptions table (for PWA notifications)
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id UUID NOT NULL REFERENCES members(id),
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Early deposit enrollments
CREATE TABLE IF NOT EXISTS early_deposit_enrollments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id UUID NOT NULL REFERENCES members(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Roundup giving
CREATE TABLE IF NOT EXISTS roundup_giving (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id UUID NOT NULL REFERENCES members(id),
    church_id UUID NOT NULL REFERENCES churches(id),
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Savings goals
CREATE TABLE IF NOT EXISTS savings_goals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id UUID NOT NULL REFERENCES members(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    name VARCHAR(200) NOT NULL,
    target_cents BIGINT NOT NULL,
    current_cents BIGINT DEFAULT 0,
    target_date DATE,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Joint account invites
CREATE TABLE IF NOT EXISTS joint_account_invites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    invitee_email VARCHAR(255) NOT NULL,
    invited_by UUID NOT NULL REFERENCES members(id),
    status VARCHAR(20) DEFAULT 'pending',
    token VARCHAR(100) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Leads table (for investor pitch / church registration)
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255),
    name VARCHAR(200),
    church_name VARCHAR(255),
    denomination VARCHAR(200),
    role VARCHAR(50),
    message TEXT,
    source VARCHAR(50),
    status VARCHAR(20) DEFAULT 'new',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_church_id ON members(church_id);
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_accounts_member_id ON accounts(member_id);
CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_member_id ON transactions(member_id);
CREATE INDEX IF NOT EXISTS idx_transactions_posted_at ON transactions(posted_at);
CREATE INDEX IF NOT EXISTS idx_church_giving_church_id ON church_giving(church_id);
CREATE INDEX IF NOT EXISTS idx_church_giving_member_id ON church_giving(member_id);
CREATE INDEX IF NOT EXISTS idx_church_giving_posted_at ON church_giving(posted_at);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_member_id ON aml_alerts(member_id);
CREATE INDEX IF NOT EXISTS idx_aml_alerts_status ON aml_alerts(status);
CREATE INDEX IF NOT EXISTS idx_sar_filings_case_id ON sar_filings(case_id);
CREATE INDEX IF NOT EXISTS idx_sar_filings_status ON sar_filings(status);
CREATE INDEX IF NOT EXISTS idx_kyc_records_member_id ON kyc_records(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_member_id ON loans(member_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_member_id ON push_subscriptions(member_id);

-- Grant permissions
GRANT ALL ON ALL TABLES IN SCHEMA gci TO gci_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA gci TO gci_user;
GRANT USAGE ON SCHEMA gci TO gci_user;

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA gci GRANT ALL ON TABLES TO gci_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA gci GRANT ALL ON SEQUENCES TO gci_user;