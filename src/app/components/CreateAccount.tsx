'use client';

import { useState } from 'react';
import { app, auth, db } from '@/lib/firebase';
import { doc, setDoc } from 'firebase/firestore';

const inputCls =
  'w-full h-11 px-3 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#0071bc]/20';

const ADMIN_EMAIL = 'luxencleaninguk@gmail.com';

export default function CreateAccountPage() {
  // form
  const [firstName, setFirst] = useState('');
  const [lastName, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPass] = useState('');
  const [confirm, setConfirm] = useState('');

  // ui
  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');

  // admin gate
  const currentEmail = auth.currentUser?.email?.toLowerCase() || '';
  const isAdmin = currentEmail === ADMIN_EMAIL.toLowerCase();
  if (!isAdmin) return <div className="text-red-600">You do not have permission to view this page.</div>;

  const validate = () => {
    if (!firstName.trim()) return 'Please enter first name.';
    if (!lastName.trim()) return 'Please enter last name.';
    if (!/^\S+@\S+\.\S+$/.test(email)) return 'Please enter a valid email address.';
    if (!/^\d{7,}$/.test(phone.replace(/\D/g, ''))) return 'Please enter a valid phone (e.g., 07xxxxxxxxx).';
    if (!password || password.length < 6) return 'Password must be at least 6 characters.';
    if (password !== confirm) return 'Passwords do not match.';
    return '';
  };

  const seedFirestore = async (uid: string) => {
    const name = `${firstName} ${lastName}`.trim();
    const now = new Date().toISOString();

    // Minimal identity for your other project (keeps firstName/lastName for sorting)
    const baseUser = {
      userId: uid,
      name,
      firstName,
      lastName,
      email: email.toLowerCase(),
      phone,
      role: 'cleaner' as const,
      createdAt: now,
      updatedAt: now,
    };

    // Minimal staff doc — NO default ops fields (radius, availability, etc)
    const staffDoc = {
      ...baseUser,
      staffId: uid,
      active: true,
      // operational fields will be added later from the “Complete your profile” flow
    };

    // Write both docs with NAME as the doc id
    const safeId = name.replace(/[.#$/[\]]+/g, '_').trim() || uid;

    try {
      await setDoc(doc(db, 'users', safeId), { ...baseUser }, { merge: true });
    } catch (e: any) {
      throw new Error(`Failed to write users/${safeId}: ${e?.message || e}`);
    }
    try {
      await setDoc(doc(db, 'staff', safeId), { ...staffDoc }, { merge: true });
    } catch (e: any) {
      throw new Error(`Failed to write staff/${safeId}: ${e?.message || e}`);
    }
  };

  const create = async () => {
    setOk(''); setErr('');
    const v = validate();
    if (v) return setErr(v);

    setLoading(true);
    try {
      // Create Auth user via REST (keeps you logged in as admin)
      const apiKey = (app.options as any)?.apiKey;
      if (!apiKey) throw new Error('Missing Firebase apiKey');

      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
        }
      );

      const json = await res.json();
      if (!res.ok) {
        const msg = json?.error?.message || 'Sign up failed';
        throw new Error(msg);
      }

      const uid: string = json.localId;
      if (!uid) throw new Error('Sign up returned no uid');

      await seedFirestore(uid);

      setOk('Staff added successfully.');
      alert('Staff added successfully.');
      setFirst(''); setLast(''); setEmail(''); setPhone(''); setPass(''); setConfirm('');
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes('EMAIL_EXISTS')) setErr('That email is already in use.');
      else if (msg.includes('WEAK_PASSWORD')) setErr('Please choose a stronger password (6+ characters).');
      else if (msg.toLowerCase().includes('missing or insufficient permissions')) {
        setErr('Missing or insufficient permissions when writing to Firestore. Check your security rules.');
      } else setErr(msg);
      console.error('create user error:', e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg">
      <h2 className="text-2xl font-bold text-[#0071bc] mb-2">Create Staff Account</h2>
      <p className="text-sm text-gray-700 mb-5">Add a cleaner with first/last name, email, phone and password.</p>

      {ok && (
        <div className="mb-4 rounded border border-green-200 bg-green-50 text-green-800 text-sm px-3 py-2">
          {ok}
        </div>
      )}
      {err && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 text-red-700 text-sm px-3 py-2">
          {err}
        </div>
      )}

      <div className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-800 mb-1">First name</label>
            <input className={inputCls} value={firstName} onChange={(e) => setFirst(e.target.value)} placeholder="Jane" autoComplete="given-name" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-800 mb-1">Last name</label>
            <input className={inputCls} value={lastName} onChange={(e) => setLast(e.target.value)} placeholder="Doe" autoComplete="family-name" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-800 mb-1">Email</label>
          <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-800 mb-1">Phone</label>
          <input className={inputCls} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xxxxxxxxx" autoComplete="tel" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-800 mb-1">Password</label>
            <input className={inputCls} type="password" value={password} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
          </div>
          <div>
            <label className="block text-sm text-gray-800 mb-1">Confirm password</label>
            <input className={inputCls} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
          </div>
        </div>
      </div>

      <div className="mt-5">
        <button
          onClick={create}
          disabled={loading}
          className="rounded-md bg-[#0071bc] text-white px-4 py-2 font-semibold hover:opacity-95 disabled:opacity-60"
        >
          {loading ? 'Creating…' : 'Create Account'}
        </button>
      </div>

      <p className="mt-3 text-xs text-gray-500">
        Using Firebase projectt: <span className="font-mono">{app.options.projectId || '(unknown)'}</span>
      </p>
    </div>
  );
}
