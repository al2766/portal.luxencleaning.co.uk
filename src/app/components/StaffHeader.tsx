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

    {/* WhatsApp contact button */}
    <a
      href="https://wa.me/441613995273"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-full bg-[#25D366] px-3 py-2 text-sm font-medium text-white shadow-md hover:shadow-lg hover:bg-[#1ebe5d] transition"
    >
      {/* Icon only on mobile */}
      <svg
        className="h-5 w-5"
        viewBox="0 0 32 32"
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="currentColor"
          d="M16.04 6C10.53 6 6.04 10.49 6.04 16c0 2.01.59 3.89 1.71 5.53L6 26l4.6-1.7A9.94 9.94 0 0 0 16.04 26C21.55 26 26 21.51 26 16S21.55 6 16.04 6zm0 17.6c-1.7 0-3.35-.46-4.8-1.34l-.34-.2-2.73 1 0.95-2.82-.22-.35a8.43 8.43 0 0 1-1.3-4.48c0-4.67 3.8-8.47 8.47-8.47 4.66 0 8.46 3.8 8.46 8.47 0 4.66-3.8 8.47-8.46 8.47zm4.7-6c-.26-.13-1.53-.76-1.77-.85-.24-.09-.41-.13-.58.13-.17.26-.66.85-.8 1.02-.15.17-.3.19-.56.06-.26-.13-1.08-.4-2.05-1.27-.76-.68-1.28-1.52-1.43-1.78-.15-.26-.02-.4.11-.53.12-.12.26-.3.39-.45.13-.15.17-.26.26-.43.09-.17.04-.32-.02-.45-.06-.13-.58-1.39-.79-1.91-.21-.51-.42-.44-.58-.45l-.5-.01c-.17 0-.45.06-.69.32-.24.26-.9.88-.9 2.15 0 1.27.92 2.5 1.05 2.67.13.17 1.82 2.96 4.41 4.15.62.3 1.1.47 1.48.6.62.2 1.19.17 1.63.1.5-.08 1.53-.63 1.75-1.24.22-.6.22-1.12.15-1.24-.07-.12-.24-.19-.5-.32z"
        />
      </svg>

      {/* Text only on md+ screens */}
      <span className="hidden md:inline">Contact us</span>
    </a>
  </div>
</header>

  );
}
