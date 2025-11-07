'use client';

import { useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import Jobs from './components/Jobs';
import Profile from './components/Profile';
import CreateAccount from './components/CreateAccount';
import Staff from './components/Staff';
import Finances from './components/Finances';
import Bookings from './components/Bookings'; // ✅ NEW
import Settings from './components/Settings'; // ✅ NEW

const ADMIN_EMAIL = 'luxencleaninguk@gmail.com';

type Tab =
  | 'jobs'
  | 'profile'
  | 'create'
  | 'staff'
  | 'finances'
  | 'bookings'
  | 'settings'; // ✅ NEW tabs

export default function StaffPage() {
  const [user, setUser] = useState<null | { uid: string; email: string | null }>(null);
  const [firstName, setFirstName] = useState<string>('there');
  const [tab, setTab] = useState<Tab>('jobs');

  // ------- Password reset -------
  const sendReset = async () => {
    const email = auth.currentUser?.email;
    if (!email) return alert('No email found on your account.');
    try {
      await sendPasswordResetEmail(auth, email);
      alert('Password reset email sent. Please check your inbox.');
    } catch (e) {
      console.error(e);
      alert('Failed to send password reset email.');
    }
  };

  // ------- Auth state -------
  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setUser(null);
        setFirstName('there');
        return;
      }
      setUser({ uid: u.uid, email: u.email });

      try {
        const snap = await getDoc(doc(db, 'users', u.uid));
        const full =
          (snap.exists() && (snap.data() as any).name) ||
          u.displayName ||
          (u.email ? u.email.split('@')[0] : '');
        const f = (full || '').trim().split(/\s+/)[0];
        setFirstName(f || 'there');
      } catch {
        const fallback =
          u.displayName || (u.email ? u.email.split('@')[0] : 'there');
        setFirstName((fallback || 'there').split(/\s+/)[0]);
      }
    });
  }, []);

  // ------- Admin check -------
  const isAdmin = !!user?.email && user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  // Prevent non-admin from accessing admin-only tabs
  useEffect(() => {
    if (
      !isAdmin &&
      ['create', 'staff', 'finances', 'bookings', 'settings'].includes(tab)
    )
      setTab('jobs');
  }, [isAdmin, tab]);

  if (!user) return <LoginCard />;

  // ------- Tabs -------
  const tabs: Tab[] = (['jobs', 'profile'] as Tab[]).concat(
    isAdmin
      ? (['create', 'staff', 'finances', 'bookings', 'settings'] as Tab[])
      : []
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#0071bc]">Hi {firstName}</h1>
            <p className="text-sm text-gray-600">
              Manage your work and profile here.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3">
            <button
              onClick={sendReset}
              className="px-3 py-2 rounded-md border border-gray-300 text-sm text-gray-800 hover:bg-gray-50 cursor-pointer"
            >
              Change password
            </button>
            <button
              onClick={() => signOut(auth)}
              className="rounded-md bg-red-500 px-3 py-2 text-white text-sm hover:bg-red-600"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="bg-white">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex gap-2 flex-wrap">
            {tabs.map((t) => (
              <button
                key={t}
                className={`px-4 py-2 border-b-2 ${
                  tab === t
                    ? 'border-[#0071bc] text-[#0071bc] font-semibold'
                    : 'border-transparent text-gray-600 hover:text-[#0071bc]'
                }`}
                onClick={() => setTab(t)}
              >
                {t === 'jobs'
                  ? 'Jobs'
                  : t === 'profile'
                  ? 'Profile'
                  : t === 'create'
                  ? 'Create Account'
                  : t === 'staff'
                  ? 'Staff'
                  : t === 'finances'
                  ? 'Finances'
                  : t === 'bookings'
                  ? 'Bookings'
                  : 'Settings'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {tab === 'jobs' && <Jobs />}
        {tab === 'profile' && <Profile />}
        {tab === 'create' &&
          (isAdmin ? (
            <CreateAccount />
          ) : (
            <div className="text-red-600">Not authorized.</div>
          ))}
        {tab === 'staff' &&
          (isAdmin ? <Staff /> : <div className="text-red-600">Not authorized.</div>)}
        {tab === 'finances' &&
          (isAdmin ? (
            <Finances />
          ) : (
            <div className="text-red-600">Not authorized.</div>
          ))}
        {tab === 'bookings' &&
          (isAdmin ? (
            <Bookings />
          ) : (
            <div className="text-red-600">Not authorized.</div>
          ))}
        {tab === 'settings' &&
          (isAdmin ? (
            <Settings />
          ) : (
            <div className="text-red-600">Not authorized.</div>
          ))}
      </main>
    </div>
  );
}

/* ---------- Login-only Card (unchanged) ---------- */
function LoginCard() {
  const [email, setEmail] = useState('');
  const [password, setPass] = useState('');
  const [err, setErr] = useState<string>('');

  const doLogin = async () => {
    setErr('');
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return setErr('Please enter a valid email.');
    if (!password) return setErr('Please enter your password.');
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e: unknown) {
      const any = e as { code?: string; message?: string };
      const msg = String(any?.code || any?.message || '').toLowerCase();
      if (msg.includes('invalid-credential') || msg.includes('wrong-password'))
        setErr('Incorrect email or password.');
      else if (msg.includes('too-many-requests'))
        setErr('Too many attempts. Please wait a moment and try again.');
      else setErr('Login failed. Please try again.');
    }
  };

  return (
    <div className="mt-[6em] flex items-center justify-center px-4">
      <div className="bg-white shadow-lg rounded-2xl p-6 md:p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center text-[#0071bc] mb-2">
          Welcome back
        </h1>
        <p className="text-center text-gray-500 mb-6">Log in to continue</p>

        {err && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {err}
          </div>
        )}

        <label className="block text-sm text-gray-700 mb-1">Email</label>
        <input
          className="text-gray-800 w-full h-11 px-3 rounded-lg border border-gray-300 mb-3"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />

        <label className="block text-sm text-gray-700 mb-1">Password</label>
        <input
          className="text-gray-800 w-full h-11 px-3 rounded-lg border border-gray-300 mb-4"
          type="password"
          value={password}
          onChange={(e) => setPass(e.target.value)}
          placeholder="••••••••"
        />

        <button
          onClick={doLogin}
          className="cursor-pointer w-full bg-[#0071bc] text-white py-3 rounded-lg font-semibold hover:opacity-95"
        >
          Log in
        </button>
      </div>
    </div>
  );
}
