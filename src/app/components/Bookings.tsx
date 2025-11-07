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

type BookingDoc = {
  orderId: string;
  date: string;            // "YYYY-MM-DD"
  startTime: string;       // "14:00"
  endTime?: string;
  totalPrice?: number;
  customerName?: string;
  customerPhone?: string;
  address?: Address;
  bedrooms?: number | string;
  bathrooms?: number | string;
  livingRooms?: number | string;
  kitchens?: number | string;
  additionalRooms?: string[] | string;
  addOns?: string[] | string;
  estimatedHours?: number;
  cleanliness?: string;
  serviceType?: string;
  assignedStaffId?: string | null;
  assignedStaffName?: string | null;
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
  active?: boolean;
};

const money = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 2,
});

export default function Bookings() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [assignFor, setAssignFor] = useState<Job | null>(null);

  // live jobs (all bookings)
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

  // one-time staff list for modal
  useEffect(() => {
    async function loadStaff() {
      const snap = await getDocs(collection(db, 'staff'));
      const people: StaffRow[] = snap.docs.map((d) => {
        const s = d.data() as Record<string, unknown>;
        const name =
          typeof s.name === 'string' && s.name.trim()
            ? s.name
            : typeof s.firstName === 'string' || typeof s.lastName === 'string'
            ? `${(s.firstName as string | undefined) ?? ''} ${(s.lastName as string | undefined) ?? ''}`.trim()
            : undefined;
        return {
          id: d.id,
          name,
          email: (s.email as string | undefined) ?? undefined,
          active: s.active !== false,
        };
      });
      setStaff(people);
    }
    void loadStaff();
  }, []);

  const pending = useMemo(() => jobs.filter((j) => !j.assignedStaffId), [jobs]);
  const assigned = useMemo(() => jobs.filter((j) => !!j.assignedStaffId), [jobs]);

  const assignTo = async (jobId: string, staffId: string, staffName: string) => {
    await updateDoc(doc(db, 'bookings', jobId), {
      assignedStaffId: staffId,
      assignedStaffName: staffName || 'Staff Member',
    });
    setAssignFor(null);
  };

  // -------- PDF checklist (with logo.png, no order id/price, total pay from min wage) ----------
  async function downloadChecklist(job: Job) {
    const { default: jsPDF } = await import('jspdf');
    const docu = new jsPDF({ unit: 'pt', format: 'a4' }); // 595 x 842 pt

    const margin = 48;
    const pageW = docu.internal.pageSize.getWidth();
    let y = margin;

    const BLUE = '#0b63b6';
    const TEXT = '#111';

    const fmtLongDate = (ymd?: string) => {
      if (!ymd) return '';
      const [yStr, mStr, dStr] = ymd.split('-');
      const y = parseInt(yStr || '0', 10);
      const m = parseInt(mStr || '1', 10) - 1;
      const d = parseInt(dStr || '1', 10);
      const dt = new Date(y, m, d);
      return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    };

    const hoursBetween = (start?: string, end?: string) => {
      if (!start || !end) return 0;
      const toMin = (t: string) => {
        const [hh, mm = '0'] = t.split(':');
        return parseInt(hh || '0', 10) * 60 + parseInt(mm || '0', 10);
      };
      const diff = Math.max(0, toMin(end) - toMin(start));
      // round to nearest 0.5
      return Math.round((diff / 60) * 2) / 2;
    };

    const getAddress = () => {
      if (!job.address) return '';
      if (typeof job.address === 'string') return job.address;
      const { line1, line2, town, county, postcode } = job.address;
      return [line1, line2, town, county, postcode].filter(Boolean).join(', ');
    };

    // compute Total Pay (UK minimum wage x estimatedHours)
    const MIN_WAGE = 11.44;
    const estHours =
      typeof job.estimatedHours === 'number' && job.estimatedHours > 0
        ? job.estimatedHours
        : hoursBetween(job.startTime, job.endTime);
    const totalPay = Math.max(0, Math.round(estHours * MIN_WAGE * 100) / 100);

    // ----- Header with logo + company name -----
    try {
      const res = await fetch('/logo.png');
      const blob = await res.blob();
      const dataUrl: string = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(blob);
      });
      // slightly larger logo at the left
      docu.addImage(dataUrl, 'PNG', margin, y - 6, 56, 56);
    } catch {
      // ignore if logo missing
    }

    docu.setFont('helvetica', 'bold');
    docu.setFontSize(18);
    docu.setTextColor(BLUE);
    docu.text('LUXEN CLEANING', margin + 56 + 12, y + 10);
    docu.setFont('helvetica', 'normal');
    docu.setFontSize(12);
    docu.setTextColor('#1f2937');
    docu.text('Job Checklist', margin + 56 + 12, y + 30);
    y += 64;

    // divider
    docu.setDrawColor(229, 231, 235);
    docu.line(margin, y, pageW - margin, y);
    y += 16;

    // ----- Customer Details -----
    const drawH1 = (title: string) => {
      docu.setFont('helvetica', 'bold');
      docu.setFontSize(12);
      docu.setTextColor(17, 24, 39);
      docu.text(title, margin, y);
      y += 16;
      docu.setFont('helvetica', 'normal');
      docu.setTextColor(55, 65, 81);
    };

    const drawKV = (label: string, value: string) => {
      docu.setFont('helvetica', 'bold');
      docu.setFontSize(10);
      docu.setTextColor(17, 24, 39);
      docu.text(`${label}:`, margin, y);
      docu.setFont('helvetica', 'normal');
      docu.setTextColor(55, 65, 81);
      const labelW = docu.getTextWidth(`${label}:`);
      const textX = margin + labelW + 6;
      const maxW = pageW - margin - textX;
      const lines = docu.splitTextToSize(value || '—', maxW);
      docu.text(lines, textX, y);
      y += Math.max(16, 14 * (lines.length || 1));
    };

    drawH1('Customer Details');
    drawKV('Customer', job.customerName || '');
    drawKV('Address', getAddress());
    drawKV('Phone', job.customerPhone || '');

    y += 6;

    // ----- Job Details -----
    drawH1('Job Details');

    // Date (formatted) + Time (as provided)
    const dateTxt = fmtLongDate(job.date);
    const timeTxt = job.displayTime || job.startTime || '';

    drawKV('Date', dateTxt || '');
    drawKV('Time', timeTxt || '');
    drawKV('Service', job.serviceType || 'Cleaning Service');

    const roomsLine = [
      `${Number(job.bedrooms ?? 0)} bed`,
      `${Number(job.bathrooms ?? 0)} bath`,
      `${Number(job.livingRooms ?? 0)} living`,
      `${Number(job.kitchens ?? 0)} kitchen`,
    ].join(' · ');
    drawKV('Rooms', roomsLine);
    drawKV('Cleanliness', job.cleanliness || '');

    // Estimated Hours (if known)
    if (estHours) {
      drawKV('Estimated Hours', String(estHours));
    }

    // Total Pay (min wage x hours) – no calc shown, just the amount
    docu.setFont('helvetica', 'bold');
    docu.setFontSize(10);
    docu.setTextColor(17, 24, 39);
    docu.text('Total Pay:', margin, y);
    docu.setFont('helvetica', 'normal');
    docu.setTextColor(34, 197, 94);
    const payLabelW = docu.getTextWidth('Total Pay:');
    docu.text(`£${totalPay.toFixed(2)}`, margin + payLabelW + 6, y);
    y += 22;

    // Add-ons (as text line)
    const addOnsText = Array.isArray(job.addOns)
      ? job.addOns.join(', ')
      : (job.addOns || 'None');
    drawKV('Add-ons', addOnsText);

    // divider before tasks
    y += 6;
    docu.setDrawColor(229, 231, 235);
    docu.line(margin, y, pageW - margin, y);
    y += 18;

    // ----- Checklist sections (two columns, white checkboxes with black border) -----
    const drawTwoColList = (title: string, items: string[]) => {
      docu.setFont('helvetica', 'bold');
      docu.setFontSize(12);
      docu.setTextColor(17, 24, 39);
      docu.text(title, margin, y);
      y += 12;

      docu.setFont('helvetica', 'normal');
      docu.setFontSize(11);
      docu.setTextColor(55, 65, 81);

      const colGap = 28;
      const colWidth = (pageW - margin * 2 - colGap) / 2;
      const startY = y;
      let y1 = y;
      let y2 = y;

      const drawInCol = (item: string, left: number, yy: number) => {
        docu.setDrawColor(0);
        docu.setFillColor(255, 255, 255);
        docu.rect(left, yy - 9, 12, 12); // border only keeps it white
        const wrapped = docu.splitTextToSize(item, colWidth - 20);
        docu.text(wrapped, left + 18, yy);
        return yy + Math.max(16, 12 * wrapped.length + 4);
      };

      items.forEach((it, i) => {
        if (i % 2 === 0) y1 = drawInCol(it, margin, y1);
        else y2 = drawInCol(it, margin + colWidth + colGap, y2);
      });

      y = Math.max(y1, y2) + 10;
      // page overflow guard
      if (y > 800) {
        docu.addPage();
        y = margin;
      }
    };

    drawTwoColList('Entry & Hallway', [
      'Put on shoe covers (if required); knock, greet politely, confirm job scope & time.',
      'Place equipment neatly by the entrance.',
      'Tidy shoes/coats if asked.',
      'Vacuum/mop floors; wipe skirting boards and door handles.',
    ]);

    drawTwoColList('Kitchen', [
      'Load/unload dishwasher if asked; wash remaining dishes.',
      'Wipe worktops, splashbacks, cupboard doors and handles.',
      'Clean hob and front of oven; wipe appliances.',
      'Empty bins & replace liners; take rubbish out (if instructed).',
      'Vacuum/mop floor; leave sink & taps shining.',
    ]);

    drawTwoColList('Bathrooms', [
      'Spray & clean toilet (top to bottom) and base.',
      'Clean sink, taps, plugholes & polish mirrors.',
      'Scrub bath/shower, tiles & glass; rinse and dry.',
      'Wipe light switches; dust skirting & vents.',
      'Vacuum/mop floor; empty bin if needed.',
    ]);

    drawTwoColList('Bedrooms', [
      'Tidy surfaces; dust furniture & light fittings.',
      'Make bed/change linen if provided.',
      'Polish mirrors & glass.',
      'Vacuum/mop floor; under bed if accessible.',
      'Wipe skirting boards & door handles.',
    ]);

    drawTwoColList('Living Areas', [
      'Dust TV stand, coffee tables & accessible shelves.',
      'Polish glass surfaces & mirrors.',
      'Vacuum sofas (surface) and cushions if asked.',
      'Arrange cushions/throws neatly.',
      'Vacuum/mop floor; edges if reachable.',
    ]);

    drawTwoColList('Finishing Up', [
      'Walkthrough check with customer (if present).',
      'Return items to their places.',
      'Gather rubbish & recycling (if instructed).',
      'Pack equipment neatly.',
      'Confirm next visit if applicable.',
    ]);

    // footer
    docu.setFont('helvetica', 'normal');
    docu.setFontSize(10);
    docu.setTextColor('#64748b');
    docu.text('Thank you for choosing Luxen Cleaning.', margin, 820);

    const safeName = (job.customerName || 'Luxen_Checklist').replace(/[^\w\-]+/g, '_');
    docu.save(`${safeName}_Checklist.pdf`);
  }

  return (
    <div className="space-y-8">
      {/* Pending (unassigned) */}
      <section>
        <h2 className="text-xl font-semibold mb-3 text-gray-900">Unassigned Bookings</h2>
        {pending.length === 0 ? (
          <div className="text-gray-500">No unassigned bookings.</div>
        ) : (
          <ul className="space-y-3">
            {pending.map((j) => (
              <li key={j.id} className="rounded-lg border bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-gray-900">
                      {j.customerName || 'Customer'}
                    </div>
                    <div className="text-sm text-gray-700">{j.displayAddress}</div>
                    <div className="text-sm text-gray-700">
                      {j.date} • {j.displayTime}
                    </div>
                    {typeof j.totalPrice === 'number' && (
                      <div className="text-sm font-semibold text-blue-600">
                        {money.format(j.totalPrice)}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setAssignFor(j)}
                      className="cursor-pointer rounded-md bg-[#0071bc] px-3 py-2 text-white hover:opacity-95"
                    >
                      Assign
                    </button>
                    <button
                      onClick={() => downloadChecklist(j)}
                      className="cursor-pointer rounded-md border px-3 py-2 text-gray-800 hover:bg-gray-50"
                    >
                      Checklist
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Assigned */}
      <section>
        <h2 className="text-xl font-semibold mb-3 text-gray-900">Assigned Bookings</h2>
        {assigned.length === 0 ? (
          <div className="text-gray-500">No assigned bookings.</div>
        ) : (
          <ul className="space-y-3">
            {assigned.map((j) => (
              <li key={j.id} className="rounded-lg border bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-gray-900">
                      {j.customerName || 'Customer'}
                    </div>
                    <div className="text-sm text-gray-700">{j.displayAddress}</div>
                    <div className="text-sm text-gray-700">
                      {j.date} • {j.displayTime}
                    </div>
                    <div className="text-sm text-gray-600">
                      Assigned to: {j.assignedStaffName || j.assignedStaffId}
                    </div>
                  </div>

                  <button
                    onClick={() => downloadChecklist(j)}
                    className="cursor-pointer rounded-md border px-3 py-2 text-gray-800 hover:bg-gray-50"
                  >
                    Checklist
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Assign modal */}
      {assignFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold text-gray-900">
                Assign booking — {assignFor.customerName || 'Customer'}
              </div>
              <button
                className="cursor-pointer rounded-md px-2 py-1 text-sm text-gray-700 hover:bg-gray-100"
                onClick={() => setAssignFor(null)}
              >
                Close
              </button>
            </div>

            <div className="max-h-[55vh] overflow-auto divide-y">
              {staff.length === 0 ? (
                <div className="p-3 text-sm text-gray-600">No staff found.</div>
              ) : (
                staff
                  .filter((s) => s.active !== false)
                  .map((s) => (
                    <button
                      key={s.id}
                      className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-gray-50"
                      onClick={() =>
                        assignTo(assignFor.id, s.id, s.name || s.email || 'Staff Member')
                      }
                    >
                      <div>
                        <div className="font-medium text-gray-900">
                          {s.name || 'Unnamed'}
                        </div>
                        <div className="text-xs text-gray-600">{s.email || '—'}</div>
                      </div>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                        Select
                      </span>
                    </button>
                  ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
