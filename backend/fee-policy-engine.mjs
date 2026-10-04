import { amount, invalid } from './recovery-domain.mjs';

export const policyKey = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const isoDay = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);

export function percentUnits(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(text) || Number(text) > 100)
    throw invalid('Fee percentage must be 0–100 with at most four decimal places');
  const [whole, fraction = ''] = text.split('.');
  return Number(BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0')));
}
export function policyDate(value, label) {
  const date = String(value ?? '');
  if (!validDay(date)) throw invalid(`${label} must be a valid YYYY-MM-DD date`);
  return date;
}
export function fxRateUnits(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text) || Number(text) <= 0 || Number(text) > 100)
    throw invalid('FX rate must be greater than zero and no more than 100, with at most six decimal places');
  const [whole, fraction = ''] = text.split('.');
  return Number(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')));
}

const safe = value => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('Grouped settlement amount exceeds supported precision');
  return Number(value);
};
const converted = (nativeCents, rateUnits) => safe((BigInt(nativeCents) * BigInt(rateUnits) + 500000n) / 1000000n);
export function assessFeeOrder(policy, lines, fxRate = null) {
  if (policy.fee_basis !== 'PER_ORDER' || policy.tax_mode !== 'EXCLUDED')
    throw invalid('A reviewed per-order, tax-excluded policy is required', 409);
  if (!Array.isArray(lines) || !lines.length) throw invalid('Imported order components are required', 409);
  const ids = lines.map(line => Number(line.id)).sort((a, b) => a - b);
  const anchor = lines.find(line => Number(line.id) === ids[0]);
  const currency = String(anchor.currency || 'USD').toUpperCase();
  const day = isoDay(anchor.statement_date);
  const orderId = String(anchor.provenance?.orderId ?? '').trim();
  const base = { method: 'per-order-fee-tax-excluded-v1', policyId: policy.id, policyVersion: policy.version,
    policyQuote: policy.source_quote, orderId, componentLineIds: ids,
    components: lines.map(line => ({ lineId: line.id, sourceFile: line.source_file, lineNumber: line.line_number,
      checksum: line.checksum, componentId: line.provenance?.componentId,
      componentType: line.provenance?.componentType, amount: line.amount, currency: line.currency })),
    settlementDate: day, settlementCurrency: currency,
    scope: 'Candidate from imported settlement components and an independently approved operator-supplied policy; marketplace API, claim acceptance and payout unverified' };
  let observedNative = 0n, taxNative = 0n;
  for (const line of lines) {
    if (Number(line.amount) < 0) throw invalid('Credit lines cannot be assessed as order fees', 409);
    const type = policyKey(line.provenance?.componentType).toUpperCase();
    const value = BigInt(amount(line.amount, 'Imported order component'));
    if (type === 'FEE') observedNative += value;
    if (type === 'TAX') taxNative += value;
  }
  const observed = safe(observedNative), tax = safe(taxNative);
  const insufficient = reason => ({ anchorLineId: ids[0], componentLineIds: ids, orderId: orderId || null,
    settlementCurrency: currency, fxRateId: fxRate?.id ?? null, observedCents: observed,
    taxNativeCents: tax, grossNativeCents: null, expectedCents: null, varianceCents: null,
    status: 'INSUFFICIENT', calculation: { ...base, reason, observedNativeCents: observed, taxNativeCents: tax } });
  if (!orderId) return insufficient('order_id is missing from imported settlement components');
  if (lines.some(line => String(line.provenance?.orderId ?? '').trim() !== orderId)) return insufficient('Order IDs conflict');
  if (lines.some(line => policyKey(line.provenance?.feeType) !== policy.fee_type_key)) return insufficient('Fee types conflict within order');
  if (lines.some(line => String(line.currency || '').toUpperCase() !== currency)) return insufficient('Settlement components use mixed currencies');
  if (!validDay(day) || day < isoDay(policy.effective_on) || day > isoDay(policy.expires_on) ||
      lines.some(line => isoDay(line.statement_date) !== day)) return insufficient('Settlement component dates conflict or fall outside policy window');
  const componentIds = lines.map(line => String(line.provenance?.componentId ?? '').trim());
  if (componentIds.some(value => !value) || new Set(componentIds).size !== componentIds.length)
    return insufficient('Every fee and tax component needs a distinct imported component_id');
  const types = lines.map(line => policyKey(line.provenance?.componentType).toUpperCase());
  if (types.some(type => !['FEE', 'TAX'].includes(type)) || !types.includes('FEE'))
    return insufficient('Every component needs a fee or tax type, including at least one fee');
  if (!types.includes('TAX')) return insufficient('An explicit tax component is required, including a zero tax line when appropriate');
  const grossValues = new Set();
  for (const line of lines) {
    const raw = line.provenance?.grossAmount;
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') grossValues.add(amount(raw, 'Imported order gross'));
  }
  if (grossValues.size !== 1) return insufficient('Order gross amount is missing or conflicts across components');
  const grossNative = [...grossValues][0];
  if (currency !== 'USD' && (!fxRate || fxRate.status !== 'APPROVED' || fxRate.from_currency !== currency ||
      fxRate.to_currency !== 'USD' || isoDay(fxRate.rate_date) !== day))
    return insufficient('No independently approved, exact-date source-cited FX rate converts this order to USD');
  const rateUnits = currency === 'USD' ? 1000000 : Number(fxRate.rate_units);
  const observedUsd = converted(observed, rateUnits);
  const grossUsd = converted(grossNative, rateUnits);
  const variable = safe((BigInt(grossUsd) * BigInt(policy.percent_units) + 500000n) / 1000000n);
  const expected = safe(BigInt(variable) + BigInt(policy.fixed_fee_cents));
  const variance = observedUsd - expected;
  return { anchorLineId: ids[0], componentLineIds: ids, orderId, settlementCurrency: currency,
    fxRateId: currency === 'USD' ? null : fxRate.id, observedCents: observedUsd,
    taxNativeCents: tax, grossNativeCents: grossNative, expectedCents: expected, varianceCents: variance,
    status: variance > 0 ? 'CANDIDATE' : 'NO_VARIANCE', calculation: { ...base,
      observedNativeCents: observed, taxNativeCents: tax, grossNativeCents: grossNative,
      conversionRateUnits: rateUnits, conversionRateId: currency === 'USD' ? null : fxRate.id,
      conversionRateDate: currency === 'USD' ? null : day, conversionRateVersion: currency === 'USD' ? null : fxRate.version,
      conversionSourceId: currency === 'USD' ? null : fxRate.source_id,
      conversionSourceHash: currency === 'USD' ? null : fxRate.source_hash,
      conversionSourceQuote: currency === 'USD' ? null : fxRate.source_quote,
      observedUsdCents: observedUsd, grossUsdCents: grossUsd, variableUsdCents: variable,
      fixedUsdCents: policy.fixed_fee_cents, expectedUsdCents: expected, signedVarianceUsdCents: variance,
      taxTreatment: 'Excluded from both observed fee and policy cap; retained separately in native currency' } };
}

export function assessFeeLine(policy, line) {
  if (policyKey(line.provenance?.feeType) !== policy.fee_type_key)
    throw invalid('Settlement fee type does not match the approved policy', 409);
  const date = String(line.statement_date ?? '');
  if (!validDay(date) || date < isoDay(policy.effective_on) || date > isoDay(policy.expires_on))
    throw invalid('Settlement line is outside the approved policy date window', 409);
  if (Number(line.amount) < 0) throw invalid('A credit line is not a fee exception candidate', 409);
  const observed = amount(line.amount, 'Settlement fee charged');
  if (line.currency !== 'USD') return { observedCents: observed, expectedCents: null, varianceCents: null, status: 'INSUFFICIENT',
    calculation: { reason: 'Per-line policy has no approved FX conversion method for this currency',
      policyId: policy.id, policyVersion: policy.version, settlementDate: date } };
  const grossRaw = line.provenance?.grossAmount;
  if (grossRaw === undefined || grossRaw === null || String(grossRaw).trim() === '')
    return { observedCents: observed, expectedCents: null, varianceCents: null, status: 'INSUFFICIENT',
      calculation: { reason: 'Sale gross amount missing from imported settlement line', policyId: policy.id,
        policyVersion: policy.version, feeType: policy.fee_type_key, settlementDate: date } };
  const grossCents = amount(grossRaw, 'Sale gross amount');
  const variableCents = Number((BigInt(grossCents) * BigInt(policy.percent_units) + 500000n) / 1000000n);
  const expectedCents = variableCents + Number(policy.fixed_fee_cents);
  if (!Number.isSafeInteger(expectedCents)) throw invalid('Calculated marketplace fee exceeds supported precision');
  const varianceCents = observed - expectedCents;
  return {
    observedCents: observed, expectedCents, varianceCents,
    status: varianceCents > 0 ? 'CANDIDATE' : 'NO_VARIANCE',
    calculation: {
      method: 'gross-times-policy-percent-plus-fixed-fee-v1', policyId: policy.id, policyVersion: policy.version,
      feeType: policy.fee_type_key, settlementDate: date, statementChecksum: line.checksum,
      statementLine: line.line_number, grossCents, percentUnits: policy.percent_units,
      variableCents, fixedFeeCents: policy.fixed_fee_cents, observedCents: observed,
      expectedCents, signedVarianceCents: varianceCents,
      scope: 'Candidate fee exception from an imported settlement line and human-approved operator-supplied policy; no marketplace claim acceptance or payout verified',
    },
  };
}
