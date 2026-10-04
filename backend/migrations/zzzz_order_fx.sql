-- Per-order settlement evidence and operator-supplied dated FX quotes.
ALTER TABLE marketplace_fee_policies ADD COLUMN IF NOT EXISTS fee_basis TEXT NOT NULL DEFAULT 'PER_LINE';
ALTER TABLE marketplace_fee_policies ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'UNSPECIFIED';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='marketplace_fee_policies_basis_check') THEN
  ALTER TABLE marketplace_fee_policies ADD CONSTRAINT marketplace_fee_policies_basis_check
   CHECK ((fee_basis='PER_LINE' AND tax_mode='UNSPECIFIED') OR (fee_basis='PER_ORDER' AND tax_mode='EXCLUDED'));
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketplace_fx_rates (
 id BIGSERIAL PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES customer_accounts(id),
 from_currency TEXT NOT NULL CHECK(from_currency ~ '^[A-Z]{3}$' AND from_currency <> 'USD'),
 to_currency TEXT NOT NULL DEFAULT 'USD' CHECK(to_currency='USD'),
 rate_date DATE NOT NULL,
 rate_units BIGINT NOT NULL CHECK(rate_units > 0 AND rate_units <= 100000000),
 source_id BIGINT NOT NULL,
 source_quote TEXT NOT NULL,
 clause_locator TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version > 0),
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','SUPERSEDED')),
 created_by_id BIGINT NOT NULL,
 approved_by_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 approved_at TIMESTAMPTZ,
 UNIQUE(account_id,from_currency,to_currency,rate_date,version),
 FOREIGN KEY (source_id,account_id) REFERENCES marketplace_policy_sources(id,account_id),
 FOREIGN KEY (created_by_id,account_id) REFERENCES app_users(id,account_id),
 FOREIGN KEY (approved_by_id,account_id) REFERENCES app_users(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_fx_rates_id_account_idx ON marketplace_fx_rates(id,account_id);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_fx_rates_one_approved_idx ON marketplace_fx_rates(account_id,from_currency,to_currency,rate_date) WHERE status='APPROVED';

CREATE TABLE IF NOT EXISTS marketplace_order_fee_assessments (
 id BIGSERIAL PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES customer_accounts(id),
 policy_id BIGINT NOT NULL,
 anchor_line_id BIGINT NOT NULL,
 order_id TEXT,
 component_line_ids BIGINT[] NOT NULL,
 settlement_currency TEXT NOT NULL,
 fx_rate_id BIGINT,
 observed_cents BIGINT NOT NULL,
 tax_native_cents BIGINT,
 gross_native_cents BIGINT,
 expected_cents BIGINT,
 variance_cents BIGINT,
 status TEXT NOT NULL CHECK(status IN ('CANDIDATE','NO_VARIANCE','INSUFFICIENT')),
 evidence_signature TEXT NOT NULL,
 calculation JSONB NOT NULL,
 assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(policy_id,anchor_line_id,evidence_signature),
 FOREIGN KEY (policy_id,account_id) REFERENCES marketplace_fee_policies(id,account_id),
 FOREIGN KEY (anchor_line_id,account_id) REFERENCES statement_lines(id,account_id),
 FOREIGN KEY (fx_rate_id,account_id) REFERENCES marketplace_fx_rates(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_order_fee_assessments_id_account_idx ON marketplace_order_fee_assessments(id,account_id);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_order_fee_assessments_claim_link_idx ON marketplace_order_fee_assessments(id,account_id,anchor_line_id);
CREATE INDEX IF NOT EXISTS marketplace_order_fee_assessments_account_policy_idx ON marketplace_order_fee_assessments(account_id,policy_id,status);

ALTER TABLE recovery_claims ADD COLUMN IF NOT EXISTS marketplace_order_assessment_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS recovery_claims_order_assessment_idx ON recovery_claims(marketplace_order_assessment_id) WHERE marketplace_order_assessment_id IS NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='recovery_claims_order_assessment_line_fkey') THEN
  ALTER TABLE recovery_claims ADD CONSTRAINT recovery_claims_order_assessment_line_fkey
   FOREIGN KEY (marketplace_order_assessment_id,account_id,statement_line_id)
   REFERENCES marketplace_order_fee_assessments(id,account_id,anchor_line_id);
 END IF;
END $$;
