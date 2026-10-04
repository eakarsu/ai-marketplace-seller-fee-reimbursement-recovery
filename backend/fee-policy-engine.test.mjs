import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFeeLine, assessFeeOrder, fxRateUnits, percentUnits, policyDate } from './fee-policy-engine.mjs';

const policy = { id: 1, version: 1, fee_type_key: 'referral fee', effective_on: '2026-01-01',
  expires_on: '2026-12-31', percent_units: percentUnits('15'), fixed_fee_cents: 30 };
const line = { amount: '18.00', currency: 'USD', statement_date: '2026-07-18', checksum: 'abc',
  line_number: 2, provenance: { feeType: 'Referral fee', grossAmount: '100.00' } };

test('approved percentage plus fixed fee yields exact-cent candidate variance', () => {
  const result = assessFeeLine(policy, line);
  assert.equal(result.expectedCents, 1530);
  assert.equal(result.varianceCents, 270);
  assert.equal(result.status, 'CANDIDATE');
  assert.match(result.calculation.scope, /no marketplace claim acceptance or payout verified/);
  const matched = assessFeeLine(policy, { ...line, amount: '15.30' });
  assert.equal(matched.status, 'NO_VARIANCE');
});

test('fee arithmetic rounds half-up and requires date, exact fee type, and gross amount', () => {
  const rounded = assessFeeLine({ ...policy, percent_units: percentUnits('5'), fixed_fee_cents: 25 },
    { ...line, amount: '1.00', provenance: { feeType: 'Referral fee', grossAmount: '9.99' } });
  assert.equal(rounded.expectedCents, 75);
  const missing = assessFeeLine(policy, { ...line, provenance: { feeType: 'Referral fee' } });
  assert.equal(missing.status, 'INSUFFICIENT');
  assert.equal(missing.varianceCents, null);
  assert.equal(assessFeeLine(policy, { ...line, currency: 'EUR' }).status, 'INSUFFICIENT');
  assert.throws(() => assessFeeLine(policy, { ...line, statement_date: '2027-01-01' }), /date window/);
  assert.throws(() => assessFeeLine(policy, { ...line, provenance: { feeType: 'Storage fee', grossAmount: '100.00' } }), /fee type/);
  assert.throws(() => assessFeeLine(policy, { ...line, provenance: { feeType: 'Referral fee', grossAmount: '100.001' } }), /two decimal/);
});

test('fee policy terms reject invalid dates and excessive percentage precision', () => {
  assert.equal(percentUnits('2.1250'), 21250);
  assert.throws(() => percentUnits('2.12501'), /four decimal/);
  assert.throws(() => policyDate('2026-02-30', 'Effective date'), /valid/);
});

const orderPolicy = { ...policy, id: 4, version: 2, fee_basis: 'PER_ORDER', tax_mode: 'EXCLUDED',
  source_quote: 'Referral fee is 15% of gross plus $0.30 per order, tax excluded, from 2026-01-01 through 2026-12-31.' };
const orderLines = [
  { id: 11, amount: '10.00', currency: 'USD', statement_date: '2026-07-18', checksum: 'fees', line_number: 2,
    source_file: 'settlement.csv', provenance: { orderId: 'ORDER-1', componentId: 'F-1', componentType: 'FEE', feeType: 'Referral fee', grossAmount: '100.00' } },
  { id: 12, amount: '8.00', currency: 'USD', statement_date: '2026-07-18', checksum: 'fees', line_number: 3,
    source_file: 'settlement.csv', provenance: { orderId: 'ORDER-1', componentId: 'F-2', componentType: 'FEE', feeType: 'Referral fee', grossAmount: '100.0' } },
  { id: 13, amount: '1.44', currency: 'USD', statement_date: '2026-07-18', checksum: 'fees', line_number: 4,
    source_file: 'settlement.csv', provenance: { orderId: 'ORDER-1', componentId: 'T-1', componentType: 'TAX', feeType: 'Referral fee' } },
];

test('split per-order fees charge fixed amount once and keep explicit tax outside the variance', () => {
  const result = assessFeeOrder(orderPolicy, orderLines);
  assert.equal(result.status, 'CANDIDATE');
  assert.equal(result.observedCents, 1800);
  assert.equal(result.taxNativeCents, 144);
  assert.equal(result.grossNativeCents, 10000);
  assert.equal(result.expectedCents, 1530);
  assert.equal(result.varianceCents, 270);
  assert.deepEqual(result.componentLineIds, [11, 12, 13]);
});

test('missing tax, duplicate component IDs, or conflicting gross keep an order unresolved', () => {
  assert.equal(assessFeeOrder(orderPolicy, orderLines.slice(0, 2)).status, 'INSUFFICIENT');
  assert.equal(assessFeeOrder(orderPolicy, [orderLines[0], { ...orderLines[1], provenance: { ...orderLines[1].provenance, componentId: 'F-1' } }, orderLines[2]]).status, 'INSUFFICIENT');
  assert.equal(assessFeeOrder(orderPolicy, [orderLines[0], { ...orderLines[1], provenance: { ...orderLines[1].provenance, grossAmount: '90.00' } }, orderLines[2]]).status, 'INSUFFICIENT');
});

test('foreign-currency order requires a reviewed exact-date FX quote and converts aggregates once', () => {
  const euro = orderLines.map(line => ({ ...line, currency: 'EUR' }));
  assert.equal(assessFeeOrder(orderPolicy, euro).status, 'INSUFFICIENT');
  const rate = { id: 8, version: 1, status: 'APPROVED', from_currency: 'EUR', to_currency: 'USD',
    rate_date: '2026-07-18', rate_units: fxRateUnits('1.10'), source_id: 3,
    source_hash: 'fx-hash', source_quote: '1 EUR = 1.10 USD on 2026-07-18' };
  const assessed = assessFeeOrder(orderPolicy, euro, rate);
  assert.equal(assessed.observedCents, 1980);
  assert.equal(assessed.expectedCents, 1680);
  assert.equal(assessed.varianceCents, 300);
  assert.equal(assessed.calculation.conversionRateVersion, 1);
  assert.equal(assessed.calculation.conversionSourceHash, 'fx-hash');
  assert.equal(assessFeeOrder(orderPolicy, euro, { ...rate, rate_date: '2026-07-17' }).status, 'INSUFFICIENT');
  assert.throws(() => fxRateUnits('1.1234567'), /six decimal/);
});
