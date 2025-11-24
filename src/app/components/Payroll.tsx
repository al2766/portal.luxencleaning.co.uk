'use client';

import { useEffect, useMemo, useState } from 'react';
import { auth, db } from '@/lib/firebase';
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  addDoc,
  doc,
  updateDoc,
} from 'firebase/firestore';

// ====== CONFIG / ASSUMPTIONS ======

// What you pay staff per cleaner per hour
const STAFF_RATE = 12.21;

// Name of the field on a booking doc that stores the job status
const BOOKING_STATUS_FIELD = 'status';
const COMPLETED_STATUS_VALUE = 'completed';

// Possible fields on a booking doc that point to staff IDs
const STAFF_ID_FIELDS = [
  'assignedStaffIds', // array
  'staffIds',         // array
  'assignedStaffId',  // single
  'staffId',          // single
  'cleanerId',        // single
];

// ====== TYPES ======

type StaffDoc = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  bankAccountName?: string | null;
  bankName?: string | null;
  bankSortCode?: string | null;
  bankAccountNumber?: string | null;
};

type BookingDoc = {
  id: string;
  date: string; // "YYYY-MM-DD"
  serviceType?: string;
  customerName?: string;
  estimatedHours: number;
  twoCleaners: boolean;
  staffPaid?: boolean;
  staffIds: string[];
};

type StaffSummaryJob = {
  bookingId: string;
  date: string;
  serviceType: string;
  hoursEach: number;
  payEach: number;
  customerName: string;
};

type StaffSummary = {
  staffId: string;
  name: string;
  email: string;
  bankAccountName: string;
  bankName: string;
  bankSortCode: string;
  bankAccountNumber: string;
  totalHours: number;
  totalPay: number;
  jobCount: number;
  jobs: StaffSummaryJob[];
};

// ====== DATE HELPERS ======

function ymd(d: Date): string {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Week is Monday–Sunday. We want the week that ended on the most recent Sunday.
function getLastCompletedWeek(today: Date) {
  const t = new Date(today);
  t.setHours(0, 0, 0, 0);
  const dow = t.getDay(); // 0 Sun, 1 Mon, ..., 6 Sat

  const lastSunday = new Date(t);
  lastSunday.setDate(t.getDate() - dow); // if Sun -> today; if Mon -> yesterday, etc.
  lastSunday.setHours(0, 0, 0, 0);

  const monday = new Date(lastSunday);
  monday.setDate(lastSunday.getDate() - 6);

  return { start: monday, end: lastSunday };
}

function formatDdMm(d: Date) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

// ====== SMALL HELPERS ======

function extractStaffIds(raw: any): string[] {
  if (!raw || typeof raw !== 'object') return [];
  // arrays first
  for (const key of STAFF_ID_FIELDS) {
    const val = raw[key];
    if (Array.isArray(val)) {
      return val.filter(Boolean);
    }
  }
  // single fields
  for (const key of STAFF_ID_FIELDS) {
    const val = raw[key];
    if (val && !Array.isArray(val)) {
      return [String(val)];
    }
  }
  return [];
}

function csvEscape(v: string): string {
  if (v == null) v = '';
  if (v.includes('"') || v.includes(',') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// Build CSV rows (one row per staff per job)
function buildCsv(
  bookings: BookingDoc[],
  staffMap: Record<string, StaffDoc>
): string {
  const header = [
    'Staff name',
    'Staff email',
    'Bank account name',
    'Bank name',
    'Sort code',
    'Account number',
    'Booking ID',
    'Booking date',
    'Service type',
    'Hours (per cleaner)',
    'Pay (£ per cleaner)',
  ].join(',');

  const rows: string[] = [header];

  bookings.forEach((b) => {
    const hoursEach = b.estimatedHours || 0;
    const payEach = hoursEach * STAFF_RATE;
    const dateStr = b.date || '';
    const service = b.serviceType || '';

    if (!b.staffIds || b.staffIds.length === 0) return;

    b.staffIds.forEach((sid) => {
      const s = staffMap[sid] || ({} as StaffDoc);
      rows.push(
        [
          csvEscape(s.name || 'Unknown'),
          csvEscape(s.email || ''),
          csvEscape(s.bankAccountName || ''),
          csvEscape(s.bankName || ''),
          csvEscape(s.bankSortCode || ''),
          csvEscape(s.bankAccountNumber || ''),
          csvEscape(b.id),
          csvEscape(dateStr),
          csvEscape(service),
          csvEscape(hoursEach.toFixed(2)),
          csvEscape(payEach.toFixed(2)),
        ].join(',')
      );
    });
  });

  return rows.join('\n');
}

// Summarise bookings per staff for a given subset
function summariseByStaff(
  bookings: BookingDoc[],
  staffMap: Record<string, StaffDoc>
): { staffList: StaffSummary[]; totalPay: number; totalJobs: number } {
  const summaryMap: Record<string, StaffSummary> = {};

  bookings.forEach((b) => {
    const hoursEach = b.estimatedHours || 0;
    const payEach = hoursEach * STAFF_RATE;

    if (!b.staffIds || b.staffIds.length === 0) return;

    b.staffIds.forEach((sid) => {
      const s = staffMap[sid] || ({} as StaffDoc);
      if (!summaryMap[sid]) {
        summaryMap[sid] = {
          staffId: sid,
          name: s.name || 'Unknown staff',
          email: s.email || '',
          bankAccountName: s.bankAccountName || '',
          bankName: s.bankName || '',
          bankSortCode: s.bankSortCode || '',
          bankAccountNumber: s.bankAccountNumber || '',
          totalHours: 0,
          totalPay: 0,
          jobCount: 0,
          jobs: [],
        };
      }

      summaryMap[sid].totalHours += hoursEach;
      summaryMap[sid].totalPay += payEach;
      summaryMap[sid].jobCount += 1;
      summaryMap[sid].jobs.push({
        bookingId: b.id,
        date: b.date,
        serviceType: b.serviceType || '',
        hoursEach,
        payEach,
        customerName: b.customerName || '',
      });
    });
  });

  const staffList = Object.values(summaryMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const totalPay = staffList.reduce((sum, s) => sum + s.totalPay, 0);
  const totalJobs = bookings.length;

  return { staffList, totalPay, totalJobs };
}

// ====== COMPONENT ======

export default function Payroll() {
  const adminEmail = 'luxencleaninguk@gmail.com';

  const [staff, setStaff] = useState<StaffDoc[]>([]);
  const [bookings, setBookings] = useState<BookingDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Custom range (advanced)
  const [customOpen, setCustomOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // Freeze "today" for the render
  const [today] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Weekly pay period (Mon–Sun that most recently ended)
  const { start: weekStart, end: weekEnd } = useMemo(
    () => getLastCompletedWeek(today),
    [today]
  );
  const weekStartYmd = ymd(weekStart);
  const weekEndYmd = ymd(weekEnd);
  const weekLabelShort = `${formatDdMm(weekStart)} - ${formatDdMm(weekEnd)}`;

  // Only allow "Mark week as paid" on Monday or Tuesday
  const canRunWeekly =
    today.getDay() === 1 || today.getDay() === 2; // 1=Mon,2=Tue

  // Admin guard
  if (auth.currentUser?.email !== adminEmail) {
    return <div className="text-gray-600 text-sm">Admin access only.</div>;
  }

  // Load staff + recent completed bookings
  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        // 1) Staff
        const staffSnap = await getDocs(collection(db, 'staff'));
        const staffList: StaffDoc[] = staffSnap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            name: (data.name || '').trim(),
            email: data.email || '',
            phone: data.phone || '',
            bankAccountName: data.bankAccountName || '',
            bankName: data.bankName || '',
            bankSortCode: data.bankSortCode || '',
            bankAccountNumber: data.bankAccountNumber || '',
          };
        });
        setStaff(staffList);

        // 2) Completed bookings for last ~60 days
        const cutoff = new Date(today);
        cutoff.setDate(cutoff.getDate() - 60);
        const cutoffYmd = ymd(cutoff);

        const qBookings = query(
          collection(db, 'bookings'),
          where(BOOKING_STATUS_FIELD, '==', COMPLETED_STATUS_VALUE),
          where('date', '>=', cutoffYmd),
          orderBy('date', 'desc')
        );
        const bookingsSnap = await getDocs(qBookings);
        const bookingList: BookingDoc[] = bookingsSnap.docs.map((d) => {
          const data = d.data() as any;
          const staffIds = extractStaffIds(data);
          const hours = Number(data.estimatedHours ?? data.estimated_hours ?? 0);
          const twoCleaners = Boolean(
            data.twoCleaners ?? data.teamApplied ?? false
          );
          return {
            id: d.id,
            date: data.date || '',
            serviceType: data.serviceType || '',
            customerName: data.customerName || '',
            estimatedHours: Number.isFinite(hours) ? hours : 0,
            twoCleaners,
            staffPaid: Boolean(data.staffPaid),
            staffIds,
          };
        });

        setBookings(bookingList);
      } catch (err) {
        console.error('Failed to load payroll data', err);
        setError('Failed to load payroll data. See console for details.');
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [today]);

  const staffMap: Record<string, StaffDoc> = useMemo(() => {
    const m: Record<string, StaffDoc> = {};
    staff.forEach((s) => {
      m[s.id] = s;
    });
    return m;
  }, [staff]);

  // ===== WEEKLY (guiding default) =====

  const weekly = useMemo(() => {
    const subset = bookings.filter((b) => {
      if (b.staffPaid) return false; // only unpaid
      if (!b.date) return false;
      return b.date >= weekStartYmd && b.date <= weekEndYmd;
    });

    return {
      bookings: subset,
      ...summariseByStaff(subset, staffMap),
    };
  }, [bookings, staffMap, weekStartYmd, weekEndYmd]);

  // ===== CUSTOM RANGE (advanced) =====

  const custom = useMemo(() => {
    if (!customFrom || !customTo) return null;
    if (customTo < customFrom) return null;

    const subset = bookings.filter((b) => {
      if (b.staffPaid) return false;
      if (!b.date) return false;
      return b.date >= customFrom && b.date <= customTo;
    });

    return {
      fromYmd: customFrom,
      toYmd: customTo,
      bookings: subset,
      ...summariseByStaff(subset, staffMap),
    };
  }, [bookings, staffMap, customFrom, customTo]);

  // ===== ACTIONS =====

  function triggerCsvDownload(bookingsSubset: BookingDoc[], filename: string) {
    if (!bookingsSubset.length) {
      alert('No bookings in this period.');
      return;
    }
    const csv = buildCsv(bookingsSubset, staffMap);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function markPeriodAsPaid(kind: 'week' | 'custom') {
    const set = kind === 'week' ? weekly : custom;
    if (!set || !set.bookings.length) {
      alert('No bookings to mark as paid for this period.');
      return;
    }

    const fromYmd = kind === 'week' ? weekStartYmd : (set as any).fromYmd;
    const toYmd = kind === 'week' ? weekEndYmd : (set as any).toYmd;

    const label =
      kind === 'week'
        ? `week ${weekLabelShort}`
        : `custom period ${fromYmd} → ${toYmd}`;

    if (
      !window.confirm(
        `Mark ${set.bookings.length} booking(s) as paid for ${label}?`
      )
    ) {
      return;
    }

    setSaving(true);
    try {
      // 1) Update each booking
      await Promise.all(
        set.bookings.map((b) =>
          updateDoc(doc(db, 'bookings', b.id), {
            staffPaid: true,
            staffPaidAt: new Date().toISOString(),
            staffPaidFrom: fromYmd,
            staffPaidTo: toYmd,
          })
        )
      );

      // 2) Store a payroll run document (for history / Zapier)
      await addDoc(collection(db, 'payrollRuns'), {
        kind,
        fromYmd,
        toYmd,
        createdAt: new Date().toISOString(),
        totalBookings: set.bookings.length,
        totalStaffPay: set.totalPay,
        staffSummaries: set.staffList.map((s: StaffSummary) => ({
          staffId: s.staffId,
          name: s.name,
          totalHours: s.totalHours,
          totalPay: s.totalPay,
          jobCount: s.jobCount,
        })),
      });

      alert('Marked as paid ✅');
      // simplest: reload so "unpaid" view refreshes
      window.location.reload();
    } catch (err) {
      console.error('Failed to mark as paid', err);
      alert('Failed to mark as paid. See console for details.');
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#0071bc]/30';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[#0071bc]">Payroll</h1>
        <p className="text-sm text-gray-700 max-w-2xl">
          Weekly staff pay based on <span className="font-medium">completed</span>{' '}
          bookings. Default view shows the last completed week (Monday–Sunday).
          We assume each cleaner is paid{' '}
          <strong>£{STAFF_RATE.toFixed(2)}</strong> per hour.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-white shadow-sm p-4">
          <div className="text-xs text-gray-500 mb-1">This pay period</div>
          <div className="text-sm font-semibold text-gray-900">
            {formatDdMm(weekStart)} – {formatDdMm(weekEnd)}
          </div>
          <div className="mt-2 text-xs text-gray-500">Unpaid staff pay</div>
          <div className="text-lg font-semibold text-green-700">
            £{weekly.totalPay.toFixed(2)}
          </div>
        </div>

        <div className="rounded-xl border bg-white shadow-sm p-4">
          <div className="text-xs text-gray-500 mb-1">Unpaid jobs</div>
          <div className="text-2xl font-semibold text-gray-900">
            {weekly.totalJobs}
          </div>
          <div className="mt-2 text-xs text-gray-500">
            Completed & not yet marked as paid.
          </div>
        </div>

        <div className="rounded-xl border bg-white shadow-sm p-4">
          <div className="text-xs text-gray-500 mb-1">Staff with pay due</div>
          <div className="text-2xl font-semibold text-gray-900">
            {weekly.staffList.length}
          </div>
          <div className="mt-2 text-xs text-gray-500">
            Based on jobs in this period.
          </div>
        </div>
      </div>

      {/* Weekly actions */}
      <div className="rounded-2xl border bg-white shadow-sm p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-semibold text-gray-900">
            Weekly payroll (guidance)
          </div>
          <div className="text-xs text-gray-600 mt-1 max-w-xl">
            Run payroll each <span className="font-medium">Monday</span> (or
            Tuesday if needed) for the week that ended on Sunday. Download the
            CSV, pay staff from your bank, then click{' '}
            <span className="font-medium">Mark week as paid</span>.
          </div>
          <div className="mt-1 text-xs text-gray-500">
            Current period:{' '}
            <span className="font-medium">{weekLabelShort}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              triggerCsvDownload(
                weekly.bookings,
                `luxen-payroll-${weekStartYmd}-to-${weekEndYmd}.csv`
              )
            }
            disabled={weekly.bookings.length === 0}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-800 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            Download CSV (week)
          </button>
          <button
            type="button"
            onClick={() => markPeriodAsPaid('week')}
            disabled={!canRunWeekly || weekly.bookings.length === 0 || saving}
            className="px-4 py-2 rounded-md bg-[#0071bc] text-white text-sm hover:opacity-95 disabled:opacity-50"
          >
            {canRunWeekly
              ? saving
                ? 'Marking…'
                : 'Mark week as paid'
              : 'Mark week as paid (Mon–Tue only)'}
          </button>
        </div>
      </div>

      {/* Weekly staff table */}
      <div className="rounded-2xl border bg-white shadow-sm overflow-x-auto">
        <div className="px-4 pt-4 pb-2 text-sm font-medium text-gray-900">
          Staff breakdown for week {weekLabelShort}
        </div>
        {loading ? (
          <div className="px-4 pb-4 text-xs text-gray-500">Loading…</div>
        ) : weekly.staffList.length === 0 ? (
          <div className="px-4 pb-4 text-xs text-gray-500">
            No unpaid completed bookings in this period.
          </div>
        ) : (
          <table className="min-w-[700px] w-full text-sm text-gray-800">
            <thead className="bg-gray-50 border-b text-gray-900">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Staff</th>
                <th className="text-left px-4 py-2 font-semibold">Jobs</th>
                <th className="text-left px-4 py-2 font-semibold">Hours</th>
                <th className="text-left px-4 py-2 font-semibold">Pay (£)</th>
                <th className="text-left px-4 py-2 font-semibold">Bank</th>
              </tr>
            </thead>
            <tbody>
              {weekly.staffList.map((s) => (
                <tr
                  key={s.staffId}
                  className="border-b last:border-none hover:bg-gray-50"
                >
                  <td className="px-4 py-2">
                    <div className="font-medium text-gray-900">{s.name}</div>
                    {s.email && (
                      <div className="text-xs text-gray-500">{s.email}</div>
                    )}
                  </td>
                  <td className="px-4 py-2">{s.jobCount}</td>
                  <td className="px-4 py-2">
                    {s.totalHours.toFixed(2)}
                    <span className="text-xs text-gray-500 ml-1">hrs</span>
                  </td>
                  <td className="px-4 py-2 font-semibold">
                    £{s.totalPay.toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-700">
                    {s.bankAccountName ? (
                      <>
                        <div>{s.bankAccountName}</div>
                        {s.bankName && <div>{s.bankName}</div>}
                        {(s.bankSortCode || s.bankAccountNumber) && (
                          <div className="text-gray-500">
                            {s.bankSortCode && `SC: ${s.bankSortCode}`}{' '}
                            {s.bankAccountNumber &&
                              `· AC: ${s.bankAccountNumber}`}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-red-500">
                        Missing bank details
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Advanced: custom range */}
      <div className="rounded-2xl border bg-white shadow-sm p-4">
        <button
          type="button"
          onClick={() => setCustomOpen((v) => !v)}
          className="text-sm font-medium text-gray-900 flex items-center justify-between w-full cursor-pointer"
        >
          <span>Advanced: custom date range</span>
          <span className="text-xs text-gray-500">
            {customOpen ? 'Hide' : 'Show'}
          </span>
        </button>

        {customOpen && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  From (inclusive)
                </label>
                <input
                  type="date"
                  className={inputClass}
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  To (inclusive)
                </label>
                <input
                  type="date"
                  className={inputClass}
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <div className="text-xs font-semibold text-gray-700">
                  Actions
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      custom &&
                      triggerCsvDownload(
                        custom.bookings,
                        `luxen-payroll-${custom.fromYmd}-to-${custom.toYmd}.csv`
                      )
                    }
                    disabled={!custom || custom.bookings.length === 0}
                    className="px-3 py-2 rounded-md border border-gray-300 text-xs text-gray-800 bg-white hover:bg-gray-50 disabled:opacity-50"
                  >
                    Download CSV (range)
                  </button>
                  <button
                    type="button"
                    onClick={() => markPeriodAsPaid('custom')}
                    disabled={!custom || custom.bookings.length === 0 || saving}
                    className="px-3 py-2 rounded-md bg-[#0071bc] text-white text-xs hover:opacity-95 disabled:opacity-50"
                  >
                    {saving ? 'Marking…' : 'Mark range as paid'}
                  </button>
                </div>
              </div>
            </div>

            {(!customFrom || !customTo) && (
              <div className="text-xs text-gray-500">
                Select both a <span className="font-medium">from</span> and{' '}
                <span className="font-medium">to</span> date to see results.
              </div>
            )}

            {customFrom && customTo && customTo < customFrom && (
              <div className="text-xs text-red-600">
                The <span className="font-medium">to</span> date must be on or
                after the <span className="font-medium">from</span> date.
              </div>
            )}

            {custom && (
              <div className="rounded-xl border bg-white shadow-inner overflow-x-auto">
                <div className="px-4 pt-3 pb-2 text-sm font-medium text-gray-900">
                  Staff breakdown for {custom.fromYmd} – {custom.toYmd}
                </div>
                {custom.staffList.length === 0 ? (
                  <div className="px-4 pb-4 text-xs text-gray-500">
                    No unpaid completed bookings in this range.
                  </div>
                ) : (
                  <table className="min-w-[700px] w-full text-sm text-gray-800">
                    <thead className="bg-gray-50 border-b text-gray-900">
                      <tr>
                        <th className="text-left px-4 py-2 font-semibold">
                          Staff
                        </th>
                        <th className="text-left px-4 py-2 font-semibold">
                          Jobs
                        </th>
                        <th className="text-left px-4 py-2 font-semibold">
                          Hours
                        </th>
                        <th className="text-left px-4 py-2 font-semibold">
                          Pay (£)
                        </th>
                        <th className="text-left px-4 py-2 font-semibold">
                          Bank
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {custom.staffList.map((s) => (
                        <tr
                          key={s.staffId}
                          className="border-b last:border-none hover:bg-gray-50"
                        >
                          <td className="px-4 py-2">
                            <div className="font-medium text-gray-900">
                              {s.name}
                            </div>
                            {s.email && (
                              <div className="text-xs text-gray-500">
                                {s.email}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-2">{s.jobCount}</td>
                          <td className="px-4 py-2">
                            {s.totalHours.toFixed(2)}
                            <span className="text-xs text-gray-500 ml-1">
                              hrs
                            </span>
                          </td>
                          <td className="px-4 py-2 font-semibold">
                            £{s.totalPay.toFixed(2)}
                          </td>
                          <td className="px-4 py-2 text-xs text-gray-700">
                            {s.bankAccountName ? (
                              <>
                                <div>{s.bankAccountName}</div>
                                {s.bankName && <div>{s.bankName}</div>}
                                {(s.bankSortCode || s.bankAccountNumber) && (
                                  <div className="text-gray-500">
                                    {s.bankSortCode && `SC: ${s.bankSortCode}`}{' '}
                                    {s.bankAccountNumber &&
                                      `· AC: ${s.bankAccountNumber}`}
                                  </div>
                                )}
                              </>
                            ) : (
                              <span className="text-red-500">
                                Missing bank details
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
