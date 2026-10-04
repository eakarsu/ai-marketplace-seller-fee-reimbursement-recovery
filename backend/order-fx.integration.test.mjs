import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

test('two customers keep split-order fee, tax, FX, claim and credit evidence isolated', {
  skip: !process.env.RECOVERY_INTEGRATION_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.RECOVERY_INTEGRATION_DATABASE_URL;
  process.env.APP_TEST_NO_LISTEN = 'true';
  const { app, pool } = await import('./server.mjs');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, token, body, method = 'GET') {
    const response = await fetch(base + path, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  const post = (path, token, body) => request(path, token, body, 'POST');
  const marketplace = 'GlobalMart US';
  const policyQuote = 'Referral fee is 15% of gross sale plus $0.30 per order, tax excluded, from 2026-01-01 through 2026-12-31.';
  const fxQuote = 'Published conversion: 1 EUR = 1.10 USD on 2026-07-18.';
  const fxQuoteV2 = 'Revised conversion: 1 EUR = 1.20 USD on 2026-07-18.';
  try {
    const password = `Test-${randomUUID()}`;
    const reference = `CASE-${randomUUID()}`;
    const accounts = [];
    for (const label of ['A', 'B']) {
      const account = { id: randomUUID(), email: `${label}-${randomUUID()}@example.test`,
        reviewerEmail: `${label}-review-${randomUUID()}@example.test` };
      await pool.query('INSERT INTO customer_accounts(id,name) VALUES($1,$2)', [account.id, `Order test ${label}`]);
      for (const [email, role] of [[account.email, 'admin'], [account.reviewerEmail, 'reviewer']])
        await pool.query('INSERT INTO app_users(account_id,email,password_hash,name,role) VALUES($1,$2,$3,$4,$5)',
          [account.id, email, await bcrypt.hash(password, 4), email, role]);
      await pool.query(`INSERT INTO feature_records(account_id,feature_id,reference,title,status,owner,risk,due_date,amount,payload)
        VALUES($1,'order-and-settlement-ingestion',$2,'Split settlement','Open',$3,'Not assessed',current_date+30,18,$4)`,
      [account.id, reference, account.email, { marketplace, eligibleAmount: 15.30 }]);
      account.admin = (await post('/api/auth/login', null, { email: account.email, password })).data.token;
      account.reviewer = (await post('/api/auth/login', null, { email: account.reviewerEmail, password })).data.token;
      assert.ok(account.admin && account.reviewer);
      accounts.push(account);
    }
    const [a, b] = accounts;
    for (const account of accounts) {
      const sourceText = `Section 4.2. ${policyQuote}\n`;
      const source = await post('/api/marketplace/sources', account.admin,
        { title: 'Per-order fee schedule', content: sourceText });
      assert.equal(source.status, 201);
      assert.equal(source.data.source.content_hash, createHash('sha256').update(sourceText).digest('hex'));
      account.policySourceId = source.data.source.id;
      const input = { marketplace, feeType: 'Referral fee', effectiveOn: '2026-01-01', expiresOn: '2026-12-31',
        percent: '15', fixedFeeAmount: '0.30', feeBasis: 'PER_ORDER', sourceId: account.policySourceId,
        sourceQuote: policyQuote, clauseLocator: '§4.2' };
      assert.equal((await post('/api/marketplace/policies', account.admin,
        { ...input, sourceQuote: policyQuote.replace('tax excluded', 'tax included') })).status, 422);
      const drafted = await post('/api/marketplace/policies', account.admin, input);
      assert.equal(drafted.status, 201, JSON.stringify(drafted.data));
      assert.equal(drafted.data.policy.fee_basis, 'PER_ORDER');
      account.policyId = drafted.data.policy.id;
      assert.equal((await post(`/api/marketplace/policies/${account.policyId}/approve`, account.admin,
        { rationale: 'I checked the source quote and component treatment.' })).status, 403);
      assert.equal((await post(`/api/marketplace/policies/${account.policyId}/approve`, account.reviewer,
        { rationale: 'I independently checked the exact policy quote and tax treatment.' })).status, 200);
    }
    assert.equal((await request(`/api/marketplace/sources/${b.policySourceId}`, a.admin)).status, 404);
    const usd = `reference,description,order_id,component_id,component_type,fee_type,gross_amount,amount,date,currency\n` +
      `${reference},First fee,ORDER-USD,F-1,FEE,Referral fee,100.00,10.00,2026-07-18,USD\n` +
      `${reference},Second fee,ORDER-USD,F-2,FEE,Referral fee,100.0,8.00,2026-07-18,USD\n` +
      `${reference},Fee tax,ORDER-USD,T-1,TAX,Referral fee,,1.44,2026-07-18,USD\n`;
    const ingests = [];
    for (const account of accounts) {
      const ingest = await post('/api/features/order-and-settlement-ingestion/ingest', account.admin,
        { text: usd, sourceFile: 'split-order-usd.csv' });
      assert.equal(ingest.status, 201);
      ingests.push(ingest.data);
      assert.equal((await post(`/api/marketplace/policies/${account.policyId}/assess`, account.admin, {})).data.newAssessments, 1);
      const assessed = (await request(`/api/marketplace/policies/${account.policyId}/assessments`, account.admin)).data.items[0];
      assert.equal(assessed.status, 'CANDIDATE');
      assert.equal(Number(assessed.observed_cents), 1800);
      assert.equal(Number(assessed.expected_cents), 1530);
      assert.equal(Number(assessed.tax_native_cents), 144);
      assert.equal(Number(assessed.variance_cents), 270);
      assert.equal(assessed.component_line_ids.length, 3);
    }
    assert.equal(ingests[0].checksum, ingests[1].checksum);
    const candidatesA = (await request('/api/claims/candidates', a.admin)).data.items;
    const candidatesB = (await request('/api/claims/candidates', b.admin)).data.items;
    assert.equal(candidatesA.length, 1); assert.equal(candidatesB.length, 1);
    assert.equal(candidatesA[0].order_id, 'ORDER-USD');
    assert.equal(Number(candidatesA[0].delta), 2.7);
    assert.equal((await request('/api/dashboard', a.admin)).data.totals.confirmed_recovery, 2.7);
    assert.equal((await post('/api/claims', a.admin,
      { statementLineId: candidatesB[0].id, marketplaceOrderAssessmentId: candidatesB[0].marketplace_order_assessment_id })).status, 409);
    const claimedUsd = await post('/api/claims', a.admin,
      { statementLineId: candidatesA[0].id, marketplaceOrderAssessmentId: candidatesA[0].marketplace_order_assessment_id });
    assert.equal(claimedUsd.status, 201, JSON.stringify(claimedUsd.data));
    assert.equal(Number(claimedUsd.data.claim.requested_cents), 270);

    const eurFees = `reference,description,order_id,component_id,component_type,fee_type,gross_amount,amount,date,currency\n` +
      `${reference},First euro fee,ORDER-EUR,E-F1,FEE,Referral fee,100.00,10.00,2026-07-18,EUR\n` +
      `${reference},Second euro fee,ORDER-EUR,E-F2,FEE,Referral fee,100.00,8.00,2026-07-18,EUR\n`;
    assert.equal((await post('/api/features/order-and-settlement-ingestion/ingest', a.admin,
      { text: eurFees, sourceFile: 'euro-fees.csv' })).status, 201);
    assert.equal((await post(`/api/marketplace/policies/${a.policyId}/assess`, a.admin, {})).data.newAssessments, 1);
    let euroAssessment = (await request(`/api/marketplace/policies/${a.policyId}/assessments`, a.admin)).data.items.find(item => item.order_id === 'ORDER-EUR');
    assert.equal(euroAssessment.status, 'INSUFFICIENT');
    assert.match(euroAssessment.calculation.reason, /tax component/);
    assert.equal((await request('/api/claims/candidates', a.admin)).data.items.length, 0);
    const euroTax = `reference,description,order_id,component_id,component_type,fee_type,gross_amount,amount,date,currency\n` +
      `${reference},Euro fee tax,ORDER-EUR,E-T1,TAX,Referral fee,,2.00,2026-07-18,EUR\n`;
    assert.equal((await post('/api/features/order-and-settlement-ingestion/ingest', a.admin,
      { text: euroTax, sourceFile: 'euro-tax.csv' })).status, 201);
    assert.equal((await post(`/api/marketplace/policies/${a.policyId}/assess`, a.admin, {})).data.newAssessments, 1);
    euroAssessment = (await request(`/api/marketplace/policies/${a.policyId}/assessments`, a.admin)).data.items.find(item => item.order_id === 'ORDER-EUR');
    assert.equal(euroAssessment.status, 'INSUFFICIENT');
    assert.match(euroAssessment.calculation.reason, /FX rate/);
    assert.equal((await request('/api/claims/candidates', a.admin)).data.items.length, 0);

    const fxSource = await post('/api/marketplace/sources', a.admin,
      { title: 'Dated FX quotation', content: `Rate bulletin. ${fxQuote}\n${fxQuoteV2}\n` });
    assert.equal(fxSource.status, 201);
    assert.equal((await post('/api/marketplace/fx-rates', a.admin,
      { fromCurrency: 'EUR', rateDate: '2026-07-18', rate: '1.10', sourceId: b.policySourceId,
        sourceQuote: fxQuote, clauseLocator: 'Rate bulletin row 1' })).status, 409);
    assert.equal((await post('/api/marketplace/fx-rates', a.admin,
      { fromCurrency: 'EUR', rateDate: '2026-07-18', rate: '1.11', sourceId: fxSource.data.source.id,
        sourceQuote: fxQuote, clauseLocator: 'Rate bulletin row 1' })).status, 422);
    const rateA = await post('/api/marketplace/fx-rates', a.admin,
      { fromCurrency: 'EUR', rateDate: '2026-07-18', rate: '1.10', sourceId: fxSource.data.source.id,
        sourceQuote: fxQuote, clauseLocator: 'Rate bulletin row 1' });
    assert.equal(rateA.status, 201, JSON.stringify(rateA.data));
    assert.equal((await post(`/api/marketplace/fx-rates/${rateA.data.rate.id}/approve`, a.admin,
      { rationale: 'I read the source quote and conversion date.' })).status, 403);
    assert.equal((await post(`/api/marketplace/fx-rates/${rateA.data.rate.id}/approve`, a.reviewer,
      { rationale: 'I independently checked the exact FX quote and conversion date.' })).status, 200);
    assert.equal((await post(`/api/marketplace/policies/${a.policyId}/assess`, a.admin, {})).data.newAssessments, 1);
    let euroCandidate = (await request('/api/claims/candidates', a.admin)).data.items.find(item => item.order_id === 'ORDER-EUR');
    assert.equal(Number(euroCandidate.delta), 3);
    assert.equal(euroCandidate.source_currency, 'EUR');
    assert.equal(euroCandidate.calculation.conversionRateVersion, 1);
    assert.equal((await request('/api/claims/candidates', b.admin)).data.items.length, 1,
      'the other customer must not inherit this FX rate');

    const rateV2 = await post('/api/marketplace/fx-rates', a.admin,
      { fromCurrency: 'EUR', rateDate: '2026-07-18', rate: '1.20', sourceId: fxSource.data.source.id,
        sourceQuote: fxQuoteV2, clauseLocator: 'Rate bulletin row 2' });
    assert.equal(rateV2.status, 201);
    assert.equal(rateV2.data.rate.version, 2);
    assert.equal((await post(`/api/marketplace/fx-rates/${rateV2.data.rate.id}/approve`, a.reviewer,
      { rationale: 'I independently checked the corrected rate for the exact date.' })).status, 200);
    assert.equal((await request('/api/claims/candidates', a.admin)).data.items.some(item => item.order_id === 'ORDER-EUR'), false,
      'superseded FX evidence must not support a current claim');
    assert.equal((await post('/api/claims', a.admin,
      { statementLineId: euroCandidate.id, marketplaceOrderAssessmentId: euroCandidate.marketplace_order_assessment_id })).status, 409);
    assert.equal((await post(`/api/marketplace/policies/${a.policyId}/assess`, a.admin, {})).data.newAssessments, 1);
    euroCandidate = (await request('/api/claims/candidates', a.admin)).data.items.find(item => item.order_id === 'ORDER-EUR');
    assert.equal(Number(euroCandidate.delta), 3.3);
    assert.equal(euroCandidate.calculation.conversionRateVersion, 2);
    const euroClaim = await post('/api/claims', a.admin,
      { statementLineId: euroCandidate.id, marketplaceOrderAssessmentId: euroCandidate.marketplace_order_assessment_id });
    assert.equal(euroClaim.status, 201, JSON.stringify(euroClaim.data));
    assert.equal(Number(euroClaim.data.claim.requested_cents), 330);
    assert.equal((await request('/api/dashboard', a.admin)).data.totals.confirmed_recovery, 6);
    assert.equal((await request('/api/dashboard', b.admin)).data.totals.confirmed_recovery, 2.7);
    assert.equal((await request(`/api/claims/${euroClaim.data.claim.id}`, b.admin)).status, 404);

    const claimPath = `/api/claims/${euroClaim.data.claim.id}`;
    assert.equal((await post(`${claimPath}/events`, a.admin,
      { eventType: 'SUBMITTED', externalReference: 'PORTAL-ORDER-123', evidenceText: 'Staff copied a portal entry; marketplace submission is not independently verified.' })).status, 200);
    assert.equal((await post(`${claimPath}/events`, a.reviewer,
      { eventType: 'ACKNOWLEDGED', externalReference: 'ACK-ORDER-123', evidenceText: 'Staff copied correspondence; marketplace acknowledgement is unverified.' })).status, 200);
    const creditText = `reference,description,order_id,component_id,component_type,fee_type,amount,date,currency\n` +
      `${reference},Wrong euro credit,ORDER-EUR,C-1,FEE,Referral fee,-3.30,2026-07-25,EUR\n` +
      `${reference},Wrong tax credit,ORDER-EUR,C-2,TAX,Referral fee,-3.30,2026-07-25,USD\n` +
      `${reference},Fee credit,ORDER-EUR,C-3,FEE,Referral fee,-3.30,2026-07-25,USD\n`;
    const creditIngest = await post('/api/features/order-and-settlement-ingestion/ingest', a.admin,
      { text: creditText, sourceFile: 'order-credit.csv' });
    assert.equal(creditIngest.status, 201);
    const allCredits = (await request(`/api/statement-ingests/${creditIngest.data.ingestId}`, a.admin)).data.lines;
    const right = allCredits.find(item => item.provenance.componentId === 'C-3');
    const wrong = allCredits.find(item => item.provenance.componentId === 'C-1');
    const creditCandidates = (await request(`/api/claims/credit-lines?claimId=${euroClaim.data.claim.id}`, a.admin)).data.items;
    assert.deepEqual(creditCandidates.map(item => item.id), [right.id]);
    assert.equal((await post(`${claimPath}/credits`, a.admin,
      { creditLineId: wrong.id, issuerReference: 'CREDIT-WRONG' })).status, 409);
    const credited = await post(`${claimPath}/credits`, a.admin,
      { creditLineId: right.id, issuerReference: 'CREDIT-ORDER-123' });
    assert.equal(credited.status, 200);
    assert.equal(credited.data.claim.status, 'CREDIT_EVIDENCED');
    const badDate = `reference,description,order_id,component_id,component_type,fee_type,gross_amount,amount,date,currency\n` +
      `${reference},Bad date fee,ORDER-BAD,B-F1,FEE,Referral fee,100.00,18.00,2026-99-99,EUR\n` +
      `${reference},Bad date tax,ORDER-BAD,B-T1,TAX,Referral fee,,1.44,2026-99-99,EUR\n`;
    assert.equal((await post('/api/features/order-and-settlement-ingestion/ingest', a.admin,
      { text: badDate, sourceFile: 'bad-date.csv' })).status, 201);
    const badAssessmentRun = await post(`/api/marketplace/policies/${a.policyId}/assess`, a.admin, {});
    assert.equal(badAssessmentRun.status, 200);
    assert.equal((await request(`/api/marketplace/policies/${a.policyId}/assessments`, a.admin)).data.items
      .find(item => item.order_id === 'ORDER-BAD').status, 'INSUFFICIENT');

    const lineQuote = 'Referral fee is 15% of gross sale plus $0.30 per fee line from 2026-01-01 through 2026-12-31.';
    const lineSource = await post('/api/marketplace/sources', a.admin,
      { title: 'Later per-line fee schedule', content: `Section 5. ${lineQuote}` });
    assert.equal(lineSource.status, 201);
    const linePolicy = await post('/api/marketplace/policies', a.admin,
      { marketplace, feeType: 'Referral fee', effectiveOn: '2026-01-01', expiresOn: '2026-12-31',
        percent: '15', fixedFeeAmount: '0.30', feeBasis: 'PER_LINE', sourceId: lineSource.data.source.id,
        sourceQuote: lineQuote, clauseLocator: '§5' });
    assert.equal(linePolicy.status, 201);
    assert.equal((await post(`/api/marketplace/policies/${linePolicy.data.policy.id}/approve`, a.reviewer,
      { rationale: 'I independently checked the newer per-line fee schedule.' })).status, 200);
    assert.equal((await post(`/api/marketplace/policies/${linePolicy.data.policy.id}/assess`, a.admin, {})).status, 200);
    const lineAssessments = (await request(`/api/marketplace/policies/${linePolicy.data.policy.id}/assessments`, a.admin)).data.items;
    assert.equal(lineAssessments.some(item => item.description === 'Fee tax'), false,
      'explicit tax components must never be assessed as fee lines');
    const secondUsdFee = lineAssessments.find(item => item.description === 'Second fee');
    assert.ok(secondUsdFee);
    assert.equal((await request('/api/claims/candidates', a.admin)).data.items.length, 0,
      'a later per-line policy cannot claim a fee component already covered by an order claim');
    assert.equal((await post('/api/claims', a.admin,
      { statementLineId: secondUsdFee.statement_line_id, marketplaceAssessmentId: secondUsdFee.id })).status, 409);
    assert.equal((await request('/api/dashboard', a.admin)).data.totals.confirmed_recovery, 0,
      'overlapping assessed components must not be counted again');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
