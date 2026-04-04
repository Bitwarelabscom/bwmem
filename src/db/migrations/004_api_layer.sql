-- bwmem API layer: tenant management and usage tracking

CREATE TABLE IF NOT EXISTS ${prefix}api_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  api_key_hash VARCHAR(128) NOT NULL UNIQUE,
  api_key_prefix VARCHAR(12) NOT NULL,
  tier VARCHAR(20) NOT NULL DEFAULT 'tester'
    CHECK (tier IN ('tester', 'hobby', 'builder', 'enterprise')),
  max_users INT NOT NULL DEFAULT 1,
  max_embeddings_per_month INT NOT NULL DEFAULT 1500,
  rate_limit_per_minute INT NOT NULL DEFAULT 10,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}api_tenants_key_hash
  ON ${prefix}api_tenants(api_key_hash);

CREATE TABLE IF NOT EXISTS ${prefix}api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES ${prefix}api_tenants(id),
  endpoint VARCHAR(100) NOT NULL,
  method VARCHAR(10) NOT NULL,
  embedding_tokens INT DEFAULT 0,
  status_code INT,
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}api_usage_tenant_month
  ON ${prefix}api_usage(tenant_id, created_at DESC);
