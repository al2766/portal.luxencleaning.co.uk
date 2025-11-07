'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';

const ADMIN_EMAIL = 'luxencleaninguk@gmail.com';

export default function StaffHeader() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => setEmail(u?.email ?? null));
  }, []);

  return (
    <header className="bg-[#0071bc] text-white py-4 shadow">
      <div className="max-w-6xl mx-auto px-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          <Link href="/">Luxen Staff Portal</Link>
        </h1>

      </div>
    </header>
  );
}
