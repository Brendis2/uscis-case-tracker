const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeReceiptNumber, parseCaseStatus, upstreamError } = require('../.test-build/case-utils.js');

test('normalizes a valid receipt number', () => {
  assert.equal(normalizeReceiptNumber('  ioe0123456789 '), 'IOE0123456789');
});

test('rejects receipt numbers with invalid length or characters', () => {
  for (const receipt of ['', 'IOE123', 'IOE012345678X', '12E0123456789', null, 123]) {
    assert.equal(normalizeReceiptNumber(receipt), null);
  }
});

test('parses the documented nested USCIS response', () => {
  assert.deepEqual(parseCaseStatus({
    case_status: {
      formType: 'I-130',
      current_case_status_text_en: 'Case Was Received',
      current_case_status_desc_en: 'We received your case.'
    }
  }), {
    formType: 'I-130',
    status: 'Case Was Received',
    description: 'We received your case.',
    isDemo: false
  });
});

test('parses the flat response fallback and marks demo data', () => {
  assert.deepEqual(parseCaseStatus({
    demo: true,
    status: 'Pending',
    status_description: 'Sample only',
    form_type: 'I-765'
  }), {
    formType: 'I-765', status: 'Pending', description: 'Sample only', isDemo: true
  });
});

test('provides a safe fallback for an unexpected response shape', () => {
  assert.deepEqual(parseCaseStatus(null), {
    formType: null, status: 'Status unavailable', description: null, isDemo: false
  });
});

test('maps authorization, invalid receipt, outage, and unknown upstream errors', () => {
  assert.equal(upstreamError(403).httpStatus, 502);
  assert.match(upstreamError(403).message, /denied this app/);
  assert.equal(upstreamError(400).httpStatus, 400);
  assert.equal(upstreamError(503).httpStatus, 503);
  assert.match(upstreamError(503).message, /temporarily unavailable/);
  assert.equal(upstreamError(500).httpStatus, 502);
});
