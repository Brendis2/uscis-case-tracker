import { NextResponse } from 'next/server';
import { normalizeReceiptNumber, upstreamError } from '../../../lib/case-utils';

export async function POST(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 }); }
  const receiptNumber = normalizeReceiptNumber((body as { receiptNumber?: unknown } | null)?.receiptNumber);
  if (!receiptNumber) {
    return NextResponse.json({ error: 'Enter a receipt number with three letters and ten digits.' }, { status: 400 });
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: 'Authentication is not configured.' }, { status: 503 });
  let identity: Response;
  try {
    identity = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseKey, Authorization: authorization }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  } catch {
    return NextResponse.json({ error: 'Could not verify your session. Please retry.' }, { status: 503 });
  }
  if (!identity.ok) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 });
  if (process.env.NODE_ENV === 'development' && process.env.USCIS_DEMO_MODE === 'true') {
    if (receiptNumber !== 'EAC9999103402') {
      return NextResponse.json({ error: 'Demo mode only supports the sample receipt EAC9999103402.' }, { status: 404 });
    }
    return NextResponse.json({
      demo: true,
      case_status: {
        receiptNumber, formType: 'I-130', submittedDate: '2023-09-05', modifiedDate: '2023-09-05',
        current_case_status_text_en: 'Case Was Received',
        current_case_status_desc_en: 'DEMO DATA: USCIS received this sample case. This simulated status is for a local walkthrough and is not a live case result.',
        hist_case_status: null
      },
      message: 'DEMO DATA - no USCIS request was made.'
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const clientId = process.env.USCIS_CLIENT_ID;
  const clientSecret = process.env.USCIS_CLIENT_SECRET;
  const tokenUrl = process.env.USCIS_TOKEN_URL || 'https://api-int.uscis.gov/oauth/accesstoken';
  const caseUrl = process.env.USCIS_CASE_STATUS_URL || 'https://api-int.uscis.gov/case-status';
  if (!clientId || !clientSecret) return NextResponse.json({ error: 'USCIS API is not configured. Add your sandbox client ID and secret.' }, { status: 503 });
  try {
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      cache: 'no-store', signal: AbortSignal.timeout(10_000)
    });
    if (!tokenResponse.ok) return NextResponse.json({ error: `USCIS authentication failed (HTTP ${tokenResponse.status}). Check sandbox credentials and app access.` }, { status: 502 });
    const token = await tokenResponse.json();
    if (typeof token.access_token !== 'string' || !token.access_token) return NextResponse.json({ error: 'USCIS authentication response did not include an access token.' }, { status: 502 });
    const response = await fetch(`${caseUrl.replace(/\/$/, '')}/${encodeURIComponent(receiptNumber.trim().toUpperCase())}`, {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
      cache: 'no-store', signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 404) return NextResponse.json({ error: 'No case found for this receipt number.' }, { status: 404 });
    if (response.status === 429) return NextResponse.json({ error: 'USCIS rate limit reached. Please try again later.' }, { status: 429 });
    if (!response.ok) {
      const mapped = upstreamError(response.status);
      return NextResponse.json({ error: mapped.message }, { status: mapped.httpStatus });
    }
    return NextResponse.json(await response.json(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'USCIS request timed out or could not connect.' }, { status: 504 });
  }
}
