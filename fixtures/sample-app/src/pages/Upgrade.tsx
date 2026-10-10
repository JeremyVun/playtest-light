import { useState, type FormEvent } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError, type Plan } from '../api.ts';
import { useApp } from '../app-context.tsx';
import { Field } from '../components/Field.tsx';
import { useFetch } from '../use-fetch.ts';

const PLANS = [
  { id: 'free', name: 'Free', price: 0, blurb: 'Up to 3 seats' },
  { id: 'team', name: 'Team', price: 12, blurb: 'Per seat each month, unlimited projects' },
  { id: 'business', name: 'Business', price: 40, blurb: 'Per seat each month, audit log and priority support' },
];

interface Draft { plan: string; billingName: string; email: string; card: string; seats: string }

function detailErrors(d: Draft) {
  const e: Record<string, string> = {};
  if (!d.billingName.trim()) e.billingName = 'Billing name is required';
  if (!/^\S+@\S+\.\S+$/.test(d.email)) e.email = 'Enter a valid email address';
  if (!/^\d{16}$/.test(d.card.replace(/\s/g, ''))) e.card = 'Card number must be 16 digits';
  const s = Number(d.seats);
  if (!Number.isInteger(s) || s < 1 || s > 100) e.seats = 'Seats must be a whole number from 1 to 100';
  return e;
}

const STEPS = ['Choose plan', 'Details', 'Review and confirm'];

function Steps({ current }: { current: number }) {
  return (
    <ol className="steps" aria-label="Upgrade progress">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === current ? 'step' : undefined} className={i === current ? 'current' : i < current ? 'past' : ''}>
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}

export function Upgrade() {
  const { user, toast } = useApp();
  const nav = useNavigate();
  const current = useFetch<Plan>('/api/plan');
  const [draft, setDraft] = useState<Draft>({ plan: '', billingName: '', email: '', card: '', seats: '3' });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Draft, v: string) => { setDraft((d) => ({ ...d, [k]: v })); setServerErrors({}); };

  if (current.loading) return <p role="status">Loading plan…</p>;
  if (current.error) return <div role="alert" className="error-state"><p>Could not load your plan: {current.error.message}</p><button type="button" onClick={current.reload}>Try again</button></div>;
  const plan = current.data!;
  const planName = (id: string) => PLANS.find((p) => p.id === id)?.name ?? id;

  if (user!.role !== 'admin')
    return (
      <>
        <h1>Plan</h1>
        <p>Your workspace is on the <strong>{planName(plan.plan)}</strong> plan.</p>
        <p role="note">Only admins can change the plan. Ask an admin to upgrade.</p>
      </>
    );

  const errors = detailErrors(draft);
  const shown = (f: string) => serverErrors[f] ?? (touched[f] ? errors[f] : undefined);
  const touch = (f: string) => setTouched((t) => ({ ...t, [f]: true }));
  const price = (PLANS.find((p) => p.id === draft.plan)?.price ?? 0) * (Number(draft.seats) || 0);

  async function confirm() {
    setBusy(true);
    setFormError('');
    try {
      const r = await api<Plan>('/api/plan/upgrade', { method: 'POST', body: draft });
      current.setData(r);
      toast(`Upgraded to ${planName(r.plan)}`);
      nav('/upgrade/done');
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
        setServerErrors(err.fields);
        if (err.fields.card) nav('/upgrade/details');
      }
    }
    setBusy(false);
  }

  return (
    <Routes>
      <Route index element={
        <>
          <h1>Upgrade your plan</h1>
          <p>Current plan: <strong>{planName(plan.plan)}</strong> ({plan.seats} seats)</p>
          <Steps current={0} />
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); nav('/upgrade/details'); }}>
            <fieldset>
              <legend>Choose a plan</legend>
              {PLANS.map((p) => (
                <div key={p.id} className="radio">
                  <input type="radio" id={`plan-${p.id}`} name="plan" value={p.id} checked={draft.plan === p.id} onChange={() => set('plan', p.id)} />
                  <label htmlFor={`plan-${p.id}`}>{p.name} · ${p.price}/seat · {p.blurb}</label>
                </div>
              ))}
            </fieldset>
            <div className="actions"><button type="submit" className="primary" disabled={!draft.plan}>Continue</button></div>
          </form>
        </>
      } />
      <Route path="details" element={
        !draft.plan ? <Navigate to="/upgrade" replace /> : (
          <>
            <h1>Billing details</h1>
            <Steps current={1} />
            <form className="form" noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); nav('/upgrade/review'); }}>
              <Field label="Billing name" error={shown('billingName')}>
                {(p) => <input {...p} value={draft.billingName} onChange={(e) => set('billingName', e.target.value)} onBlur={() => touch('billingName')} />}
              </Field>
              <Field label="Billing email" error={shown('email')}>
                {(p) => <input {...p} type="email" value={draft.email} onChange={(e) => set('email', e.target.value)} onBlur={() => touch('email')} />}
              </Field>
              <Field label="Card number" error={shown('card')} hint="Test mode: use 4242 4242 4242 4242. Nothing is charged.">
                {(p) => <input {...p} inputMode="numeric" autoComplete="off" value={draft.card} onChange={(e) => set('card', e.target.value)} onBlur={() => touch('card')} />}
              </Field>
              <Field label="Seats" error={shown('seats')}>
                {(p) => <input {...p} inputMode="numeric" value={draft.seats} onChange={(e) => set('seats', e.target.value)} onBlur={() => touch('seats')} />}
              </Field>
              <div className="actions">
                <Link to="/upgrade" className="button">Back</Link>
                <button type="submit" className="primary" disabled={Object.keys(errors).length > 0}>Continue</button>
              </div>
            </form>
          </>
        )
      } />
      <Route path="review" element={
        !draft.plan || Object.keys(errors).length ? <Navigate to="/upgrade" replace /> : (
          <>
            <h1>Review and confirm</h1>
            <Steps current={2} />
            <dl className="summary">
              <dt>Plan</dt><dd>{planName(draft.plan)}</dd>
              <dt>Seats</dt><dd>{draft.seats}</dd>
              <dt>Billing name</dt><dd>{draft.billingName}</dd>
              <dt>Email</dt><dd>{draft.email}</dd>
              <dt>Card</dt><dd>ending {draft.card.replace(/\s/g, '').slice(-4)}</dd>
              <dt>Monthly total</dt><dd>${price}</dd>
            </dl>
            {formError && <p className="error" role="alert">{formError}</p>}
            <div className="actions">
              <Link to="/upgrade/details" className="button">Back</Link>
              <button type="button" className="primary" disabled={busy} onClick={confirm}>Confirm upgrade</button>
            </div>
          </>
        )
      } />
      <Route path="done" element={
        <>
          <h1>Upgrade complete</h1>
          <p>You are now on the <strong>{planName(plan.plan)}</strong> plan with {plan.seats} seats, card ending {plan.cardLast4}.</p>
          <Link to="/projects" className="button primary">Back to projects</Link>
        </>
      } />
      <Route path="*" element={<Navigate to="/upgrade" replace />} />
    </Routes>
  );
}
