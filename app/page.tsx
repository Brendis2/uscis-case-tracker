'use client';

import { FormEvent, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type CaseRow = { id: string; owner_id: string; receipt_number: string; form_type: string | null; status: string; status_description: string | null; checked_at: string; insights_opt_in: boolean; };
type EventRow = { id: string; status: string; status_description: string | null; recorded_at: string; };
type ShareRow = { id: string; case_id: string; recipient_email: string };
const db = supabase();
const receiptPattern = /^[A-Z]{3}\d{10}$/;

export default function Home() {
  const [session, setSession] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [receipt, setReceipt] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<Record<string, EventRow[]>>({});
  const [shareEmails, setShareEmails] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, ShareRow[]>>({});

  useEffect(() => {
    db.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = db.auth.onAuthStateChange((_event, next) => { setSession(next); if (!next) setCases([]); });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (session) void loadCases(); }, [session]);

  async function loadCases() {
    const { data, error } = await db.from('cases').select('*').order('updated_at', { ascending: false });
    if (error) { setMessage(error.message); return; }
    setCases(data ?? []);
  }

  async function auth(mode: 'signIn' | 'signUp') {
    setBusy(true); setMessage('');
    const result = mode === 'signIn'
      ? await db.auth.signInWithPassword({ email, password })
      : await db.auth.signUp({ email, password });
    setBusy(false);
    setMessage(result.error?.message ?? (mode === 'signUp' ? 'Check your email to confirm your account.' : ''));
  }

  async function lookup(event: FormEvent) { event.preventDefault(); await performLookup(receipt); }

  async function performLookup(input: string) {
    const normalized = input.trim().toUpperCase();
    if (!receiptPattern.test(normalized)) { setMessage('Use three letters followed by ten digits (for example, IOE0123456789).'); return; }
    setBusy(true); setMessage('');
    try {
      const { data: { session: current } } = await db.auth.getSession();
      const response = await fetch('/api/case-status', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current?.access_token ?? ''}` }, body: JSON.stringify({ receiptNumber: normalized }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Lookup failed.');
      if (!current) throw new Error('Sign in again to continue.');
      const caseStatus = payload.case_status ?? payload;
      const nextStatus = caseStatus.current_case_status_text_en ?? caseStatus.current_case_status ?? caseStatus.status ?? 'Status unavailable';
      const nextDescription = caseStatus.current_case_status_desc_en ?? caseStatus.current_case_status_desc ?? caseStatus.status_description ?? null;
      const { data: previous } = await db.from('cases').select('id,status').eq('owner_id', current.user.id).eq('receipt_number', normalized).maybeSingle();
      const baseFormType = caseStatus.formType ?? caseStatus.form_type ?? null;
      const savedFormType = payload.demo ? `Demo · ${baseFormType ?? 'USCIS case'}` : baseFormType;
      const { data, error } = await db.from('cases').upsert({ receipt_number: normalized, form_type: savedFormType, status: nextStatus, status_description: nextDescription, checked_at: new Date().toISOString(), owner_id: current.user.id }, { onConflict: 'owner_id,receipt_number' }).select().single();
      if (error) throw error;
      if (!previous || previous.status !== data.status) {
        const { error: historyError } = await db.from('status_events').insert({ case_id: data.id, owner_id: current.user.id, status: data.status, status_description: data.status_description, recorded_at: data.checked_at });
        if (historyError) throw historyError;
      }
      setReceipt(''); await loadCases(); setMessage(payload.demo ? 'Demo sample saved. This is not a live USCIS result.' : 'Case saved and status refreshed.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }

  async function refreshCase(row: CaseRow) { setReceipt(row.receipt_number); await performLookup(row.receipt_number); }

  async function showHistory(row: CaseRow) {
    const { data, error } = await db.from('status_events').select('*').eq('case_id', row.id).order('recorded_at', { ascending: false });
    if (error) setMessage(error.message); else setHistory(current => ({ ...current, [row.id]: data ?? [] }));
  }

  async function removeCase(row: CaseRow) {
    const { error } = await db.from('cases').delete().eq('id', row.id);
    if (error) setMessage(error.message); else { setCases(current => current.filter(item => item.id !== row.id)); setMessage('Case removed.'); }
  }

  async function shareCase(row: CaseRow) {
    const recipientEmail = (shareEmails[row.id] ?? '').trim();
    if (!recipientEmail) return;
    const { error } = await db.rpc('share_case_with_email', { p_case_id: row.id, p_email: recipientEmail });
    if (error) setMessage(error.message);
    else { setShareEmails(current => ({ ...current, [row.id]: '' })); setMessage('Read-only access granted. They can see this case after signing in.'); await loadShares(row); }
  }

  async function loadShares(row: CaseRow) {
    const { data, error } = await db.from('case_shares').select('id,case_id,recipient_email').eq('case_id', row.id);
    if (error) setMessage(error.message); else setShares(current => ({ ...current, [row.id]: data ?? [] }));
  }

  async function revokeShare(id: string, row: CaseRow) {
    const { error } = await db.from('case_shares').delete().eq('id', id);
    if (error) setMessage(error.message); else await loadShares(row);
  }

  async function setInsightsConsent(row: CaseRow, allowed: boolean) {
    const { error } = await db.from('cases').update({ insights_opt_in: allowed }).eq('id', row.id).eq('owner_id', session.user.id);
    if (error) { setMessage(error.message); return; }
    setCases(current => current.map(item => item.id === row.id ? { ...item, insights_opt_in: allowed } : item));
    setMessage(allowed ? 'Preference saved. Aggregate insights are not active yet.' : 'Insights preference turned off.');
  }

  return <main className="shell">
    <nav className="nav"><a className="brand" href="#"><span className="brand-mark">c</span>caseway</a><span className="nav-note">Your case, made clearer.</span>{session && <button className="text-button" onClick={() => db.auth.signOut()}>Sign out</button>}</nav>
    {!session ? <section className="welcome"><div className="welcome-copy"><div className="eyebrow"><span className="live-dot"/> USCIS CASE TRACKER</div><h1>Know where you stand.<br/><em>Feel less in the dark.</em></h1><p className="intro">A calm, private place to follow your immigration case. Sign in to save your case and keep its story in one place.</p><div className="promise"><span>01</span><p><b>Your details stay yours</b><br/>Your cases are private to your account.</p></div><div className="promise"><span>02</span><p><b>Every update has a timeline</b><br/>See when your case status changes.</p></div><div className="promise"><span>03</span><p><b>No confusing jargon</b><br/>A clearer view of what's happening.</p></div></div>
      <div className="auth-card"><span className="eyebrow">WELCOME TO CASEWAY</span><h2>Your next step starts here.</h2><p>Make an account or pick up where you left off.</p><label>Email address<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"/></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="current-password"/></label><button className="primary full" disabled={busy || !email || !password} onClick={() => auth('signIn')}>{busy ? 'One moment…' : 'Sign in'} <span>→</span></button><button className="secondary full" disabled={busy || !email || !password} onClick={() => auth('signUp')}>Create an account</button><p className="privacy">🔒 &nbsp;Your cases are only visible to you.</p>{message && <p className="notice">{message}</p>}</div>
      <div className="footnote">Built for clarity. Designed around your privacy.</div></section> : <section className="dashboard"><div className="dash-head"><div><div className="eyebrow"><span className="live-dot"/> YOUR PRIVATE DASHBOARD</div><h1>Good to see you<span className="period">.</span></h1><p>Keep your cases close. We’ll keep the details clear.</p></div><div className="case-count"><strong>{String(cases.length).padStart(2, '0')}</strong><span>saved cases</span></div></div>
      <form className="lookup" onSubmit={lookup}><div className="lookup-label"><span className="add-icon">+</span><div><b>Track a case</b><small>Add your 13-character receipt number</small></div></div><input value={receipt} onChange={e => setReceipt(e.target.value.toUpperCase())} maxLength={13} placeholder="IOE0123456789" aria-label="Receipt number"/><button className="primary" disabled={busy}>{busy ? 'Checking…' : 'Look up case'} <span>→</span></button></form>
      {message && <p className="notice">{message}</p>}<div className="section-title"><div><h2>Your cases</h2><p>We check for new information when you ask.</p></div><span className="secure-tag">🔒 &nbsp;Private to you</span></div>
      {cases.length === 0 ? <div className="empty"><div className="empty-mark">✳</div><h3>Your case list starts here.</h3><p>Enter a receipt number above to see your latest case status and start a timeline.</p></div> : <div className="case-list">{cases.map(row => { const isOwner = row.owner_id === session.user.id; return <article className="case-card" key={row.id}><div className="case-top"><div><span className="case-type">{row.form_type || 'USCIS CASE'}{!isOwner && ' · SHARED WITH YOU'}</span><h3>{row.receipt_number}</h3></div><span className="status-pill"><i/> {row.status}</span></div>{row.status_description && <p className="description">{row.status_description}</p>}<div className="case-bottom"><span>Last checked {new Date(row.checked_at).toLocaleString()}</span><div><button className="text-button" onClick={() => showHistory(row)}>View timeline</button>{isOwner && <><button className="text-button" onClick={() => refreshCase(row)} disabled={busy}>↻ Refresh</button><button className="text-button remove" onClick={() => removeCase(row)}>Remove</button><button className="text-button" onClick={() => loadShares(row)}>Manage access</button></>}</div></div>{isOwner && <label className="insight-consent"><input type="checkbox" checked={!!row.insights_opt_in} onChange={e => void setInsightsConsent(row, e.target.checked)}/><span><b>Opt in to future anonymous insights</b><small>Off by default. Aggregate analytics are not active yet; you can change this preference anytime.</small></span></label>}{history[row.id] && <div className="timeline">{history[row.id].map(event => <div className="event" key={event.id}><span className="event-dot"/><div><b>{event.status}</b><small>{new Date(event.recorded_at).toLocaleString()}</small>{event.status_description && <p>{event.status_description}</p>}</div></div>)}</div>}{isOwner && shares[row.id] && <div className="share-panel"><b>Read-only access</b><p>Share with someone who already has a Caseway account. You can revoke access at any time.</p><form onSubmit={e => { e.preventDefault(); void shareCase(row); }}><input type="email" required placeholder="attorney@example.com" value={shareEmails[row.id] ?? ''} onChange={e => setShareEmails(current => ({ ...current, [row.id]: e.target.value }))}/><button className="secondary" type="submit">Share case</button></form>{shares[row.id].map(grant => <div className="grant" key={grant.id}><span>{grant.recipient_email}</span><button className="text-button remove" onClick={() => revokeShare(grant.id, row)}>Revoke</button></div>)}</div>}</article>; })}</div>}
      <p className="data-note">Your case data is private and never shared for research or insights without your explicit opt-in.</p></section>}
  </main>;
}
