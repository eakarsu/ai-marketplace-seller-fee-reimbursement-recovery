import React, { useEffect, useState } from 'react';

const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100);
const nativeMoney = (cents, currency) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(Number(cents || 0) / 100); } catch { return `${(Number(cents || 0) / 100).toFixed(2)} ${currency || 'USD'}`; } };
export default function FeePolicies({ request, notify, user, onSaved }) {
  const [cases, setCases] = useState([]);
  const [sources, setSources] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [fxRates, setFxRates] = useState([]);
  const [selectedFx, setSelectedFx] = useState(null);
  const [fxRationale, setFxRationale] = useState('');
  const [selectedSource, setSelectedSource] = useState(null);
  const [selectedPolicy, setSelectedPolicy] = useState(null);
  const [assessments, setAssessments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rationale, setRationale] = useState('');
  const [sourceForm, setSourceForm] = useState({ title: '', content: '' });
  const [fxForm, setFxForm] = useState({ fromCurrency: 'EUR', rateDate: '', rate: '', sourceId: '', sourceQuote: '', clauseLocator: '' });
  const [form, setForm] = useState({ marketplace: '', feeType: '', effectiveOn: '2026-01-01', expiresOn: '2026-12-31',
    percent: '', fixedFeeAmount: '0.00', feeBasis: 'PER_LINE', sourceId: '', sourceQuote: '', clauseLocator: '' });
  async function load() {
    const [caseData, sourceData, policyData, fxData] = await Promise.all([
      request('/api/marketplace/cases'), request('/api/marketplace/sources'), request('/api/marketplace/policies'), request('/api/marketplace/fx-rates'),
    ]);
    setCases(caseData.items || []); setSources(sourceData.items || []); setPolicies(policyData.items || []); setFxRates(fxData.items || []);
  }
  useEffect(() => { load().catch(err => setError(err.message)); }, []);
  async function act(work) {
    setBusy(true); setError('');
    try { await work(); await load(); await onSaved(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function viewSource(sourceId) {
    setBusy(true); setError('');
    try { setSelectedSource((await request(`/api/marketplace/sources/${sourceId}`)).source); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function viewPolicy(policy) {
    setSelectedPolicy(policy); setError('');
    try { setAssessments((await request(`/api/marketplace/policies/${policy.id}/assessments`)).items || []); }
    catch (err) { setError(err.message); }
  }
  const marketplaces = [...new Set(cases.map(item => item.marketplace).filter(Boolean))];
  const canDraft = ['admin', 'operator'].includes(user.role);
  const canReview = ['admin', 'reviewer'].includes(user.role);
  return <>
    <header className="pageTitle"><div><span className="eyebrow">Marketplace settlement evidence</span><h2>Fee policies and conversion rates</h2><p>Save exact source text, approve a dated fee rule, and assess imported settlement components. Per-order assessments keep tax separate and require a reviewed exact-date FX quote for non-USD settlements. No marketplace payout is verified.</p></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel"><h3>1. Save policy or FX source text</h3><p>Paste extracted marketplace policy, fee schedule, or conversion bulletin text. Its saved content and SHA-256 hash are immutable; independently check the original document before approval.</p>
      <form onSubmit={event => { event.preventDefault(); act(async () => { await request('/api/marketplace/sources', { method: 'POST', body: JSON.stringify(sourceForm) }); setSourceForm({ title: '', content: '' }); notify('Fee policy source text saved.'); }); }}>
        <label>Source document title<input required minLength={3} maxLength={200} value={sourceForm.title} onChange={event => setSourceForm({ ...sourceForm, title: event.target.value })}/></label>
        <label>Extracted source text<textarea required minLength={30} maxLength={500000} rows={7} value={sourceForm.content} onChange={event => setSourceForm({ ...sourceForm, content: event.target.value })}/></label>
        <button className="primary" disabled={busy || !canDraft}>Save source</button>
      </form>
      {sources.length > 0 && <div className="tableWrap"><table><thead><tr><th>Source</th><th>SHA-256</th></tr></thead><tbody>{sources.map(source => <tr key={source.id}><td><button className="secondary" onClick={() => viewSource(source.id)}>{source.title}</button></td><td><code>{source.content_hash.slice(0, 20)}…</code></td></tr>)}</tbody></table></div>}
      {selectedSource && <details open><summary>{selectedSource.title} · saved source text</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{selectedSource.content}</pre></details>}
    </section>
    <section className="panel"><h3>2. Draft a dated fee policy</h3><p>Select a marketplace with a real Order and Settlement Ingestion case. The fee type must match settlement rows. Per-order rules apply the fixed fee once to all fee components in an order, exclude explicit tax components, and use gross sale once even when repeated on split rows.</p>
      {marketplaces.length === 0 && <p>Create a real Order and Settlement Ingestion case before drafting a policy. Example cases cannot support claims.</p>}
      <form onSubmit={event => { event.preventDefault(); act(async () => { const data = await request('/api/marketplace/policies', { method: 'POST', body: JSON.stringify(form) }); notify(`Fee policy version ${data.policy.version} drafted for independent review.`); }); }}>
        <div className="formGrid">
          <label>Marketplace account<select required value={form.marketplace} onChange={event => setForm({ ...form, marketplace: event.target.value })}><option value="">Select marketplace</option>{marketplaces.map(name => <option key={name}>{name}</option>)}</select></label>
          <label>Exact settlement fee type<input required minLength={2} maxLength={200} placeholder="Referral fee" value={form.feeType} onChange={event => setForm({ ...form, feeType: event.target.value })}/></label>
          <label>Effective date<input required type="date" value={form.effectiveOn} onChange={event => setForm({ ...form, effectiveOn: event.target.value })}/></label>
          <label>Expiry date<input required type="date" value={form.expiresOn} onChange={event => setForm({ ...form, expiresOn: event.target.value })}/></label>
          <label>Percentage of gross sale<input required type="number" min={0} max={100} step="0.0001" value={form.percent} onChange={event => setForm({ ...form, percent: event.target.value })}/></label>
          <label>Fee basis<select value={form.feeBasis} onChange={event => setForm({ ...form, feeBasis: event.target.value })}><option value="PER_LINE">Per settlement line</option><option value="PER_ORDER">Per order · tax excluded</option></select></label>
          <label>Fixed fee {form.feeBasis === 'PER_ORDER' ? 'per order' : 'per settlement line'}<input required type="number" min={0} step="0.01" value={form.fixedFeeAmount} onChange={event => setForm({ ...form, fixedFeeAmount: event.target.value })}/></label>
          <label>Saved policy source<select required value={form.sourceId} onChange={event => setForm({ ...form, sourceId: event.target.value })}><option value="">Choose source</option>{sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label>
          <label>Policy section or page<input required minLength={2} maxLength={200} value={form.clauseLocator} onChange={event => setForm({ ...form, clauseLocator: event.target.value })}/></label>
        </div>
        <label>Exact policy quote containing the percentage and any nonzero fixed fee<textarea required minLength={12} maxLength={5000} rows={3} value={form.sourceQuote} onChange={event => setForm({ ...form, sourceQuote: event.target.value })}/></label>
        {form.feeBasis === 'PER_ORDER' && <p>The exact quote must state “per order,” “tax excluded,” and both policy dates. Each imported order needs <code>order_id</code>, distinct <code>component_id</code>, fee and tax <code>component_type</code> rows, and one consistent <code>gross_amount</code>.</p>}
        <button className="primary" disabled={busy || !canDraft || !marketplaces.length}>Save draft version</button>
      </form>
    </section>
    <section className="panel"><h3>3. Source-cited FX conversion</h3><p>For non-USD orders, save a quote such as “1 EUR = 1.10 USD on 2026-07-18” in a source above. The quote, date, rate, and source are reviewed by a different person. A missing or superseded FX rate leaves the order unresolved.</p>
      <form onSubmit={event => { event.preventDefault(); act(async () => { const result = await request('/api/marketplace/fx-rates', { method: 'POST', body: JSON.stringify(fxForm) }); notify(`FX quote version ${result.rate.version} drafted for independent review.`); }); }}>
        <div className="formGrid">
          <label>From currency<input required minLength={3} maxLength={3} value={fxForm.fromCurrency} onChange={event => setFxForm({ ...fxForm, fromCurrency: event.target.value.toUpperCase() })}/></label>
          <label>To currency<input value="USD" readOnly /></label>
          <label>Rate date<input required type="date" value={fxForm.rateDate} onChange={event => setFxForm({ ...fxForm, rateDate: event.target.value })}/></label>
          <label>USD per one source unit<input required type="number" min="0.000001" max="100" step="0.000001" value={fxForm.rate} onChange={event => setFxForm({ ...fxForm, rate: event.target.value })}/></label>
          <label>Saved FX source<select required value={fxForm.sourceId} onChange={event => setFxForm({ ...fxForm, sourceId: event.target.value })}><option value="">Choose source</option>{sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label>
          <label>Page or row locator<input required minLength={2} value={fxForm.clauseLocator} onChange={event => setFxForm({ ...fxForm, clauseLocator: event.target.value })}/></label>
        </div>
        <label>Exact FX source quote<textarea required minLength={15} value={fxForm.sourceQuote} onChange={event => setFxForm({ ...fxForm, sourceQuote: event.target.value })}/></label>
        <button className="primary" disabled={busy || !canDraft}>Save FX draft</button>
      </form>
      {fxRates.length > 0 && <div className="tableWrap"><table><thead><tr><th>Conversion</th><th>Date</th><th>Rate</th><th>Version</th><th>Status</th><th></th></tr></thead><tbody>{fxRates.map(rate => <tr key={rate.id}><td>{rate.from_currency} → USD</td><td>{String(rate.rate_date).slice(0, 10)}</td><td>{Number(rate.rate_units) / 1000000}</td><td>{rate.version}</td><td>{rate.status}</td><td><button className="secondary" type="button" onClick={() => setSelectedFx(rate)}>Inspect</button></td></tr>)}</tbody></table></div>}
      {selectedFx && <article><h4>FX quote {selectedFx.id} · version {selectedFx.version}</h4><p>{selectedFx.source_title}, {selectedFx.clause_locator} · SHA-256 <code>{selectedFx.source_hash}</code></p><blockquote>{selectedFx.source_quote}</blockquote><p>Operator-supplied source; origin and executed conversion are unverified.</p>
        {selectedFx.status === 'DRAFT' && <><label>Independent review rationale<textarea minLength={20} maxLength={2000} value={fxRationale} onChange={event => setFxRationale(event.target.value)}/></label><button className="primary" disabled={busy || !canReview || String(selectedFx.created_by_id) === String(user.id) || fxRationale.trim().length < 20} onClick={() => act(async () => { await request(`/api/marketplace/fx-rates/${selectedFx.id}/approve`, { method: 'POST', body: JSON.stringify({ rationale: fxRationale }) }); notify('FX quote independently approved.'); setSelectedFx(null); setFxRationale(''); })}>Approve FX version</button></>}
      </article>}
    </section>
    <section className="panel"><h3>4. Review and assess settlements</h3><p>A different administrator or reviewer approves each policy version. Assessments retain source hashes, policy version, component line checksums, and exact-cent arithmetic. Superseded versions remain visible.</p>
      {policies.length ? <div className="tableWrap"><table><thead><tr><th>Marketplace / fee</th><th>Dates</th><th>Rate</th><th>Basis</th><th>Version</th><th>Status</th><th></th></tr></thead><tbody>{policies.map(policy => <tr key={policy.id}><td>{policy.marketplace_label} · {policy.fee_type_label}</td><td>{String(policy.effective_on).slice(0, 10)} – {String(policy.expires_on).slice(0, 10)}</td><td>{Number(policy.percent_units) / 10000}% + {money(policy.fixed_fee_cents)}</td><td>{policy.fee_basis === 'PER_ORDER' ? 'Per order, tax excluded' : 'Per line'}</td><td>{policy.version}</td><td>{policy.status}</td><td><button className="secondary" disabled={busy} onClick={() => viewPolicy(policy)}>Inspect</button></td></tr>)}</tbody></table></div> : <p>No fee policies drafted.</p>}
      {selectedPolicy && <article className="panel"><h4>Policy {selectedPolicy.id} · version {selectedPolicy.version}</h4><p><strong>{selectedPolicy.status}</strong> · {selectedPolicy.marketplace_label} · {selectedPolicy.fee_type_label}</p><p>Source: {selectedPolicy.source_title} §{selectedPolicy.clause_locator} · SHA-256 <code>{selectedPolicy.source_hash}</code></p><blockquote>{selectedPolicy.source_quote}</blockquote>
        {selectedPolicy.status === 'DRAFT' && <div><label>Independent review rationale<textarea minLength={20} maxLength={2000} rows={3} value={rationale} onChange={event => setRationale(event.target.value)}/></label><button className="primary" disabled={busy || !canReview || String(selectedPolicy.created_by_id) === String(user.id) || rationale.trim().length < 20} onClick={() => act(async () => { await request(`/api/marketplace/policies/${selectedPolicy.id}/approve`, { method: 'POST', body: JSON.stringify({ rationale }) }); notify('Fee policy approved by an independent reviewer.'); setRationale(''); setSelectedPolicy(null); })}>Approve policy version</button></div>}
        {selectedPolicy.status === 'APPROVED' && <button className="primary" disabled={busy} onClick={() => act(async () => { const result = await request(`/api/marketplace/policies/${selectedPolicy.id}/assess`, { method: 'POST', body: '{}' }); notify(`${result.newAssessments} new settlement fee assessments saved.${result.hasMore ? ' Run again for remaining lines.' : ''}`); await viewPolicy(selectedPolicy); })}>Assess imported settlement lines</button>}
        {assessments.length > 0 && <div><h4>Latest 500 assessments</h4><div className="tableWrap"><table><thead><tr><th>Settlement evidence</th><th>Charged fee</th><th>Tax excluded</th><th>Expected</th><th>Signed variance</th><th>Status / reason</th></tr></thead><tbody>{assessments.map(item => <tr key={item.id}><td>{item.order_id ? <>Order {item.order_id} · {item.component_line_ids.length} components</> : `${item.source_file} #${item.line_number} · ${item.description}`}<details><summary>Calculation evidence</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(item.calculation, null, 2)}</pre></details></td><td>{item.status === 'INSUFFICIENT' && item.settlement_currency !== 'USD' ? nativeMoney(item.observed_cents, item.settlement_currency) : money(item.observed_cents)}</td><td>{item.tax_native_cents == null ? '—' : nativeMoney(item.tax_native_cents, item.settlement_currency)}</td><td>{item.expected_cents == null ? 'Unresolved' : money(item.expected_cents)}</td><td>{item.variance_cents == null ? '—' : money(item.variance_cents)}</td><td>{item.status}{item.calculation?.reason && <> · {item.calculation.reason}</>}</td></tr>)}</tbody></table></div></div>}
      </article>}
    </section>
  </>;
}
