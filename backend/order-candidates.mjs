// Shared source-of-truth gate for current per-order candidates and dashboard totals.
// Claims add a separate no-prior-claim condition to this query.
export const orderAssessmentSql = `SELECT assessment.id AS marketplace_order_assessment_id,
  assessment.policy_id,assessment.order_id,assessment.component_line_ids,assessment.variance_cents,
  assessment.tax_native_cents,assessment.gross_native_cents,assessment.settlement_currency AS source_currency,
  assessment.calculation,anchor.id,anchor.feature_id,anchor.reference,anchor.record_reference,
  anchor.source_file,anchor.line_number,anchor.amount,anchor.checksum,
  'USD'::text AS currency,assessment.variance_cents::numeric/100 AS delta,
  policy.version AS policy_version,policy.fee_type_label,policy.marketplace_label,
  policy.source_quote AS policy_quote
 FROM marketplace_order_fee_assessments assessment
 JOIN marketplace_fee_policies policy ON policy.id=assessment.policy_id
   AND policy.account_id=assessment.account_id AND policy.status='APPROVED' AND policy.fee_basis='PER_ORDER'
 JOIN statement_lines anchor ON anchor.id=assessment.anchor_line_id AND anchor.account_id=assessment.account_id
 JOIN feature_records record ON record.account_id=anchor.account_id AND record.reference=anchor.record_reference
   AND record.feature_id='order-and-settlement-ingestion'
 LEFT JOIN marketplace_fx_rates fx ON fx.id=assessment.fx_rate_id AND fx.account_id=assessment.account_id
 WHERE assessment.account_id=$1 AND assessment.status='CANDIDATE' AND assessment.variance_cents>0
   AND coalesce(record.payload->>'__example','false')<>'true'
   AND lower(trim(regexp_replace(coalesce(record.payload->>'marketplace',''),'[[:space:]]+',' ','g')))=policy.marketplace_key
   AND (assessment.settlement_currency='USD' OR fx.status='APPROVED')
   AND NOT EXISTS (SELECT 1 FROM recovery_claims overlapping_claim
     WHERE overlapping_claim.account_id=assessment.account_id
       AND overlapping_claim.statement_line_id=ANY(assessment.component_line_ids)
       AND overlapping_claim.marketplace_order_assessment_id IS DISTINCT FROM assessment.id)
   AND NOT EXISTS (SELECT 1 FROM marketplace_order_fee_assessments newer
     WHERE newer.account_id=assessment.account_id AND newer.policy_id=assessment.policy_id
       AND newer.order_id=assessment.order_id AND newer.anchor_line_id=assessment.anchor_line_id
       AND newer.id>assessment.id)
   AND assessment.component_line_ids=ARRAY(SELECT member.id FROM statement_lines member
     WHERE member.account_id=assessment.account_id AND member.feature_id='order-and-settlement-ingestion'
       AND member.record_reference=anchor.record_reference
       AND member.provenance->>'orderId'=assessment.order_id
       AND lower(trim(regexp_replace(coalesce(member.provenance->>'feeType',''),'[[:space:]]+',' ','g')))=policy.fee_type_key
       AND member.reconciliation_status NOT IN ('rejected','credit_line','seeded_example_ignored')
     ORDER BY member.id)`;

export const unclaimedOrderSql = `NOT EXISTS (SELECT 1 FROM recovery_claims prior_claim
  LEFT JOIN marketplace_order_fee_assessments old_assessment
    ON old_assessment.id=prior_claim.marketplace_order_assessment_id AND old_assessment.account_id=prior_claim.account_id
  LEFT JOIN marketplace_fee_policies old_policy
    ON old_policy.id=old_assessment.policy_id AND old_policy.account_id=prior_claim.account_id
  WHERE prior_claim.account_id=assessment.account_id AND prior_claim.record_reference=anchor.record_reference
    AND ((prior_claim.statement_line_id=ANY(assessment.component_line_ids))
      OR (old_assessment.order_id=assessment.order_id AND old_policy.marketplace_key=policy.marketplace_key
        AND old_policy.fee_type_key=policy.fee_type_key)))`;
