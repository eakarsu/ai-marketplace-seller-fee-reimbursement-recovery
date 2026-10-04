-- Customer-scoped source text, reviewed fee schedules and immutable settlement assessments.
CREATE UNIQUE INDEX IF NOT EXISTS app_users_id_account_idx ON app_users(id,account_id);
CREATE TABLE IF NOT EXISTS marketplace_policy_sources (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (created_by_id,account_id) REFERENCES app_users(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_policy_sources_id_account_idx ON marketplace_policy_sources(id,account_id);
CREATE INDEX IF NOT EXISTS marketplace_policy_sources_account_idx ON marketplace_policy_sources(account_id,created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_fee_policies (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  marketplace_key TEXT NOT NULL,
  marketplace_label TEXT NOT NULL,
  fee_type_key TEXT NOT NULL,
  fee_type_label TEXT NOT NULL,
  effective_on DATE NOT NULL,
  expires_on DATE NOT NULL,
  percent_units BIGINT NOT NULL CHECK(percent_units BETWEEN 0 AND 1000000),
  fixed_fee_cents BIGINT NOT NULL CHECK(fixed_fee_cents >= 0),
  source_id BIGINT NOT NULL,
  source_quote TEXT NOT NULL,
  clause_locator TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','SUPERSEDED')),
  created_by_id BIGINT NOT NULL,
  approved_by_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  CHECK(effective_on <= expires_on),
  UNIQUE(account_id,marketplace_key,fee_type_key,version),
  FOREIGN KEY (source_id,account_id) REFERENCES marketplace_policy_sources(id,account_id),
  FOREIGN KEY (created_by_id,account_id) REFERENCES app_users(id,account_id),
  FOREIGN KEY (approved_by_id,account_id) REFERENCES app_users(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_fee_policies_id_account_idx ON marketplace_fee_policies(id,account_id);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_fee_policies_one_approved_idx ON marketplace_fee_policies(account_id,marketplace_key,fee_type_key) WHERE status='APPROVED';
CREATE INDEX IF NOT EXISTS marketplace_fee_policies_account_idx ON marketplace_fee_policies(account_id,marketplace_key,fee_type_key);

CREATE TABLE IF NOT EXISTS marketplace_fee_assessments (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  policy_id BIGINT NOT NULL,
  statement_line_id BIGINT NOT NULL,
  observed_cents BIGINT NOT NULL,
  expected_cents BIGINT,
  variance_cents BIGINT,
  status TEXT NOT NULL CHECK(status IN ('CANDIDATE','NO_VARIANCE','INSUFFICIENT')),
  calculation JSONB NOT NULL,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(policy_id,statement_line_id),
  FOREIGN KEY (policy_id,account_id) REFERENCES marketplace_fee_policies(id,account_id),
  FOREIGN KEY (statement_line_id,account_id) REFERENCES statement_lines(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_fee_assessments_id_account_idx ON marketplace_fee_assessments(id,account_id);
CREATE INDEX IF NOT EXISTS marketplace_fee_assessments_account_policy_idx ON marketplace_fee_assessments(account_id,policy_id,status);

ALTER TABLE recovery_claims ADD COLUMN IF NOT EXISTS marketplace_assessment_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS recovery_claims_marketplace_assessment_idx ON recovery_claims(marketplace_assessment_id) WHERE marketplace_assessment_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='recovery_claims_marketplace_assessment_account_fkey') THEN
    ALTER TABLE recovery_claims ADD CONSTRAINT recovery_claims_marketplace_assessment_account_fkey
      FOREIGN KEY (marketplace_assessment_id,account_id) REFERENCES marketplace_fee_assessments(id,account_id);
  END IF;
END $$;
