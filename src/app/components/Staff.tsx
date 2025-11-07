'use client';

import { useEffect, useState } from 'react';
import { auth, db } from '@/lib/firebase';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';

type StaffMember = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  homePostcode?: string;
  radiusMiles?: number;
  active?: boolean;
  availability?: Record<string, any>;
  role?: string;
  [k: string]: any;
};

export default function Staff() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [viewMember, setViewMember] = useState<StaffMember | null>(null);
  const adminEmail = 'luxencleaninguk@gmail.com'; // <-- change to your admin email

  useEffect(() => {
    if (auth.currentUser?.email !== adminEmail) return;
    const ref = collection(db, 'staff');
    const q = query(ref, orderBy('name', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      const data: StaffMember[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      setStaff(data);
    });
    return unsub;
  }, []);

  if (auth.currentUser?.email !== adminEmail) {
    return (
      <div className="text-gray-600 text-sm">
        Admin access only.
      </div>
    );
  }

  // helper: get the next 7 Date objects starting from today (inclusive)
  function getNext7DaysFromToday(): Date[] {
    const days: Date[] = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      // zero out time for consistency
      d.setHours(0, 0, 0, 0);
      days.push(d);
    }
    return days;
  }

  // week range starting from today -> today + 6
  function weekRangeStrings() {
    const days = getNext7DaysFromToday();
    const first = days[0];
    const last = days[6];
    const fmt = (d: Date) => {
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      return `${dd}/${mm}`;
    };
    return `${fmt(first)} - ${fmt(last)}`;
  }

  // canonical weekday keys Monday...Sunday (lowercase) - used when showing "normal" availability in modal
  function canonicalWeekdayNames(): string[] {
    return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  }

  // weekday keys starting from today (lowercase, e.g. if today is Thursday -> ['thursday','friday',...,'wednesday'])
  function weekdayNamesStartingToday(): string[] {
    const canonical = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const todayIndex = new Date().getDay(); // 0=Sun..6=Sat
    const names: string[] = [];
    for (let i = 0; i < 7; i++) {
      const idx = (todayIndex + i) % 7;
      names.push(canonical[idx]);
    }
    // convert to monday-first style keys if needed by availability shape in db (we assume keys like 'monday'..'sunday')
    // canonical already uses monday.. etc, but starting array uses sunday-first; above canonical array matches JS getDay indexing
    return names;
  }

  // read availability for a specific day key (handles multiple shapes)
  function availabilityForDayKey(s: StaffMember, key: string) {
    const av = s.availability || {};
    // try lowercase key (expected), capitalized, or first-letter uppercase, or numeric index
    const candidates = [
      key,
      key.charAt(0).toUpperCase() + key.slice(1),
      key.toLowerCase(),
      key[0].toUpperCase() + key.slice(1).toLowerCase(),
    ];
    let v: any = undefined;
    for (const c of candidates) {
      if (av[c] !== undefined) {
        v = av[c];
        break;
      }
    }
    // also allow numeric index access if availability stored as array in Mon..Sun order:
    if (v === undefined && Array.isArray(av)) {
      const canonicalOrder = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
      const idx = canonicalOrder.indexOf(key.toLowerCase());
      if (idx >= 0 && av[idx] !== undefined) v = av[idx];
    }

    // Normalize result to { available: boolean, start?: string, end?: string }
    if (typeof v === 'boolean') {
      return { available: v };
    }
    if (!v) {
      return { available: false };
    }
    if (typeof v === 'object') {
      // possible fields: available, start, end, from, to, startTime, endTime
      const available = v.available ?? v.isAvailable ?? true; // object present implies available unless explicit false
      const start = v.start ?? v.from ?? v.startTime ?? v.open ?? null;
      const end = v.end ?? v.to ?? v.endTime ?? v.close ?? null;
      return { available: Boolean(available), start: start ?? undefined, end: end ?? undefined };
    }
    // fallback: false
    return { available: false };
  }

  // availability for week starting from today (returns array of booleans for the table small indicators)
  function availabilityForWeek(s: StaffMember) {
    const names = weekdayNamesStartingToday(); // keys in order starting from today
    return names.map((k) => {
      const v = availabilityForDayKey(s, k);
      return Boolean(v.available);
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[#0071bc]">Staff Overview</h1>
        <p className="text-sm text-gray-700">All registered cleaners and staff members.</p>
      </div>

      <div className="rounded-2xl border bg-white shadow-sm overflow-x-auto">
        <table className="min-w-[720px] w-full text-sm text-gray-800">
          <thead className="bg-gray-50 border-b text-gray-900">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">Name</th>
              <th className="text-left px-4 py-2 font-semibold hidden sm:table-cell">Phone</th>
              <th className="text-left px-4 py-2 font-semibold">Postcode</th>
              <th className="text-left px-4 py-2 font-semibold">Radius (mi)</th>
              <th className="text-left px-4 py-2 font-semibold">Week ({weekRangeStrings()})</th>
              <th className="text-left px-4 py-2 font-semibold">View</th>
            </tr>
          </thead>
          <tbody>
            {staff.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-4 text-center text-gray-500">No staff found.</td>
              </tr>
            ) : (
              staff.map((s) => {
                const week = availabilityForWeek(s);
                return (
                  <tr key={s.id} className="border-b last:border-none hover:bg-gray-50">
                    <td className="px-4 py-2">{s.name || '—'}</td>
                    <td className="px-4 py-2 hidden sm:table-cell">{s.phone || s.email || '—'}</td>
                    <td className="px-4 py-2">{s.homePostcode || '—'}</td>
                    <td className="px-4 py-2">{s.radiusMiles ?? '—'}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1 items-center">
                        {week.map((ok, idx) => {
                          // title should indicate the real day name for tooltip: compute day names starting from today
                          const days = getNext7DaysFromToday();
                          const d = days[idx];
                          const dayShort = d.toLocaleDateString(undefined, { weekday: 'short' }); // Mon, Tue...
                          const dayFull = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
                          return (
                            <span
                              key={idx}
                              title={`${dayShort} — ${dayFull}`}
                              className={`inline-block w-3 h-3 rounded-full ${ok ? 'bg-green-600' : 'bg-red-400'}`}
                            />
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => setViewMember(s)}
                        className="rounded-md border px-3 py-1 text-sm hover:bg-gray-50"
                      >
                        View more
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* View more modal */}
      {viewMember && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-4 shadow-xl overflow-auto max-h-[85vh]">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold text-gray-900">
                {viewMember.name || 'Staff member'}
              </div>
              <button
                className="cursor-pointer rounded-md px-2 py-1 text-sm text-gray-700 hover:bg-gray-100"
                onClick={() => setViewMember(null)}
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-gray-600 mb-1">Contact</div>
                <div className="text-sm text-gray-900">{viewMember.phone || viewMember.email || '—'}</div>
                <div className="text-sm text-gray-600 mt-3">Postcode</div>
                <div className="text-sm text-gray-900">{viewMember.homePostcode || '—'}</div>
                <div className="text-sm text-gray-600 mt-3">Radius</div>
                <div className="text-sm text-gray-900">{viewMember.radiusMiles ?? '—'} miles</div>
              </div>

              <div>
                <div className="text-sm text-gray-600 mb-1">Role / Status</div>
                <div className="text-sm text-gray-900">{viewMember.role || 'cleaner'}</div>
                <div className="text-sm text-gray-600 mt-3">Right to work</div>
                <div className="text-sm text-gray-900">{viewMember.rightToWorkUk ? 'Yes' : 'No'}</div>
                <div className="text-sm text-gray-600 mt-3">DOB</div>
                <div className="text-sm text-gray-900">{viewMember.dateOfBirth || '—'}</div>
              </div>

              <div className="md:col-span-2">
                <div className="text-sm text-gray-600 mb-2">Weekly availability</div>

                {/* NEW: show canonical Monday -> Sunday in a column with tick and start/end times if present */}
                <div className="divide-y">
                  {canonicalWeekdayNames().map((dayKey) => {
                    const displayLabel = dayKey.charAt(0).toUpperCase() + dayKey.slice(1); // Monday
                    const av = availabilityForDayKey(viewMember, dayKey);
                    return (
                      <div key={dayKey} className="py-2 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`inline-block w-3 h-3 rounded-full ${av.available ? 'bg-green-600' : 'bg-red-400'}`} />
                          <div className="text-sm text-gray-900">{displayLabel}</div>
                        </div>
                        <div className="text-sm text-gray-700">
                          {av.available ? (
                            av.start || av.end ? (
                              // show start - end if either exists, fallback to only start or only end if one missing
                              <>
                                {av.start ? av.start : '—'}{av.start || av.end ? ' — ' : ''}{av.end ? av.end : ''}
                              </>
                            ) : (
                              'Available'
                            )
                          ) : (
                            'Not available'
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="md:col-span-2">
                <div className="text-sm text-gray-600 mb-1">Equipment</div>
                <div className="text-sm text-gray-900">
                  {Array.isArray(viewMember.equipment) ? viewMember.equipment.join(', ') : (viewMember.equipment || '—')}
                </div>

                <div className="text-sm text-gray-600 mt-3 mb-1">Services</div>
                <div className="text-sm text-gray-900">
                  {Array.isArray(viewMember.services) ? viewMember.services.join(', ') : (viewMember.services || '—')}
                </div>

                <div className="text-sm text-gray-600 mt-3 mb-1">Notes</div>
                <div className="text-sm text-gray-900">
                  {viewMember.notes || '—'}
                </div>
              </div>
            </div>

            <div className="mt-4 text-right">
              <button
                onClick={() => setViewMember(null)}
                className="rounded-md bg-[#0071bc] text-white px-3 py-2 hover:opacity-95"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
