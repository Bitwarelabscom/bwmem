-- bwmem user management: magic links, email verification, key rotation,
-- IP allowlists, audit log

-- ---- Extend api_tenants ----

ALTER TABLE ${prefix}api_tenants
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registration_source VARCHAR(20) DEFAULT 'admin'
    CHECK (registration_source IN ('admin', 'self_service')),
  ADD COLUMN IF NOT EXISTS prev_api_key_hash VARCHAR(128),
  ADD COLUMN IF NOT EXISTS prev_key_expires_at TIMESTAMPTZ;

-- Backward compat: mark all existing (admin-created) tenants as verified
UPDATE ${prefix}api_tenants
  SET email_verified = TRUE, email_verified_at = NOW()
  WHERE email_verified IS NOT TRUE;

-- Partial index for grace-period key lookups
CREATE INDEX IF NOT EXISTS idx_${prefix}api_tenants_prev_key
  ON ${prefix}api_tenants(prev_api_key_hash)
  WHERE prev_api_key_hash IS NOT NULL;

-- ---- Magic link tokens ----

CREATE TABLE IF NOT EXISTS ${prefix}magic_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES ${prefix}api_tenants(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('login', 'verify_email')),
  ip_address INET,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}magic_tokens_hash
  ON ${prefix}magic_link_tokens(token_hash) WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_${prefix}magic_tokens_tenant
  ON ${prefix}magic_link_tokens(tenant_id, created_at DESC);

-- ---- IP allowlist per tenant ----

CREATE TABLE IF NOT EXISTS ${prefix}tenant_ip_allowlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES ${prefix}api_tenants(id) ON DELETE CASCADE,
  cidr CIDR NOT NULL,
  label VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}ip_allowlist_tenant
  ON ${prefix}tenant_ip_allowlist(tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}ip_allowlist_unique
  ON ${prefix}tenant_ip_allowlist(tenant_id, cidr);

-- ---- Auth audit log ----

CREATE TABLE IF NOT EXISTS ${prefix}auth_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES ${prefix}api_tenants(id) ON DELETE SET NULL,
  event_type VARCHAR(40) NOT NULL,
  ip_address INET,
  user_agent TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${prefix}audit_log_tenant
  ON ${prefix}auth_audit_log(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_${prefix}audit_log_event
  ON ${prefix}auth_audit_log(event_type, created_at DESC);
