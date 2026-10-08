-- Schema definition for StellarHomes PostgreSQL persistence
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(56) UNIQUE NOT NULL,
    role VARCHAR(32) NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS properties (
    id SERIAL PRIMARY KEY,
    title_hash VARCHAR(66) NOT NULL,
    trustee_address VARCHAR(56) NOT NULL,
    status VARCHAR(32) NOT NULL,
    valuation_units BIGINT DEFAULT 0,
    verified_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS milestones (
    id SERIAL PRIMARY KEY,
    property_id INT REFERENCES properties(id),
    stage_index INT NOT NULL,
    evidence_hash VARCHAR(66),
    verified BOOLEAN DEFAULT FALSE,
    released BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mortgages (
    id SERIAL PRIMARY KEY,
    property_id INT REFERENCES properties(id),
    borrower_address VARCHAR(56) NOT NULL,
    principal_units BIGINT NOT NULL,
    rate_bps INT NOT NULL,
    term_months INT NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
