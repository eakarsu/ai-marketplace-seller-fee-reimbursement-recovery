import { createHash } from 'node:crypto';
import { amount, invalid } from './recovery-domain.mjs';
import { assessFeeLine, assessFeeOrder, fxRateUnits, percentUnits, policyDate, policyKey } from './fee-policy-engine.mjs';

const id = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw invalid('Invalid fee policy or source id', 400);
  return number;
};
const valueText = (value, label, min, max) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw invalid(`${label} must contain ${min}–${max} characters`);
  return value.trim();
};
const role = (user, allowed) => { if (!allowed.includes(user.role)) throw invalid('This role cannot change fee policies', 403); };
async function audit(client, user, action, reference, detail) {
  await client.query('INSERT INTO audit_events(account_id,actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [user.account_id, user.email, action, 'fee_policy', String(reference), JSON.stringify(detail)]);
}
function citedNumber(quote, value, label) {
  const numbers = quote.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || [];
  if (!numbers.some(token => Math.abs(Number(token.replaceAll(',', '')) - Number(value)) < 0.000001))
    throw invalid(`${label} must appear numerically in the exact cited policy quote`);
}
const isoDay = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
async function assessOrders(client, user, policy) {
  const lines = (await client.query(`SELECT line.* FROM statement_lines line
    JOIN feature_records record ON record.account_id=line.account_id AND record.reference=line.record_reference
      AND record.feature_id='order-and-settlement-ingestion'
    WHERE line.account_id=$1 AND line.feature_id='order-and-settlement-ingestion'
      AND lower(trim(regexp_replace(coalesce(record.payload->>'marketplace',''),'[[:space:]]+',' ','g')))=$2
      AND coalesce(record.payload->>'__example','false')<>'true'
      AND lower(trim(regexp_replace(coalesce(line.provenance->>'feeType',''),'[[:space:]]+',' ','g')))=$3
      AND line.reconciliation_status NOT IN ('rejected','credit_line','seeded_example_ignored')
    ORDER BY line.id LIMIT 10001`, [user.account_id, policy.marketplace_key, policy.fee_type_key])).rows;
  if (lines.length > 10000) throw invalid('More than 10,000 matching components; split the assessment into a narrower policy window', 409);
  const groups = new Map();
  for (const line of lines) {
    const orderId = String(line.provenance?.orderId ?? '').trim();
    const key = `${line.record_reference}\u0000${orderId || `missing:${line.id}`}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  let assessed = 0;
  for (const components of groups.values()) {
    const first = components[0];
    const currency = String(first.currency || '').toUpperCase();
    const day = isoDay(first.statement_date);
    const validFxDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) &&
      new Date(day).toISOString().slice(0, 10) === day;
    const fx = currency === 'USD' ? null : (await client.query(`SELECT rate.*,source.content_hash AS source_hash FROM marketplace_fx_rates rate
      JOIN marketplace_policy_sources source ON source.id=rate.source_id AND source.account_id=rate.account_id
      WHERE rate.account_id=$1 AND rate.from_currency=$2 AND rate.to_currency='USD'
        AND rate.rate_date=$3 AND rate.status='APPROVED'`,
    [user.account_id, currency, validFxDay ? day : null])).rows[0] || null;
    const result = assessFeeOrder(policy, components, fx);
    const evidenceSignature = createHash('sha256').update(JSON.stringify({ policyId: policy.id,
      lineIds: result.componentLineIds, fxRateId: result.fxRateId })).digest('hex');
    const inserted = await client.query(`INSERT INTO marketplace_order_fee_assessments(account_id,policy_id,anchor_line_id,
      order_id,component_line_ids,settlement_currency,fx_rate_id,observed_cents,tax_native_cents,gross_native_cents,
      expected_cents,variance_cents,status,evidence_signature,calculation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(policy_id,anchor_line_id,evidence_signature) DO NOTHING RETURNING id`,
    [user.account_id, policy.id, result.anchorLineId, result.orderId, result.componentLineIds,
      result.settlementCurrency, result.fxRateId, result.observedCents, result.taxNativeCents,
      result.grossNativeCents, result.expectedCents, result.varianceCents, result.status,
      evidenceSignature, { ...result.calculation, policySourceId: policy.source_id,
        policySourceHash: policy.source_hash, clauseLocator: policy.clause_locator }]);
    if (inserted.rowCount) assessed++;
  }
  return { policyId: policy.id, newAssessments: assessed, reviewedOrders: groups.size, hasMore: false };
}

export function mountFeePolicyRoutes(app, { pool, auth }) {
  app.get('/api/marketplace/cases', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT id,reference,title,payload->>'marketplace' AS marketplace
        FROM feature_records WHERE account_id=$1 AND feature_id='order-and-settlement-ingestion'
        AND coalesce(payload->>'__example','false')<>'true' ORDER BY updated_at DESC,id DESC LIMIT 200`,
      [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.get('/api/marketplace/sources', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT id,title,content_hash,created_by_id,created_at FROM marketplace_policy_sources
        WHERE account_id=$1 ORDER BY id DESC LIMIT 200`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.get('/api/marketplace/sources/:id', auth, async (req, res, next) => {
    try {
      const source = (await pool.query('SELECT * FROM marketplace_policy_sources WHERE account_id=$1 AND id=$2',
        [req.user.account_id, id(req.params.id)])).rows[0];
      if (!source) throw invalid('Fee policy source not found', 404);
      res.json({ source });
    } catch (error) { next(error); }
  });
  app.post('/api/marketplace/sources', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const title = valueText(req.body?.title, 'Policy document title', 3, 200);
      const content = req.body?.content;
      if (typeof content !== 'string' || content.trim().length < 30 || content.length > 500000)
        throw invalid('Extracted source text must contain 30–500,000 characters');
      const hash = createHash('sha256').update(content).digest('hex');
      client = await pool.connect(); await client.query('BEGIN');
      const source = (await client.query(`INSERT INTO marketplace_policy_sources(account_id,title,content,content_hash,created_by_id)
        VALUES($1,$2,$3,$4,$5) RETURNING id,title,content_hash,created_by_id,created_at`,
      [req.user.account_id, title, content, hash, req.user.id])).rows[0];
      await audit(client, req.user, 'fee_source_saved', source.id, { title, hash, scope: 'Operator-supplied extracted text; marketplace policy authenticity not verified' });
      await client.query('COMMIT'); res.status(201).json({ source });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });

  app.get('/api/marketplace/fx-rates', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT rate.*,source.title AS source_title,source.content_hash AS source_hash
        FROM marketplace_fx_rates rate JOIN marketplace_policy_sources source
          ON source.id=rate.source_id AND source.account_id=rate.account_id
        WHERE rate.account_id=$1 ORDER BY rate.id DESC LIMIT 200`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.post('/api/marketplace/fx-rates', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const fromCurrency = String(req.body?.fromCurrency ?? '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(fromCurrency) || fromCurrency === 'USD') throw invalid('Choose a non-USD three-letter source currency');
      const rateDate = policyDate(req.body?.rateDate, 'FX rate date');
      const rateUnits = fxRateUnits(req.body?.rate);
      const sourceId = id(req.body?.sourceId);
      const locator = valueText(req.body?.clauseLocator, 'FX quote locator', 2, 200);
      const quote = valueText(req.body?.sourceQuote, 'Exact FX source quote', 15, 5000);
      if (!quote.includes(rateDate)) throw invalid('FX quote must contain the exact rate date');
      const quotedRates = [...quote.matchAll(new RegExp(`\\b1\\s+${fromCurrency}\\s*=\\s*(\\d+(?:\\.\\d{1,6})?)\\s+USD\\b`, 'gi'))];
      if (!quotedRates.some(match => fxRateUnits(match[1]) === rateUnits))
        throw invalid(`FX quote must explicitly state 1 ${fromCurrency} = the entered rate USD`);
      client = await pool.connect(); await client.query('BEGIN');
      const source = (await client.query('SELECT * FROM marketplace_policy_sources WHERE account_id=$1 AND id=$2',
        [req.user.account_id, sourceId])).rows[0];
      if (!source) throw invalid('Select an FX source saved in this customer account', 409);
      if (!source.content.includes(quote)) throw invalid('FX quote must exactly match an excerpt of the saved source');
      const version = Number((await client.query(`SELECT coalesce(max(version),0)+1 AS version FROM marketplace_fx_rates
        WHERE account_id=$1 AND from_currency=$2 AND to_currency='USD' AND rate_date=$3`,
      [req.user.account_id, fromCurrency, rateDate])).rows[0].version);
      const rate = (await client.query(`INSERT INTO marketplace_fx_rates(account_id,from_currency,rate_date,rate_units,
        source_id,source_quote,clause_locator,version,created_by_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.account_id, fromCurrency, rateDate, rateUnits, sourceId, quote, locator, version, req.user.id])).rows[0];
      await audit(client, req.user, 'fx_rate_drafted', rate.id, { fromCurrency, toCurrency: 'USD', rateDate,
        rateUnits, version, sourceId, sourceHash: source.content_hash,
        scope: 'Operator-supplied FX quotation; origin and execution rate unverified' });
      await client.query('COMMIT'); res.status(201).json({ rate });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('Concurrent FX rate version; reload and retry', 409) : error); }
    finally { client?.release(); }
  });
  app.post('/api/marketplace/fx-rates/:id/approve', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'reviewer']);
      const rateId = id(req.params.id);
      const rationale = valueText(req.body?.rationale, 'Independent FX review rationale', 20, 2000);
      client = await pool.connect(); await client.query('BEGIN');
      const rate = (await client.query('SELECT * FROM marketplace_fx_rates WHERE account_id=$1 AND id=$2 FOR UPDATE',
        [req.user.account_id, rateId])).rows[0];
      if (!rate) throw invalid('FX rate not found', 404);
      if (rate.status !== 'DRAFT') throw invalid('Only draft FX rates can be approved', 409);
      if (String(rate.created_by_id) === String(req.user.id)) throw invalid('FX rate creator cannot approve their own quote', 403);
      const latestVersion = Number((await client.query(`SELECT coalesce(max(version),0) AS version FROM marketplace_fx_rates
        WHERE account_id=$1 AND from_currency=$2 AND to_currency='USD' AND rate_date=$3 AND status='APPROVED'`,
      [req.user.account_id, rate.from_currency, rate.rate_date])).rows[0].version);
      if (latestVersion >= Number(rate.version)) throw invalid('A newer FX rate version is already approved', 409);
      await client.query(`UPDATE marketplace_fx_rates SET status='SUPERSEDED' WHERE account_id=$1 AND from_currency=$2
        AND to_currency='USD' AND rate_date=$3 AND status='APPROVED'`,
      [req.user.account_id, rate.from_currency, rate.rate_date]);
      const approved = (await client.query(`UPDATE marketplace_fx_rates SET status='APPROVED',approved_by_id=$1,
        approved_at=now() WHERE account_id=$2 AND id=$3 RETURNING *`,
      [req.user.id, req.user.account_id, rate.id])).rows[0];
      await audit(client, req.user, 'fx_rate_approved', rate.id, { version: rate.version, rationale,
        scope: 'Independent review of source-cited operator-supplied FX quote; marketplace settlement and executed conversion unverified' });
      await client.query('COMMIT'); res.json({ rate: approved });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('Another FX version was approved concurrently', 409) : error); }
    finally { client?.release(); }
  });

  app.get('/api/marketplace/policies', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT policy.*,source.title AS source_title,source.content_hash AS source_hash
        FROM marketplace_fee_policies policy
        JOIN marketplace_policy_sources source ON source.id=policy.source_id AND source.account_id=policy.account_id
        WHERE policy.account_id=$1 ORDER BY policy.created_at DESC,policy.id DESC LIMIT 200`,
      [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.post('/api/marketplace/policies', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const body = req.body || {};
      const marketplaceLabel = valueText(body.marketplace, 'Marketplace account', 2, 200);
      const feeTypeLabel = valueText(body.feeType, 'Exact settlement fee type', 2, 200);
      const marketplace = policyKey(marketplaceLabel), feeType = policyKey(feeTypeLabel);
      const effectiveOn = policyDate(body.effectiveOn, 'Policy effective date');
      const expiresOn = policyDate(body.expiresOn, 'Policy expiry date');
      if (effectiveOn > expiresOn) throw invalid('Policy expiry must be on or after the effective date');
      const units = percentUnits(body.percent);
      const fixedCents = amount(body.fixedFeeAmount, 'Fixed fee amount');
      const feeBasis = body.feeBasis === undefined || body.feeBasis === 'PER_LINE' ? 'PER_LINE'
        : body.feeBasis === 'PER_ORDER' ? 'PER_ORDER' : null;
      if (!feeBasis) throw invalid('Choose per-line or per-order fee basis');
      const taxMode = feeBasis === 'PER_ORDER' ? 'EXCLUDED' : 'UNSPECIFIED';
      const sourceId = id(body.sourceId);
      const locator = valueText(body.clauseLocator, 'Policy page or section', 2, 200);
      client = await pool.connect(); await client.query('BEGIN');
      const caseRow = (await client.query(`SELECT id FROM feature_records WHERE account_id=$1 AND feature_id='order-and-settlement-ingestion'
        AND lower(trim(regexp_replace(coalesce(payload->>'marketplace',''),'[[:space:]]+',' ','g')))=$2
        AND coalesce(payload->>'__example','false')<>'true' LIMIT 1`, [req.user.account_id, marketplace])).rows[0];
      if (!caseRow) throw invalid('Create a real settlement case for this marketplace account first', 409);
      const source = (await client.query('SELECT * FROM marketplace_policy_sources WHERE account_id=$1 AND id=$2',
        [req.user.account_id, sourceId])).rows[0];
      if (!source) throw invalid('Select a saved policy source in this customer account', 409);
      const quote = valueText(body.sourceQuote, 'Exact policy quote', 12, 5000);
      if (!source.content.includes(quote)) throw invalid('Policy quote must be an exact excerpt of the saved source text');
      citedNumber(quote, units / 10000, 'Fee percentage');
      if (feeBasis === 'PER_ORDER') {
        if (!/per\s+order/i.test(quote) || !/(?:tax\s+excluded|exclud(?:e|ing)\s+tax)/i.test(quote))
          throw invalid('Per-order policy quote must say per order and explicitly exclude tax');
        if (!quote.includes(effectiveOn) || !quote.includes(expiresOn))
          throw invalid('Per-order policy quote must cite both effective dates');
      }
      if (fixedCents > 0 && feeBasis === 'PER_LINE') {
        citedNumber(quote, fixedCents / 100, 'Fixed fee amount');
        if (!/per\s+(?:settlement\s+)?(?:fee\s+)?line/i.test(quote))
          throw invalid('This calculation supports a fixed fee only when the cited policy states a per-line fee');
      }
      const version = Number((await client.query(`SELECT coalesce(max(version),0)+1 AS version FROM marketplace_fee_policies
        WHERE account_id=$1 AND marketplace_key=$2 AND fee_type_key=$3`, [req.user.account_id, marketplace, feeType])).rows[0].version);
      const policy = (await client.query(`INSERT INTO marketplace_fee_policies(account_id,marketplace_key,marketplace_label,
        fee_type_key,fee_type_label,effective_on,expires_on,percent_units,fixed_fee_cents,source_id,source_quote,
        clause_locator,version,created_by_id,fee_basis,tax_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.user.account_id, marketplace, marketplaceLabel, feeType, feeTypeLabel, effectiveOn, expiresOn,
        units, fixedCents, sourceId, quote, locator, version, req.user.id, feeBasis, taxMode])).rows[0];
      await audit(client, req.user, 'fee_policy_drafted', policy.id, { marketplace, feeType, version, effectiveOn,
        expiresOn, percentUnits: units, fixedFeeCents: fixedCents, sourceHash: source.content_hash });
      await client.query('COMMIT'); res.status(201).json({ policy });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('This fee policy version was created concurrently; reload and retry', 409) : error); }
    finally { client?.release(); }
  });

  app.post('/api/marketplace/policies/:id/approve', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'reviewer']);
      const policyId = id(req.params.id);
      const rationale = valueText(req.body?.rationale, 'Independent review rationale', 20, 2000);
      client = await pool.connect(); await client.query('BEGIN');
      const policy = (await client.query('SELECT * FROM marketplace_fee_policies WHERE account_id=$1 AND id=$2 FOR UPDATE',
        [req.user.account_id, policyId])).rows[0];
      if (!policy) throw invalid('Fee policy not found', 404);
      if (policy.status !== 'DRAFT') throw invalid('Only a draft fee policy can be approved', 409);
      if (String(policy.created_by_id) === String(req.user.id)) throw invalid('The policy creator cannot approve their own rule', 403);
      const latestVersion = Number((await client.query(`SELECT coalesce(max(version),0) AS version FROM marketplace_fee_policies
        WHERE account_id=$1 AND marketplace_key=$2 AND fee_type_key=$3 AND status='APPROVED'`,
      [req.user.account_id, policy.marketplace_key, policy.fee_type_key])).rows[0].version);
      if (latestVersion >= Number(policy.version)) throw invalid('A newer fee policy version is already approved', 409);
      await client.query(`UPDATE marketplace_fee_policies SET status='SUPERSEDED' WHERE account_id=$1
        AND marketplace_key=$2 AND fee_type_key=$3 AND status='APPROVED'`,
      [req.user.account_id, policy.marketplace_key, policy.fee_type_key]);
      const approved = (await client.query(`UPDATE marketplace_fee_policies SET status='APPROVED',approved_by_id=$1,
        approved_at=now() WHERE account_id=$2 AND id=$3 RETURNING *`, [req.user.id, req.user.account_id, policyId])).rows[0];
      await audit(client, req.user, 'fee_policy_approved', policyId, { version: policy.version, rationale,
        scope: 'Independent approval of operator-supplied policy text and fee terms; marketplace acceptance not verified' });
      await client.query('COMMIT'); res.json({ policy: approved });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('Another policy version was approved concurrently; reload', 409) : error); }
    finally { client?.release(); }
  });

  app.get('/api/marketplace/policies/:id/assessments', auth, async (req, res, next) => {
    try {
      const policyId = id(req.params.id);
      const policy = (await pool.query('SELECT id,fee_basis FROM marketplace_fee_policies WHERE account_id=$1 AND id=$2',
        [req.user.account_id, policyId])).rows[0];
      if (!policy) throw invalid('Fee policy not found', 404);
      const items = policy.fee_basis === 'PER_ORDER' ? (await pool.query(`SELECT assessment.*,line.source_file,line.line_number,line.checksum,line.description,
        line.amount,line.statement_date,line.currency FROM marketplace_order_fee_assessments assessment
        JOIN statement_lines line ON line.id=assessment.anchor_line_id AND line.account_id=assessment.account_id
        WHERE assessment.account_id=$1 AND assessment.policy_id=$2 ORDER BY assessment.id DESC LIMIT 500`,
      [req.user.account_id, policyId])).rows : (await pool.query(`SELECT assessment.*,line.source_file,line.line_number,line.checksum,line.description,
        line.amount,line.statement_date,line.currency FROM marketplace_fee_assessments assessment
        JOIN statement_lines line ON line.id=assessment.statement_line_id AND line.account_id=assessment.account_id
        WHERE assessment.account_id=$1 AND assessment.policy_id=$2 ORDER BY assessment.id DESC LIMIT 500`,
      [req.user.account_id, policyId])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.post('/api/marketplace/policies/:id/assess', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator', 'reviewer']);
      const policyId = id(req.params.id);
      client = await pool.connect(); await client.query('BEGIN');
      const policy = (await client.query(`SELECT policy.*,source.content_hash AS source_hash
        FROM marketplace_fee_policies policy
        JOIN marketplace_policy_sources source ON source.id=policy.source_id AND source.account_id=policy.account_id
        WHERE policy.account_id=$1 AND policy.id=$2 FOR UPDATE OF policy`, [req.user.account_id, policyId])).rows[0];
      if (!policy) throw invalid('Fee policy not found', 404);
      if (policy.status !== 'APPROVED') throw invalid('Only an approved fee policy can assess imported settlements', 409);
      if (policy.fee_basis === 'PER_ORDER') {
        const result = await assessOrders(client, req.user, policy);
        if (result.newAssessments) await audit(client, req.user, 'settlement_orders_assessed', policyId, {
          version: policy.version, newAssessments: result.newAssessments,
          scope: 'Order components assessed once with explicit tax and reviewed FX evidence; no marketplace outcome verified' });
        await client.query('COMMIT'); res.json(result); return;
      }
      const lines = (await client.query(`SELECT line.* FROM statement_lines line
        JOIN feature_records record ON record.account_id=line.account_id AND record.reference=line.record_reference
          AND record.feature_id='order-and-settlement-ingestion'
        LEFT JOIN marketplace_fee_assessments prior ON prior.statement_line_id=line.id
          AND prior.policy_id=$6 AND prior.account_id=line.account_id
        WHERE line.account_id=$1 AND line.feature_id='order-and-settlement-ingestion'
          AND lower(trim(regexp_replace(coalesce(record.payload->>'marketplace',''),'[[:space:]]+',' ','g')))=$2
          AND coalesce(record.payload->>'__example','false')<>'true'
          AND lower(trim(regexp_replace(coalesce(line.provenance->>'feeType',''),'[[:space:]]+',' ','g')))=$3
          AND (line.provenance->>'componentType' IS NULL OR upper(line.provenance->>'componentType')='FEE')
          AND line.statement_date BETWEEN $4 AND $5
          AND line.reconciliation_status NOT IN ('rejected','credit_line','seeded_example_ignored') AND prior.id IS NULL
        ORDER BY line.id LIMIT 1001`,
      [req.user.account_id, policy.marketplace_key, policy.fee_type_key, policy.effective_on,
        policy.expires_on, policy.id])).rows;
      const hasMore = lines.length > 1000;
      let assessed = 0;
      for (const line of lines.slice(0, 1000)) {
        const result = assessFeeLine(policy, line);
        const saved = await client.query(`INSERT INTO marketplace_fee_assessments(account_id,policy_id,statement_line_id,
          observed_cents,expected_cents,variance_cents,status,calculation)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(policy_id,statement_line_id) DO NOTHING RETURNING id`,
        [req.user.account_id, policy.id, line.id, result.observedCents, result.expectedCents,
          result.varianceCents, result.status, { ...result.calculation, policySourceId: policy.source_id,
            policySourceHash: policy.source_hash, clauseLocator: policy.clause_locator }]);
        if (saved.rowCount) assessed++;
      }
      if (assessed) await audit(client, req.user, 'settlement_fees_assessed', policyId, { version: policy.version,
        assessed, scope: 'Immutable fee calculations from imported lines; no marketplace payout verified' });
      await client.query('COMMIT'); res.json({ policyId, newAssessments: assessed,
        reviewedLines: Math.min(lines.length, 1000), hasMore });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });
}
