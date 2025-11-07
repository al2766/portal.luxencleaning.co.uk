'use client';

import { useEffect, useState } from 'react';
import { db } from '@/lib/firebase';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';

export default function Settings() {
  const [autoAssign, setAutoAssign] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ref = doc(db, 'settings', 'general');
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.data() as { autoAssign?: boolean } | undefined;
      setAutoAssign(Boolean(data?.autoAssign));
    });
    return unsub;
  }, []);

  const toggle = async (v: boolean) => {
    setSaving(true);
    try {
      await setDoc(doc(db, 'settings', 'general'), { autoAssign: v }, { merge: true });
      setAutoAssign(v);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-xl font-semibold text-gray-900">Settings</h2>

      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={autoAssign}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span className="text-gray-800">
          Auto-assign bookings to staff (show all unassigned jobs to everyone)
        </span>
      </label>

      {saving && <div className="text-sm text-gray-500">Saving…</div>}
    </div>
  );
}
