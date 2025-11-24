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
  hasCar?: boolean;
  bringsSupplies?: boolean;
  equipment?: string[];
  pets?: string[] | string;
  services?: string[];
  teamJobs?: boolean;
  rightToWorkUk?: boolean;
  dateOfBirth?: string | null;
  notes?: string;
  minNoticeHours?: number;
  travelBufferMins?: number;
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
    return names;
  }

  // read availability for a specific day key (handles multiple shapes)
  function availabilityForDayKey(s: StaffMember, key: string) {
    const av = s.availability || {};
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
    if (v === undefined && Array.isArray(av)) {
      const canonicalOrder = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
      const idx = canonicalOrder.indexOf(key.toLowerCase());
      if (idx >= 0 && av[idx] !== undefined) v = av[idx];
    }

    if (typeof v === 'boolean') {
      return { available: v };
    }
    if (!v) {
      return { available: false };
    }
    if (typeof v === 'object') {
      const available = v.available ?? v.isAvailable ?? true;
      const start = v.start ?? v.from ?? v.startTime ?? v.open ?? null;
      const end = v.end ?? v.to ?? v.endTime ?? v.close ?? null;
      return { available: Boolean(available), start: start ?? undefined, end: end ?? undefined };
    }
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

  // small helper: pretty date (YYYY-MM-DD -> dd MMM yyyy) fallback
  function prettyDateISO(iso?: string | null) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' });
    } catch {
      return String(iso);
    }
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
                          const days = getNext7DaysFromToday();
                          const d = days[idx];
                          const dayShort = d.toLocaleDateString(undefined, { weekday: 'short' });
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

     {/* View more modal - UPDATED */}
      {viewMember && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl overflow-auto max-h-[85vh]">
            {/* Header */}
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <div className="text-2xl font-bold text-gray-900">{viewMember.name || 'Staff member'}</div>
                <div className="text-sm text-gray-600 mt-1">{viewMember.email || viewMember.phone || '—'}</div>
                {/* NEW: show Firestore document ID / UID */}
                <div className="text-xs text-gray-500 mt-1">ID: {viewMember.id}</div>
              </div>
              <div className="text-right">
                <div className="text-sm text-gray-600">Role</div>
                <div className="font-medium text-gray-900">{viewMember.role || 'Cleaner'}</div>
                <div className="mt-3">
                  <button
                    className="cursor-pointer rounded-md px-3 py-2 text-sm bg-[#0071bc] text-white hover:opacity-95"
                    onClick={() => setViewMember(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>

            {/* Contact Info */}
            <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
              <h3 className="text-base font-semibold text-gray-900 mb-3">Contact Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Phone</div>
                  <div className="text-sm text-gray-900">{viewMember.phone || '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Email</div>
                  <div className="text-sm text-gray-900">{viewMember.email || '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Postcode</div>
                  <div className="text-sm text-gray-900">{viewMember.homePostcode || '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Travel Radius</div>
                  <div className="text-sm text-gray-900">{viewMember.radiusMiles ?? '—'} miles</div>
                </div>
              </div>
              {viewMember.notes && (
                <div className="mt-3">
                  <div className="text-xs text-gray-600 mb-0.5">Notes</div>
                  <div className="text-sm text-gray-900">{viewMember.notes}</div>
                </div>
              )}
            </div>

            {/* Operational Settings */}
            <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
              <h3 className="text-base font-semibold text-gray-900 mb-3">Operational Settings</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Min Notice</div>
                  <div className="text-sm text-gray-900">{(viewMember.minNoticeHours ?? '—') !== '—' ? `${viewMember.minNoticeHours} h` : '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Travel Buffer</div>
                  <div className="text-sm text-gray-900">{(viewMember.travelBufferMins ?? '—') !== '—' ? `${viewMember.travelBufferMins} min` : '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Date of Birth</div>
                  <div className="text-sm text-gray-900">{prettyDateISO(viewMember.dateOfBirth ?? undefined)}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Status</div>
                  <div className="text-sm text-gray-900">{viewMember.active === false ? 'Inactive' : 'Active'}</div>
                </div>
              </div>
            </div>

            {/* Transport & Equipment */}
            <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
              <h3 className="text-base font-semibold text-gray-900 mb-3">Transport & Equipment</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Has Car</div>
                  <div className="text-sm text-gray-900">{viewMember.hasCar === true ? 'Yes' : viewMember.hasCar === false ? 'No' : '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Brings Supplies</div>
                  <div className="text-sm text-gray-900">{viewMember.bringsSupplies === true ? 'Yes' : viewMember.bringsSupplies === false ? 'No' : '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Team Jobs</div>
                  <div className="text-sm text-gray-900">{viewMember.teamJobs === true ? 'Yes' : viewMember.teamJobs === false ? 'No' : '—'}</div>
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-600 mb-0.5">Equipment</div>
                <div className="text-sm text-gray-900">
                  {Array.isArray(viewMember.equipment) && viewMember.equipment.length > 0 
                    ? viewMember.equipment.join(', ') 
                    : '—'}
                </div>
              </div>
            </div>

            {/* Services & Preferences */}
            <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
              <h3 className="text-base font-semibold text-gray-900 mb-3">Services & Preferences</h3>
              <div className="space-y-3">
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Pet Allergies</div>
                  <div className="text-sm text-gray-900">
                    {Array.isArray(viewMember.pets) && viewMember.pets.length > 0
                      ? `Allergic to: ${viewMember.pets.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ')}`
                      : 'No allergies'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-0.5">Services Offered</div>
                  <div className="text-sm text-gray-900">
                    {Array.isArray(viewMember.services) && viewMember.services.length > 0
                      ? viewMember.services.join(', ')
                      : '—'}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
  <h3 className="text-base font-semibold text-gray-900 mb-3">
    Bank Information
  </h3>

  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
    <div>
      <div className="text-xs text-gray-600 mb-0.5">Account holder</div>
      <div className="text-sm text-gray-900">
        {viewMember.bankAccountName || '—'}
      </div>
    </div>

    <div>
      <div className="text-xs text-gray-600 mb-0.5">Bank</div>
      <div className="text-sm text-gray-900">
        {viewMember.bankName || '—'}
      </div>
    </div>

    <div>
      <div className="text-xs text-gray-600 mb-0.5">Sort code</div>
      <div className="text-sm text-gray-900">
        {viewMember.bankSortCode || '—'}
      </div>
    </div>

    <div>
      <div className="text-xs text-gray-600 mb-0.5">Account number</div>
      <div className="text-sm text-gray-900">
        {viewMember.bankAccountNumber || '—'}
      </div>
    </div>
  </div>

  {viewMember.notes && (
    <div className="mt-3">
      <div className="text-xs text-gray-600 mb-0.5">Notes</div>
      <div className="text-sm text-gray-900">{viewMember.notes}</div>
    </div>
  )}
</div>


            {/* Legal */}
            <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
              <h3 className="text-base font-semibold text-gray-900 mb-3">Legal</h3>
              <div>
                <div className="text-xs text-gray-600 mb-0.5">Right to Work in UK</div>
                <div className="text-sm text-gray-900">{viewMember.rightToWorkUk ? 'Yes' : 'No'}</div>
              </div>
            </div>

            {/* Availability */}
            <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
              <h3 className="text-base font-semibold text-gray-900 mb-3">Weekly Availability</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {canonicalWeekdayNames().map((dayKey) => {
                  const label = dayKey.charAt(0).toUpperCase() + dayKey.slice(1);
                  const av = availabilityForDayKey(viewMember, dayKey);
                  return (
                    <div key={dayKey} className="flex items-start gap-2 p-2">
                      <div className={`inline-block w-3 h-3 mt-1 rounded-full flex-shrink-0 ${av.available ? 'bg-green-600' : 'bg-red-400'}`} />
                      <div>
                        <div className="text-sm font-medium text-gray-900">{label}</div>
                        <div className="text-xs text-gray-600">
                          {av.available ? (av.start || av.end ? `${av.start ?? '—'} — ${av.end ?? '—'}` : 'Available') : 'Not available'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer actions */}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setViewMember(null)}
                className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
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
