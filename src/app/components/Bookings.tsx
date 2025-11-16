'use client';

import { useEffect, useMemo, useState } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
} from 'firebase/firestore';

type Address =
  | string
  | {
      line1?: string;
      line2?: string;
      town?: string;
      county?: string;
      postcode?: string;
    };

// NEW: shared room/toilet selection types for newer bookings (office + structured home)
type RoomSelection = {
  typeId?: string;
  sizeId?: string;
  count?: number;
};

type AreaSelection = {
  sizeId?: string;
  count?: number;
};

type OfficeDetails = {
  roomsCount?: number;
  rooms?: { typeId?: string; sizeId?: string }[];
  kitchensCount?: number;
  kitchenSizeId?: string;
  toiletRoomsCount?: number;
  avgCubicles?: number;
  extras?: {
    fridge?: number;
    freezer?: number;
    dishwasher?: number;
    cupboards?: number;
  };
};

type BookingDoc = {
  orderId: string;
  date: string;
  startTime: string;
  endTime?: string;
  totalPrice?: number; // keep showing customer price here
  customerName?: string;
  customerPhone?: string;
  address?: Address;
  bedrooms?: number | string;
  bathrooms?: number | string;
  livingRooms?: number | string;
  kitchens?: number | string;
  utilityRooms?: number | string;
  additionalRooms?: string[] | string;
  addOns?: string[] | string;
  estimatedHours?: number;
  cleanliness?: string;
  serviceType?: string;
  additionalInfo?: string;
  office?: OfficeDetails;

  // NEW: structured arrays for office / newer bookings
  roomSelections?: RoomSelection[];
  toiletSelections?: AreaSelection[];
  toiletRoomsCount?: number;
  avgCubicles?: number;
  totalCubicles?: number;
  toiletSizeId?: string;
  staffCount?: number;
  timeSlot?: string;

  // NEW: booking-builder summaries used in your checkout
  roomSummaries?: {
    label?: string;
    typeId?: string;
    sizes?: string[];
    count?: number;
  }[];
  bathroomsSummary?: {
    count?: number;
    avgToiletsPerBathroom?: number;
  };
  kitchenSummary?: {
    count?: number;
    sizeId?: string;
  };

  // legacy single fields
  assignedStaffId?: string | null;
  assignedStaffName?: string | null;

  // NEW for two cleaners
  twoCleaners?: boolean;
  assignedStaffIds?: string[];
  assignedStaffNames?: string[];

  // NEW: confirmation tracking
  confirmedStaffIds?: string[];
};

type Job = BookingDoc & {
  id: string;
  displayTime: string;
  displayAddress: string;
};

type StaffRow = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  active?: boolean;
};

function formatShortDate(ymd?: string | null): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d)
    .toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    })
    .toUpperCase(); // e.g. 29 NOV 25
}

function toE164UK(raw?: string | null): string | null {
  if (!raw) return null;

  // Keep digits only
  const digits = raw.replace(/[^\d]/g, '');

  // 0XXXXXXXXXX  -> +44XXXXXXXXXX
  if (digits.startsWith('0') && digits.length >= 10) {
    return '+44' + digits.slice(1);
  }

  // 44XXXXXXXXXX -> +44XXXXXXXXXX
  if (digits.startsWith('44')) {
    return '+' + digits;
  }

  // Already starts with + (assume ok)
  if (raw.trim().startsWith('+')) {
    return raw.trim();
  }

  // Fallback: if nothing matched, just return with + in front of digits
  return '+' + digits;
}

const money = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 2,
});

// UPDATED: include extra small
const SIZE_LABELS: Record<string, string> = {
  xs: 'extra small',
  s: 'small',
  m: 'medium',
  l: 'large',
  xl: 'extra large',
};

// NEW: labels for room types coming from structured selections (home + office)
const ROOM_TYPE_LABELS: Record<string, string> = {
  // Home-style mappings
  'open-plan': 'Living / open-plan area',
  meeting: 'Bedroom',
  'private-office': 'Home office / study',
  reception: 'Hallway / landing',
  corridor: 'Corridor',
  storage: 'Storage / utility',
  // Office-style extras
  kitchen: 'Kitchen / tea point',
  other: 'Other area',
};

const labelRoomType = (typeId?: string | null): string => {
  if (!typeId) return 'Room';
  const key = typeId.toLowerCase();
  if (ROOM_TYPE_LABELS[key]) return ROOM_TYPE_LABELS[key];
  // Fallback: prettify the raw id
  return typeId
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const parseCount = (v?: number | string): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

// helpers for arrays + legacy
function getAssignedIds(j: BookingDoc): string[] {
  if (Array.isArray(j.assignedStaffIds) && j.assignedStaffIds.length)
    return j.assignedStaffIds.filter(Boolean) as string[];
  return j.assignedStaffId ? [j.assignedStaffId] : [];
}
function getAssignedNames(j: BookingDoc): string[] {
  if (Array.isArray(j.assignedStaffNames) && j.assignedStaffNames.length)
    return j.assignedStaffNames.filter(Boolean) as string[];
  return j.assignedStaffName ? [j.assignedStaffName] : [];
}
function requiredCleaners(j: BookingDoc) {
  return j.twoCleaners ? 2 : 1;
}

// NEW: confirmation helper – same logic as jobs.tsx style
function isConfirmedBooking(j: BookingDoc) {
  const ids = Array.isArray(j.confirmedStaffIds)
    ? j.confirmedStaffIds.filter(Boolean)
    : [];
  return ids.length >= requiredCleaners(j);
}

export default function Bookings() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [assignFor, setAssignFor] = useState<Job | null>(null);

  // NEW: selection state for two-cleaner jobs
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // view modal state
  const [viewBooking, setViewBooking] = useState<Job | null>(null);

  useEffect(() => {
    const ref = collection(db, 'bookings');
    const q = query(ref, orderBy('date', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const items: Job[] = snap.docs.map((d) => {
        const data = d.data() as BookingDoc;
        const start = data.startTime ?? '';
        const end = data.endTime ?? '';
        const displayTime = end && end !== start ? `${start} - ${end}` : start;

        const addr =
          typeof data.address === 'string'
            ? data.address
            : [data.address?.line1, data.address?.town, data.address?.postcode]
                .filter(Boolean)
                .join(', ');

        return { id: d.id, ...data, displayTime, displayAddress: addr };
      });
      setJobs(items);
    });
    return unsub;
  }, []);

  useEffect(() => {
    async function loadStaff() {
      const snap = await getDocs(collection(db, 'staff'));
      const people: StaffRow[] = snap.docs.map((d) => {
        const s = d.data() as Record<string, unknown>;
        const name =
          typeof s.name === 'string' && s.name.trim()
            ? s.name
            : typeof s.firstName === 'string' || typeof s.lastName === 'string'
            ? `${(s.firstName as string | undefined) ?? ''} ${
                (s.lastName as string | undefined) ?? ''
              }`.trim()
            : undefined;
        return {
          id: d.id,
          name,
          email: (s.email as string | undefined) ?? undefined,
          phone: (s.phone as string | undefined) ?? undefined,
          active: s.active !== false,
        };
      });
      setStaff(people);
    }
    void loadStaff();
  }, []);

  // pending if not fully assigned for its required cleaners
  const pending = useMemo(
    () => jobs.filter((j) => getAssignedIds(j).length < requiredCleaners(j)),
    [jobs]
  );
  const assigned = useMemo(
    () => jobs.filter((j) => getAssignedIds(j).length >= requiredCleaners(j)),
    [jobs]
  );

  const assignTo = async (jobId: string, staffId: string, staffName: string) => {
    // Always assign
    await updateDoc(doc(db, 'bookings', jobId), {
      assignedStaffIds: [staffId],
      assignedStaffNames: [staffName || 'Staff Member'],
      assignedStaffId: staffId, // legacy
      assignedStaffName: staffName || 'Staff Member',
    });
    setAssignFor(null);

    // Ask if we should notify via Zapier
    const notify = window.confirm(
      'Do you want to send a notification to the staff member?'
    );
    if (!notify) return;

    // Send Zapier webhook for single staff assignment
    try {
      const job = jobs.find((j) => j.id === jobId);
      const staffRow = staff.find((s) => s.id === staffId);

      const postcode =
        typeof job?.address === 'string'
          ? job?.address || ''
          : job?.address?.postcode || '';

      const staffPay =
        job?.estimatedHours != null
          ? (job.estimatedHours * 12.21).toFixed(2)
          : '0.00';

      const payload = {
        trigger: 'booking_assigned',
        jobId,
        staffId,
        staffName,
        staffEmail: staffRow?.email ?? null,
        staffPhone: toE164UK(staffRow?.phone ?? null),
        twoCleaners: job?.twoCleaners ?? false,
        customerName: job?.customerName ?? null,
        postcode,
        date: job?.date ?? null,
        prettyDate: formatShortDate(job?.date ?? null),
        time: job?.displayTime || job?.startTime || null,
        estimatedHours: job?.estimatedHours ?? null,
        totalPrice: job?.totalPrice ?? null,
        staffPay,
      };

      await fetch('https://hooks.zapier.com/hooks/catch/22652608/u85wg6z/', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error('Failed to send Zapier assign webhook', e);
    }
  };

  const assignTwo = async (jobId: string, ids: string[]) => {
    const chosen = ids.slice(0, 2);
    const names = chosen.map(
      (id) =>
        staff.find((s) => s.id === id)?.name ||
        staff.find((s) => s.id === id)?.email ||
        'Staff Member'
    );

    // Always assign
    await updateDoc(doc(db, 'bookings', jobId), {
      assignedStaffIds: chosen,
      assignedStaffNames: names,
      assignedStaffId: chosen[0] ?? null, // legacy primary
      assignedStaffName: names[0] ?? null,
    });
    setAssignFor(null);
    setSelectedIds([]);

    // Ask if we should notify via Zapier
    const notify = window.confirm(
      'Do you want to send notifications to the selected staff?'
    );
    if (!notify) return;

    // Send Zapier webhook for two staff assignment
    try {
      const job = jobs.find((j) => j.id === jobId);
      const staffRows = chosen.map((id) => staff.find((s) => s.id === id));

      const postcode =
        typeof job?.address === 'string'
          ? job?.address || ''
          : job?.address?.postcode || '';

      const staffPay =
        job?.estimatedHours != null
          ? (job.estimatedHours * 12.21).toFixed(2)
          : '0.00';

      const payload = {
        trigger: 'booking_assigned',
        jobId,
        staffIds: chosen,
        staffNames: names,
        staffEmails: staffRows.map((r) => r?.email ?? null),
        staffPhones: staffRows.map((r) => toE164UK(r?.phone ?? null)),
        twoCleaners: job?.twoCleaners ?? false,
        customerName: job?.customerName ?? null,
        postcode,
        date: job?.date ?? null,
        prettyDate: formatShortDate(job?.date ?? null),
        time: job?.displayTime || job?.startTime || null,
        estimatedHours: job?.estimatedHours ?? null,
        totalPrice: job?.totalPrice ?? null,
        staffPay,
      };

      await fetch('https://hooks.zapier.com/hooks/catch/22652608/u85wg6z/', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error('Failed to send Zapier assign-two webhook', e);
    }
  };

  const unassign = async (jobId: string) => {
    try {
      await updateDoc(doc(db, 'bookings', jobId), {
        assignedStaffIds: [],
        assignedStaffNames: [],
        assignedStaffId: null,
        assignedStaffName: null,
      });
    } catch (e) {
      console.error('Failed to unassign booking', e);
      alert('Failed to unassign booking. See console.');
    }
  };

  function formatUKDate(ymd?: string) {
    if (!ymd) return '—';
    const [y, m, d] = (ymd || '').split('-').map(Number);
    if (!y || !m || !d) return ymd;
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  }

  // open assign modal and prefill selected (for two-cleaner)
  const openAssign = (j: Job) => {
    setAssignFor(j);
    const existing = getAssignedIds(j);
    setSelectedIds(existing.slice(0, 2));
  };

  const toggleChoose = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return prev; // max 2
      return [...prev, id];
    });
  };

  const staffLabel = (s: StaffRow) => s.name || s.email || 'Unnamed';

  return (
    <div className="space-y-8">
      {/* Unassigned */}
      <section>
        <h2 className="text-xl font-semibold mb-3 text-gray-900">
          Unassigned Bookings
        </h2>
        {pending.length === 0 ? (
          <div className="text-gray-500">No unassigned bookings.</div>
        ) : (
          <ul className="space-y-3">
            {pending.map((j) => (
              <li
                key={j.id}
                className="rounded-lg border bg-white p-4 shadow-sm"
              >
                {/* match myJobs / assigned layout: stack on mobile, side-by-side on md+ */}
                <div className="md:flex md:items-start md:justify-between md:gap-6">
                  {/* LEFT content */}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-gray-900 truncate">
                      {j.customerName || 'Customer'}
                    </div>
                    <div className="text-sm text-gray-700 truncate">
                      {j.displayAddress}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-700">
                      <div>
                        <span className="font-medium">
                          {formatUKDate(j.date)}
                        </span>
                        <span className="text-gray-500"> • </span>
                        <span>{j.displayTime || j.startTime || '—'}</span>
                      </div>
                      {j.twoCleaners && (
                        <span className="px-2 py-0.5 rounded bg-gray-50 border text-xs text-gray-700">
                          2 cleaners
                        </span>
                      )}
                    </div>

                    {typeof j.totalPrice === 'number' && (
                      <div className="mt-2">
                        <div className="text-sm font-semibold text-blue-600">
                          {money.format(j.totalPrice)}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* RIGHT actions – stacked below on mobile, right on md+ */}
                  <div className="mt-3 md:mt-0 flex-shrink-0 flex flex-col items-end gap-2 min-w-[180px]">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openAssign(j)}
                        className="cursor-pointer rounded-md bg-[#0071bc] px-3 py-2 text-white hover:opacity-95 text-sm"
                      >
                        Assign
                      </button>

                      <button
                        onClick={async () => {
                          // lazy import same as jobs page if you want; keeping as-is (downloadChecklist exists in your jobs page)
                          alert(
                            'Open the booking in the staff app to download checklist.'
                          );
                        }}
                        className="cursor-pointer rounded-md border px-3 py-2 text-gray-800 hover:bg-gray-50 text-sm"
                      >
                        Checklist
                      </button>

                      <button
                        onClick={() => setViewBooking(j)}
                        className="cursor-pointer rounded-md border px-3 py-2 text-gray-800 hover:bg-gray-50 text-sm"
                      >
                        View
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Assigned */}
      <section>
        <h2 className="text-xl font-semibold mb-3 text-gray-900">
          Assigned Bookings
        </h2>
        {assigned.length === 0 ? (
          <div className="text-gray-500">No assigned bookings.</div>
        ) : (
          <ul className="space-y-3">
            {assigned.map((j) => {
              const confirmed = isConfirmedBooking(j);
              return (
                <li
                  key={j.id}
                  className="rounded-lg bg-white p-4 shadow-sm"
                  style={{
                    borderLeft: `6px solid ${
                      confirmed ? '#16a34a' : '#f59e0b'
                    }`,
                    borderRight: '1px solid #e5e7eb',
                    borderTop: '1px solid #e5e7eb',
                    borderBottom: '1px solid #e5e7eb',
                  }}
                >
                  {/* match myJobs layout: stack on mobile, side-by-side on md+ */}
                  <div className="md:flex md:items-start md:justify-between md:gap-6">
                    {/* LEFT content */}
                    <div className="flex-1 min-w-0 space-y-3">
                      <div>
                        <div className="font-semibold text-gray-900 truncate">
                          {j.customerName || 'Customer'}
                        </div>
                        <div className="text-sm text-gray-700 truncate">
                          {j.displayAddress}
                        </div>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-700">
                        <span
                          className={`px-2 py-0.5 rounded-full border text-xs font-medium ${
                            confirmed
                              ? 'bg-green-50 text-green-700 border-green-200'
                              : 'bg-amber-50 text-amber-700 border-amber-200'
                          }`}
                        >
                          {confirmed ? 'Confirmed' : 'Awaiting confirmation'}
                        </span>
                        <div>
                          <span className="font-medium">
                            {formatUKDate(j.date)}
                          </span>
                          <span className="text-gray-500"> • </span>
                          <span>{j.displayTime || j.startTime || '—'}</span>
                        </div>
                      </div>

                      <div className="mt-1 text-sm text-gray-600">
                        {j.twoCleaners
                          ? `Assigned: ${
                              getAssignedNames(j).join(', ') || '—'
                            }`
                          : `Assigned to: ${
                              j.assignedStaffName || j.assignedStaffId || '—'
                            }`}
                      </div>

                      {typeof j.totalPrice === 'number' && (
                        <div className="mt-2">
                          <div className="text-sm font-semibold text-blue-600">
                            {money.format(j.totalPrice)}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* RIGHT actions – stacked below on mobile, right on md+ */}
                    <div className="mt-3 md:mt-0 flex-shrink-0 flex flex-col items-end gap-2 min-w-[180px]">
                      {/* (no tags here, just keep the buttons layout same pattern as myJobs) */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openAssign(j)}
                          className="cursor-pointer rounded-md bg-[#0071bc] px-3 py-2 text-white hover:opacity-95 text-sm"
                        >
                          Change Staff
                        </button>

                        <button
                          onClick={() => unassign(j.id)}
                          className="cursor-pointer rounded-md border border-red-500 text-red-600 px-3 py-2 hover:bg-red-50 text-sm"
                        >
                          Unassign
                        </button>

                        <button
                          onClick={() => setViewBooking(j)}
                          className="cursor-pointer rounded-md border px-3 py-2 text-gray-800 hover:bg-gray-50 text-sm"
                        >
                          View
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* VIEW BOOKING MODAL – UPDATED STYLING + ROOMS SECTION */}
      {viewBooking && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl overflow-auto max-h-[85vh]">
            {/* Header */}
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-gray-900">
                  {viewBooking.customerName || 'Customer'}
                </div>
                <div className="text-sm text-gray-600 mt-1">
                  Booking ID: {viewBooking.orderId || viewBooking.id}
                </div>
              </div>
              <button
                className="cursor-pointer rounded-md px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                onClick={() => setViewBooking(null)}
              >
                Close
              </button>
            </div>

            <div className="space-y-4 text-sm text-gray-800">
              {/* Customer & Contact */}
              <div className="rounded-xl border bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-gray-900 mb-3">
                  Customer & Contact
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">
                      Customer
                    </div>
                    <div className="text-sm text-gray-900">
                      {viewBooking.customerName || 'Customer'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">Phone</div>
                    <div className="text-sm text-gray-900">
                      {viewBooking.customerPhone || '—'}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-xs text-gray-600 mb-0.5">Address</div>
                    <div className="text-sm text-gray-900">
                      {typeof viewBooking.address === 'string'
                        ? viewBooking.address
                        : [
                            viewBooking.address?.line1,
                            viewBooking.address?.line2,
                            viewBooking.address?.town,
                            viewBooking.address?.county,
                            viewBooking.address?.postcode,
                          ]
                            .filter(Boolean)
                            .join(', ')}
                    </div>
                  </div>
                </div>
              </div>

              {/* Booking Details */}
              <div className="rounded-xl border bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-gray-900 mb-3">
                  Booking Details
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">Date</div>
                    <div className="text-sm text-gray-900">
                      {formatUKDate(viewBooking.date)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">Time</div>
                    <div className="text-sm text-gray-900">
                      {viewBooking.displayTime ||
                        viewBooking.startTime ||
                        viewBooking.timeSlot ||
                        '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">Service</div>
                    <div className="text-sm text-gray-900">
                      {viewBooking.serviceType || 'Cleaning Service'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">
                      Two Cleaners
                    </div>
                    <div className="text-sm text-gray-900">
                      {viewBooking.twoCleaners
                        ? 'Yes (2 required)'
                        : 'No (1 required)'}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-xs text-gray-600 mb-0.5">
                      Assigned Staff
                    </div>
                    <div className="text-sm text-gray-900">
                      {getAssignedNames(viewBooking).join(', ') || '—'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Rooms & Extras */}
              <div className="rounded-xl border bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-gray-900 mb-3">
                  Rooms & Extras
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <div className="text-xs text-gray-600 mb-0.5">
                      Rooms / Areas
                    </div>
                    <div className="text-sm text-gray-900">
                      {(() => {
                        // Prefer new booking-builder summaries (roomSummaries)
                        if (
                          Array.isArray(viewBooking.roomSummaries) &&
                          viewBooking.roomSummaries.length > 0
                        ) {
                          const rows = viewBooking.roomSummaries
                            .map((r, idx) => {
                              const count = Number(r.count ?? 0);
                              if (!count) return null;

                              const label =
                                r.label || labelRoomType(r.typeId);

                              const sizeNames = Array.isArray(r.sizes)
                                ? r.sizes
                                    .map((sid) => {
                                      const key = (sid || '').toLowerCase();
                                      return SIZE_LABELS[key] || sid;
                                    })
                                    .filter(Boolean)
                                : [];

                              const rightText =
                                sizeNames.length > 0
                                  ? `${count} room${
                                      count > 1 ? 's' : ''
                                    } (${sizeNames.join(', ')})`
                                  : `${count} room${count > 1 ? 's' : ''}`;

                              return (
                                <div
                                  key={idx}
                                  className="flex items-baseline justify-between gap-3"
                                >
                                  <span className="text-sm text-gray-900">
                                    {label}
                                  </span>
                                  <span className="text-xs text-gray-600 whitespace-nowrap">
                                    {rightText}
                                  </span>
                                </div>
                              );
                            })
                            .filter(Boolean);

                          if (rows.length > 0) {
                            return <div className="space-y-1">{rows}</div>;
                          }
                        }

                        // If we have structured roomSelections (office or older structured home),
                        // show a simple list with counts and sizes.
                        if (
                          Array.isArray(viewBooking.roomSelections) &&
                          viewBooking.roomSelections.length > 0
                        ) {
                          const items = viewBooking.roomSelections
                            .map((r, idx) => {
                              const count = Number(r.count ?? 0);
                              if (!count) return null;
                              const typeLabel = labelRoomType(r.typeId);
                              const sizeKey = (r.sizeId || '').toLowerCase();
                              const sizeLabel = SIZE_LABELS[sizeKey] || '';
                              return (
                                <li key={idx}>
                                  {count}× {typeLabel}
                                  {sizeLabel ? ` (${sizeLabel})` : ''}
                                </li>
                              );
                            })
                            .filter(Boolean);

                          if (items.length > 0) {
                            return (
                              <ul className="list-disc list-inside space-y-1">
                                {items}
                              </ul>
                            );
                          }
                        }

                        // Fallback: legacy home fields (bedrooms, bathrooms, etc.)
                        const b = parseCount(viewBooking.bedrooms);
                        const baths = parseCount(viewBooking.bathrooms);
                        const liv = parseCount(viewBooking.livingRooms);
                        const k = parseCount(viewBooking.kitchens);
                        const util = parseCount(viewBooking.utilityRooms);

                        const parts: string[] = [];
                        if (b)
                          parts.push(`${b} bedroom${b > 1 ? 's' : ''}`);
                        if (liv)
                          parts.push(
                            `${liv} living room${liv > 1 ? 's' : ''}`
                          );
                        if (k)
                          parts.push(
                            `${k} kitchen${k > 1 ? 's' : ''}`
                          );
                        if (baths)
                          parts.push(
                            `${baths} bathroom${baths > 1 ? 's' : ''}`
                          );
                        if (util)
                          parts.push(
                            `${util} utility room${util > 1 ? 's' : ''}`
                          );

                        if (parts.length) {
                          return (
                            <ul className="list-disc list-inside space-y-1">
                              {parts.map((p, i) => (
                                <li key={i}>{p}</li>
                              ))}
                            </ul>
                          );
                        }

                        if (Array.isArray(viewBooking.additionalRooms)) {
                          if (!viewBooking.additionalRooms.length) return '—';
                          return (
                            <ul className="list-disc list-inside space-y-1">
                              {viewBooking.additionalRooms.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          );
                        }

                        return viewBooking.additionalRooms ?? '—';
                      })()}
                    </div>

                    {(() => {
                      // For the new roomSummaries format we already show
                      // counts and sizes above, so don't repeat them.
                      if (
                        Array.isArray(viewBooking.roomSummaries) &&
                        viewBooking.roomSummaries.length > 0
                      ) {
                        return null;
                      }

                      // If we have structured roomSelections (new office / home format),
                      // summarise total sizes + toilets; otherwise, fall back to legacy office.rooms.
                      if (
                        Array.isArray(viewBooking.roomSelections) &&
                        viewBooking.roomSelections.length > 0
                      ) {
                        const sizeCounts: Record<string, number> = {};
                        for (const r of viewBooking.roomSelections) {
                          const key = (r.sizeId || '').toLowerCase();
                          const count = Number(r.count ?? 0);
                          if (!key || !count) continue;
                          sizeCounts[key] = (sizeCounts[key] || 0) + count;
                        }
                        const sizeParts = Object.entries(sizeCounts)
                          .filter(([k, v]) => v > 0 && SIZE_LABELS[k])
                          .map(
                            ([k, v]) =>
                              `${v} ${SIZE_LABELS[k]} room${v > 1 ? 's' : ''}`
                          );

                        // Toilets from new office format
                        let totalCubicles =
                          typeof viewBooking.totalCubicles === 'number'
                            ? viewBooking.totalCubicles
                            : 0;
                        if (
                          !totalCubicles &&
                          Array.isArray(viewBooking.toiletSelections)
                        ) {
                          totalCubicles = viewBooking.toiletSelections.reduce(
                            (sum, t) => sum + (Number(t.count ?? 0) || 0),
                            0
                          );
                        }
                        const toiletRooms =
                          typeof viewBooking.toiletRoomsCount === 'number'
                            ? viewBooking.toiletRoomsCount
                            : 0;
                        const toiletSizeKey = (
                          viewBooking.toiletSizeId || ''
                        ).toLowerCase();
                        const toiletSizeLabel =
                          SIZE_LABELS[toiletSizeKey] || '';

                        if (!sizeParts.length && !totalCubicles && !toiletRooms)
                          return null;

                        return (
                          <div className="mt-2 text-xs text-gray-600">
                            {sizeParts.length > 0 && (
                              <>
                                Room sizes:{' '}
                                <span className="text-gray-900 text-sm">
                                  {sizeParts.join(' · ')}
                                </span>
                              </>
                            )}
                            {(totalCubicles || toiletRooms) && (
                              <div className="mt-1">
                                Toilets:{' '}
                                <span className="text-gray-900 text-sm">
                                  {totalCubicles
                                    ? `${totalCubicles} cubicle${
                                        totalCubicles === 1 ? '' : 's'
                                      }`
                                    : ''}
                                  {totalCubicles && toiletRooms ? ' in ' : ''}
                                  {toiletRooms
                                    ? `${toiletRooms} room${
                                        toiletRooms === 1 ? '' : 's'
                                      }`
                                    : ''}
                                  {toiletSizeLabel
                                    ? ` (${toiletSizeLabel})`
                                    : ''}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      }

                      // Legacy path: office.rooms
                      const rooms = viewBooking.office?.rooms;
                      if (!Array.isArray(rooms) || rooms.length === 0)
                        return null;
                      const sizeCounts: Record<string, number> = {};
                      for (const r of rooms) {
                        const key = (r.sizeId || '').toLowerCase();
                        if (!key) continue;
                        sizeCounts[key] = (sizeCounts[key] || 0) + 1;
                      }
                      const sizeParts = Object.entries(sizeCounts)
                        .filter(([k, v]) => v > 0 && SIZE_LABELS[k])
                        .map(
                          ([k, v]) =>
                            `${v} ${SIZE_LABELS[k]} room${v > 1 ? 's' : ''}`
                        );
                      if (!sizeParts.length) return null;
                      return (
                        <div className="mt-2 text-xs text-gray-600">
                          Room sizes:{' '}
                          <span className="text-gray-900 text-sm">
                            {sizeParts.join(' · ')}
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">Add-ons</div>
                    <div className="text-sm text-gray-900">
                      {Array.isArray(viewBooking.addOns)
                        ? viewBooking.addOns.length
                          ? viewBooking.addOns.join(', ')
                          : 'None'
                        : viewBooking.addOns ?? 'None'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Pricing */}
              <div className="rounded-xl border bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-gray-900 mb-3">
                  Pricing
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">
                      Customer Price
                    </div>
                    <div className="text-sm text-gray-900">
                      {typeof viewBooking.totalPrice === 'number'
                        ? money.format(viewBooking.totalPrice)
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 mb-0.5">
                      Estimated Hours
                    </div>
                    <div className="text-sm text-gray-900">
                      {viewBooking.estimatedHours ?? '—'}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 text-right">
              <button
                onClick={() => setViewBooking(null)}
                className="rounded-md bg-[#0071bc] text-white px-3 py-2 hover:opacity-95"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign modal */}
      {assignFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold text-gray-900">
                {assignFor.assignedStaffId || getAssignedIds(assignFor).length
                  ? 'Change staff for'
                  : 'Assign booking'}{' '}
                — {assignFor.customerName || 'Customer'}
              </div>
              <button
                className="cursor-pointer rounded-md px-2 py-1 text-sm text-gray-700 hover:bg-gray-100"
                onClick={() => {
                  setAssignFor(null);
                  setSelectedIds([]);
                }}
              >
                Close
              </button>
            </div>

            {/* Single-cleaner: click assigns immediately (kept same).
                Two-cleaner: choose up to 2 and Save. */}
            <div className="max-h-[55vh] overflow-auto divide-y">
              {staff.length === 0 ? (
                <div className="p-3 text-sm text-gray-600">
                  No staff found.
                </div>
              ) : assignFor.twoCleaners ? (
                staff
                  .filter((s) => s.active !== false)
                  .map((s) => {
                    const checked = selectedIds.includes(s.id);
                    const disabled = !checked && selectedIds.length >= 2;
                    return (
                      <label
                        key={s.id}
                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left ${
                          disabled ? 'opacity-50' : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggleChoose(s.id)}
                          />
                          <div>
                            <div className="font-medium text-gray-900">
                              {staffLabel(s)}
                            </div>
                            <div className="text-xs text-gray-600">
                              {s.email || '—'}
                            </div>
                          </div>
                        </div>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          {checked ? 'Selected' : disabled ? 'Max 2' : 'Select'}
                        </span>
                      </label>
                    );
                  })
              ) : (
                staff
                  .filter((s) => s.active !== false)
                  .map((s) => (
                    <button
                      key={s.id}
                      className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-gray-50"
                      onClick={() =>
                        assignTo(assignFor.id, s.id, staffLabel(s))
                      }
                    >
                      <div>
                        <div className="font-medium text-gray-900">
                          {staffLabel(s)}
                        </div>
                        <div className="text-xs text-gray-600">
                          {s.email || '—'}
                        </div>
                      </div>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                        Assign
                      </span>
                    </button>
                  ))
              )}
            </div>

            {assignFor.twoCleaners && (
              <div className="mt-3 flex items-center justify-between">
                <div className="text-xs text-gray-600">
                  {selectedIds.length}/2 selected
                </div>
                <button
                  onClick={() => assignTwo(assignFor.id, selectedIds)}
                  disabled={selectedIds.length !== 2}
                  className={`px-3 py-2 rounded-md text-white text-sm ${
                    selectedIds.length === 2
                      ? 'bg-[#0071bc] hover:opacity-95'
                      : 'bg-[#0071bc]/50 cursor-not-allowed'
                  }`}
                >
                  Save (2 required)
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
