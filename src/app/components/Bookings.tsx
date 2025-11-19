'use client';

import { useEffect, useMemo, useState } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
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

  // NEW: cancelled flag for UI sections
  cancelled?: boolean;
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

const staffRate = 12.21; // £/hour

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

// ========= Shared availability + calendar helpers (taken from home-clean) =========
type AnyAvail =
  | {
      available?: boolean;
      startTime?: string;
      endTime?: string;
      from?: string;
      to?: string;
    }
  | undefined
  | null;

const titleCaseDay = (lower: string) =>
  lower.charAt(0).toUpperCase() + lower.slice(1);

function getDayAvail(
  availObj: unknown,
  weekdayLower: string
): { available: boolean; start: string; end: string } | null {
  if (!availObj || typeof availObj !== 'object') return null;
  const obj = availObj as Record<string, unknown>;
  const a = (obj[weekdayLower] ?? obj[titleCaseDay(weekdayLower)]) as AnyAvail;
  if (!a || typeof a !== 'object') return null;

  const aRec = a as Record<string, unknown>;
  const available = !!aRec.available;
  const start =
    (aRec.startTime as string | undefined) ||
    (aRec.from as string | undefined) ||
    '07:00';
  const end =
    (aRec.endTime as string | undefined) ||
    (aRec.to as string | undefined) ||
    '20:00';
  return { available, start, end };
}

// Calendar / colour constants (same palette as home-clean)
const PRIMARY = '#0071bc';
const DATE_BG = '#4caf50';
const UNAVAILABLE_BG = '#f1f1f1';

const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// Slots from 07:00–20:00 (24h) – used for availability calculation
const ALL_TIMES = [
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
];

function toYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function displayHour(hStr: string) {
  const h = parseInt(hStr, 10);
  const twelve = h > 12 ? h - 12 : h;
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${twelve}:00 ${ap}`;
}

const timeToMinutes = (t: string) => {
  const [hh, mm = '0'] = t.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
};

const within = (x: number, a: number, b: number) => x >= a && x < b;

function isPastDate(ymd?: string) {
  if (!ymd) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return false;
  const booking = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  booking.setHours(0, 0, 0, 0);
  return booking < today;
}

// add N hours (can be decimal, e.g. 1.5) to "HH:MM" 24-hour string
function addHoursTo24Time(start: string, hours: number): string {
  const [hStr, mStr] = start.split(':');
  const baseH = Number(hStr);
  const baseM = Number(mStr);
  if (!Number.isFinite(baseH) || !Number.isFinite(baseM)) return start;
  const totalMinutes =
    baseH * 60 + baseM + Math.round(hours * 60); // supports decimals
  const wrapped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const endH = Math.floor(wrapped / 60);
  const endM = wrapped % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

// checklist PDF (staff pay + assigned cleaners)
async function downloadChecklist(job: Job) {
  const { jsPDF } = await import('jspdf');

  const A4_W = 595.28;
  const A4_H = 841.89;
  const M = 48;

  const BLUE = '#0a66b2';

  const BODY_SIZE = 8.8;
  const LINE_STEP = 15.5;
  const TITLE_SIZE = 13;
  const SUBTITLE_SIZE = 10.2;
  const MAIN_TITLE_SIZE = 21;

  const HR_GAP = 22;
  const TITLE_GAP = HR_GAP;
  const SECTION_GAP = 12;
  const ROW_GAP = 12;

  const BOX = 8;

  const STAFF_RATE = staffRate;

  const money = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 2,
  });

  // Decide if this is an office clean checklist
  const isOfficeChecklist =
    (job.serviceType || '').toLowerCase().includes('office');

  const fmtLongDate = (ymd: string) => {
    const [yy, mm, dd] = (ymd || '').split('-').map(Number);
    const dt = new Date(yy, (mm || 1) - 1, dd || 1);
    return dt.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  };

  const loadImage = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });

  const docPdf = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = M;

  const set = (
    font = 'helvetica',
    style: 'normal' | 'bold' | 'italic' = 'normal',
    size = BODY_SIZE,
    color = '#111'
  ) => {
    docPdf.setFont(font, style);
    docPdf.setFontSize(size);
    docPdf.setTextColor(color);
  };
  const hr = () => {
    docPdf.setDrawColor('#cfd8e3');
    docPdf.line(M, y, A4_W - M, y);
  };
  const split = (text: string, maxW: number) =>
    docPdf.splitTextToSize(text, maxW);

  const logo = await loadImage('/logo.png');
  const LOGO_H = 120;
  const logoW = (logo.width / logo.height) * LOGO_H;
  const headerCenterY = y + LOGO_H / 2;

  docPdf.addImage(logo, 'PNG', M, y, logoW, LOGO_H);

  const titleX = M + logoW + 18;
  set('helvetica', 'bold', MAIN_TITLE_SIZE, BLUE);
  docPdf.text('LUXEN CLEANING', titleX, headerCenterY - 8);
  set('helvetica', 'normal', SUBTITLE_SIZE, '#111');
  docPdf.text(
    isOfficeChecklist
      ? 'Office Cleaning Checklist'
      : 'Standard Home Cleaning Checklist',
    titleX,
    headerCenterY + 10
  );

  y += LOGO_H + 10;
  hr();
  y += HR_GAP;

  set('helvetica', 'bold', TITLE_SIZE, BLUE);
  docPdf.text('Customer Details', M, y);

  const detailGap = 16;
  const innerW = A4_W - 2 * M;
  const leftW = innerW * 0.3;
  const rightW = innerW * 0.7 - detailGap;

  const L = M;
  const R = M + leftW + detailGap;

  docPdf.text('Job Details', R, y);
  y += TITLE_GAP;

  const kvInline = (
    x: number,
    yy: number,
    label: string,
    value: string | number | undefined,
    width: number
  ) => {
    set('helvetica', 'normal', BODY_SIZE, '#111');
    const wrapped = split(`${label}: ${value ?? '—'}`, width);
    docPdf.text(wrapped, x, yy);
    const lines = Array.isArray(wrapped) ? wrapped.length : 1;
    return yy + Math.max(LINE_STEP, LINE_STEP * lines);
  };

  const custName = job.customerName || 'Customer';
  const addr =
    typeof job.address === 'string'
      ? job.address
      : [
          job.address?.line1,
          job.address?.line2,
          job.address?.town,
          job.address?.county,
          job.address?.postcode,
        ]
          .filter(Boolean)
          .join(', ');
  let yL = y;
  yL = kvInline(L, yL, 'Customer', custName, leftW);
  yL = kvInline(L, yL, 'Address', addr || '—', leftW);
  yL = kvInline(L, yL, 'Phone', job.customerPhone || '—', leftW);

  const showTime = job.displayTime || job.startTime || '—';
  const hours = Number(job.estimatedHours ?? 0) || 0;
  const pay = hours > 0 ? money.format(hours * STAFF_RATE) : '—';
  const cleaners = getAssignedNames(job).join(', ') || '—';

  // NEW: nicer rooms line using roomSummaries when present
  let roomsLine: string;
  if (Array.isArray(job.roomSummaries) && job.roomSummaries.length > 0) {
    const segments = job.roomSummaries
      .map((r) => {
        const label = r.label || labelRoomType(r.typeId);
        const sizes = Array.isArray(r.sizes) ? r.sizes : [];
        const sizeCounts: Record<string, number> = {};
        for (const sid of sizes) {
          const key = (sid || '').toLowerCase();
          if (!key) continue;
          sizeCounts[key] = (sizeCounts[key] || 0) + 1;
        }
        const totalRooms = Number(r.count ?? sizes.length ?? 0) || 0;

        if (!totalRooms) return null;

        if (Object.keys(sizeCounts).length > 0) {
          const sizeText = Object.entries(sizeCounts)
            .map(([key, count]) => {
              const sizeName = SIZE_LABELS[key] || key;
              return `${count} ${sizeName}`;
            })
            .join(', ');
          return `${label}: ${totalRooms} room${
            totalRooms > 1 ? 's' : ''
          } (${sizeText})`;
        }

        return `${label}: ${totalRooms} room${totalRooms > 1 ? 's' : ''}`;
      })
      .filter(Boolean) as string[];

    roomsLine = segments.length ? segments.join(' · ') : 'Not set';
  } else {
    const b = parseCount(job.bedrooms);
    const baths = parseCount(job.bathrooms);
    const liv = parseCount(job.livingRooms);
    const k = parseCount(job.kitchens);

    const parts: string[] = [];
    if (b) parts.push(`${b} bed${b > 1 ? 's' : ''}`);
    if (baths) parts.push(`${baths} bath${baths > 1 ? 's' : ''}`);
    if (liv) parts.push(`${liv} living`);
    if (k) parts.push(`${k} kitchen${k > 1 ? 's' : ''}`);

    roomsLine = parts.length ? parts.join(' · ') : 'Not set';
  }

  let yR = y;
  yR = kvInline(
    R,
    yR,
    'Date',
    job.date ? fmtLongDate(job.date) : '—',
    rightW
  );
  yR = kvInline(R, yR, 'Time', showTime, rightW);
  yR = kvInline(
    R,
    yR,
    'Service',
    job.serviceType || 'Cleaning Service',
    rightW
  );
  yR = kvInline(R, yR, 'Rooms', roomsLine, rightW);
  yR = kvInline(R, yR, 'Cleanliness', job.cleanliness || '—', rightW);
  yR = kvInline(
    R,
    yR,
    'Estimated Hours',
    hours ? String(hours) : '—',
    rightW
  );
  yR = kvInline(R, yR, 'Assigned Cleaners', cleaners, rightW);
  yR = kvInline(R, yR, 'Your Pay', pay, rightW);

  y = Math.max(yL, yR) + 8;
  hr();
  y += HR_GAP;

  const checkboxLine = (
    x: number,
    yy: number,
    text: string,
    width: number
  ) => {
    const rectY = yy - BOX + BODY_SIZE * 0.48;
    docPdf.setDrawColor(0);
    docPdf.setFillColor(255, 255, 255);
    docPdf.rect(x, rectY, BOX, BOX, 'FD');

    set('helvetica', 'normal', BODY_SIZE, '#111');
    const wrapped = split(text, width - (BOX + 12));
    docPdf.text(wrapped, x + BOX + 7, yy);

    const lines = Array.isArray(wrapped) ? wrapped.length : 1;
    return yy + Math.max(LINE_STEP, LINE_STEP * lines);
  };

  const section = (
    title: string,
    items: string[],
    x: number,
    yy: number,
    width: number
  ) => {
    set('helvetica', 'bold', TITLE_SIZE, BLUE);
    docPdf.text(title, x, yy);
    yy += TITLE_GAP;
    let cur = yy;
    for (const it of items) cur = checkboxLine(x, cur, it, width);
    return cur + SECTION_GAP;
  };

  const colGap2 = 28;
  const colW2 = (A4_W - M * 2 - colGap2) / 2;

  // HOME vs OFFICE checklist items & section titles
  const entry_items = isOfficeChecklist
    ? [
        'Sign in on site if required and wear ID / PPE',
        'Tidy entrance and reception desk surfaces',
        'Clean glass doors and high-touch points (handles, rails, buzzers)',
        'Spot clean internal doors, light switches and skirting',
        'Vacuum/mop reception and entrance floors',
      ]
    : [
        'Put on shoe covers (if required)',
        'Knock, greet politely, confirm job scope & time',
        'Place equipment neatly by the entrance',
        'Tidy shoes/coats if asked; clear floor area',
        'Vacuum/mop floors; wipe skirting boards and door handles',
      ];
  const kitchen_items = isOfficeChecklist
    ? [
        'Wash up or load/unload dishwasher as requested',
        'Wipe worktops, cupboard fronts and handles in kitchen/break area',
        'Clean fronts of appliances (microwave, fridge, kettles, vending)',
        'Empty food and recycling bins; replace liners',
        'Vacuum/mop kitchen/break area floors',
      ]
    : [
        'Load/unload dishwasher if asked; wash remaining dishes',
        'Wipe worktops, splashbacks, cupboard doors and handles',
        'Clean hob and front of oven; wipe appliances (kettle, microwave)',
        'Empty bins & replace liners; take rubbish out (if instructed)',
        'Vacuum/mop floor; leave sink & taps shining',
      ];
  const bathroom_items = isOfficeChecklist
    ? [
        'Clean and disinfect toilets, urinals and fittings (top to bottom)',
        'Clean sinks, taps, splashbacks and polish mirrors',
        'Wipe and disinfect cubicle doors, partitions & touchpoints',
        'Empty sanitary and general bins; replace liners if required',
        'Mop floors with appropriate disinfectant; leave dry where possible',
      ]
    : [
        'Spray & clean toilet (top to bottom) and base',
        'Clean sink, taps, plugholes & polish mirrors',
        'Wipe shower/bath, screen/tiles; rinse & squeegee',
        'Wipe light switches, door handles & skirting',
        'Vacuum/mop floor; leave surfaces dry & tidy',
      ];
  const bedroom_items = isOfficeChecklist
    ? [
        'Tidy desks and tables (move light items only)',
        'Dust and wipe reachable surfaces, window sills and ledges',
        'Straighten chairs and meeting room layouts',
        'Empty paper bins; replace liners where needed',
        'Vacuum/mop floors including under desks where reachable',
      ]
    : [
        'Tidy surfaces; dust reachable areas and skirting',
        'Make bed/change bedding if clean bedding provided',
        'Wipe mirrors & glass surfaces',
        'Empty small bins (if present)',
        'Vacuum/mop floors; check under bed reachable area',
      ];
  const living_items = isOfficeChecklist
    ? [
        'Dust handrails, skirting and ledges in corridors and stairs',
        'Spot clean walls and high-touch points (switches, door plates)',
        'Check and tidy waiting/seating areas',
        'Empty corridor/landing bins if present',
        'Vacuum/mop corridors and stair treads/landings',
      ]
    : [
        'Tidy and dust surfaces, TV stand, shelves (reachable)',
        'Wipe coffee table and reachable glass',
        'Fluff cushions & fold throws neatly',
        'Wipe light switches, door handles & skirting',
        'Vacuum/mop floors and visible edges',
      ];
  const finish_items = isOfficeChecklist
    ? [
        'Quick walk-through of key areas; check nothing missed',
        'Ensure bins are re-lined and waste taken to agreed point',
        'Check windows are closed and internal doors left as instructed',
        'Turn off lights (unless instructed otherwise) and secure alarm if required',
        'Return keys/fobs to agreed location and sign out if required',
      ]
    : [
        'Walk-through with customer (if present) & confirm satisfaction',
        'Check lights off, windows closed (unless instructed)',
        'Take rubbish/recycling out if instructed',
        'Pack equipment, leave entry tidy',
        'Note any damages/issues in app/notes',
      ];

  const entryTitle = isOfficeChecklist ? 'Reception & Entrance' : 'Entry & Hallway';
  const kitchenTitle = isOfficeChecklist ? 'Kitchens / Break Areas' : 'Kitchen';
  const bathroomTitle = isOfficeChecklist ? 'Toilets & Washrooms' : 'Bathrooms';
  const bedroomTitle = isOfficeChecklist ? 'Offices & Meeting Rooms' : 'Bedrooms';
  const livingTitle = isOfficeChecklist ? 'Corridors & Shared Areas' : 'Living Areas';
  const finishTitle = isOfficeChecklist ? 'Closing Checks' : 'Finishing Up';

  let yL1 = section(entryTitle, entry_items, M, y, colW2);
  let yR1 = section(kitchenTitle, kitchen_items, M + colW2 + colGap2, y, colW2);
  y = Math.max(yL1, yR1) + ROW_GAP;

  let yL2 = section(bathroomTitle, bathroom_items, M, y, colW2);
  let yR2 = section(bedroomTitle, bedroom_items, M + colW2 + colGap2, y, colW2);
  y = Math.max(yL2, yR2) + ROW_GAP;

  let yL3 = section(livingTitle, living_items, M, y, colW2);
  let yR3 = section(finishTitle, finish_items, M + colW2 + colGap2, y, colW2);
  y = Math.max(yL3, yR3);

  const footerY = Math.min(A4_H - 22, y + 20);
  set('helvetica', 'italic', 9, '#555');
  docPdf.text('Thank you for choosing Luxen Cleaning.', M, footerY);

  const pc =
    typeof job.address === 'string' ? '' : job.address?.postcode ?? '';
  docPdf.save(`${job.customerName ?? 'Customer'} (${pc}) Checklist.pdf`);
}


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
  // Month range for reschedule calendar (same as home-clean)
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const maxMonth = new Date(now.getFullYear(), now.getMonth() + 3, 1);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [assignFor, setAssignFor] = useState<Job | null>(null);

  // NEW: selection state for two-cleaner jobs
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // view modal state
  const [viewBooking, setViewBooking] = useState<Job | null>(null);

  // NEW: reschedule modal state
  const [rescheduleFor, setRescheduleFor] = useState<Job | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedTime, setSelectedTime] = useState<string>('');
  const [viewMonth, setViewMonth] = useState<Date>(startMonth);
  const [availableTimes, setAvailableTimes] = useState<string[]>([]);
  const [timesLoading, setTimesLoading] = useState(false);
  const [blockedDates, setBlockedDates] = useState<Set<string>>(new Set());

  // calendar grid for reschedule modal (same structure as home-clean)
  const grid = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const startOffset = (first.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(
      viewMonth.getFullYear(),
      viewMonth.getMonth() + 1,
      0
    ).getDate();
    const cells: { d: number; date?: Date; muted?: boolean }[] = [];
    for (let i = 0; i < startOffset; i++) cells.push({ d: 0, muted: true });
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({
        d,
        date: new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d),
      });
    }
    while (cells.length % 7) cells.push({ d: 0, muted: true });
    return cells;
  }, [viewMonth]);

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

  // when opening reschedule modal, initialise calendar + date state
  useEffect(() => {
    if (rescheduleFor) {
      const [y, m, d] = (rescheduleFor.date || '').split('-').map(Number);
      const base = y && m && d ? new Date(y, m - 1, d) : new Date();
      base.setHours(0, 0, 0, 0);
      setSelectedDate(base);
      setViewMonth(new Date(base.getFullYear(), base.getMonth(), 1));
    } else {
      setSelectedDate(null);
      setSelectedTime('');
    }
  }, [rescheduleFor]);

  // compute blocked days (same logic as home-clean calendar)
  useEffect(() => {
    async function computeBlockedDays() {
      try {
        const staffSnap = await getDocs(collection(db, 'staff'));
        const staffDocs = staffSnap.docs
          .map((d) => d.data())
          .filter((s) => (s as any).active !== false);

        const blocked = new Set<string>();
        const today0 = new Date();
        today0.setHours(0, 0, 0, 0);

        const globalMinNotice =
          staffDocs.length > 0
            ? Math.min(
                ...staffDocs.map((s: Record<string, unknown>) =>
                  Number(s['minNoticeHours'] ?? 12)
                )
              )
            : 12;

        for (let i = -30; i < 60; i++) {
          const dt = new Date();
          dt.setDate(today0.getDate() + i);
          dt.setHours(0, 0, 0, 0);
          const key = toYMD(dt);
          const weekday = dt
            .toLocaleDateString('en-GB', { weekday: 'long' })
            .toLowerCase();

          if (dt < today0) {
            blocked.add(key);
            continue;
          }

          const staffAvailableToday = (staffDocs as Record<string, unknown>[]).some(
            (s) => {
              const av = getDayAvail((s as any).availability, weekday);
              return av?.available === true;
            }
          );
          if (!staffAvailableToday) {
            blocked.add(key);
            continue;
          }

          const cutoff = new Date(Date.now() + globalMinNotice * 3600_000);
          const endOfDay = new Date(dt);
          endOfDay.setHours(20, 0, 0, 0);
          if (endOfDay < cutoff) {
            blocked.add(key);
            continue;
          }
        }

        setBlockedDates(blocked);
      } catch {
        setBlockedDates(new Set());
      }
    }
    computeBlockedDays();
  }, []);

  // load available times for selectedDate (same logic as home-clean)
  useEffect(() => {
    async function loadTimes() {
      setSelectedTime('');
      setTimesLoading(true);
      try {
        if (!selectedDate) {
          setAvailableTimes([]);
          return;
        }
        const key = toYMD(selectedDate);
        if (blockedDates.has(key)) {
          setAvailableTimes([]);
          return;
        }

        // legacy unavailability doc support
        const ref = doc(db, 'unavailability', key);
        const snap = await getDoc(ref);
        const bookedLegacy = new Set<string>();
        if (snap.exists()) {
          const data = snap.data() as Record<string, unknown>;
          const booked = data['bookedTimeSlots'] as
            | Record<string, unknown>
            | undefined;
          if (booked && typeof booked === 'object') {
            for (const t of Object.keys(booked)) {
              if (Boolean(booked[t])) bookedLegacy.add(t);
            }
          } else {
            for (let h = 7; h <= 20; h++) {
              const kk = `${h}:00`;
              if (Boolean((data as any)[kk])) bookedLegacy.add(kk);
            }
          }
        }

        const bookingsSnap = await getDocs(
          query(collection(db, 'bookings'), where('date', '==', key))
        );
        // Exclude the booking we're currently rescheduling so it doesn't block its own slot
        const bookings = bookingsSnap.docs
          .filter((d) => !rescheduleFor || d.id !== rescheduleFor.id)
          .map((d) => d.data() as Record<string, unknown>);

        const staffSnap = await getDocs(collection(db, 'staff'));
        const staffDocs = staffSnap.docs
          .map((d) => d.data() as Record<string, unknown>)
          .filter((s) => s['active'] !== false);

        const weekday = selectedDate
          .toLocaleDateString('en-GB', { weekday: 'long' })
          .toLowerCase();
        const dayStaff = staffDocs.filter((s) => {
          const av = getDayAvail((s as any).availability, weekday);
          return av?.available === true;
        });

        if (dayStaff.length === 0) {
          setAvailableTimes([]);
          return;
        }

        const minNotice = Math.min(
          ...dayStaff.map((s) => {
            const v = Number(s['minNoticeHours']);
            return Number.isFinite(v) ? v : 12;
          })
        );
        const noticeCutoff = new Date(Date.now() + minNotice * 3600_000);

        const candidate = ALL_TIMES.map((h) => `${h}:00`).filter(
          (k) => !bookedLegacy.has(k)
        );
        const refined: string[] = [];

        for (const k of candidate) {
          const [hh] = k.split(':');
          const slotDt = new Date(selectedDate);
          slotDt.setHours(parseInt(hh, 10), 0, 0, 0);
          if (slotDt < noticeCutoff) continue;
          const slotMins = timeToMinutes(k);
          let atLeastOne = false;

          for (const s of dayStaff) {
            const av = getDayAvail((s as any).availability, weekday);
            if (!av || !av.available) continue;
            const startM = timeToMinutes(av.start);
            const endM = timeToMinutes(av.end);
            if (!within(slotMins, startM, endM)) continue;
            const buffer = Number((s as any)['travelBufferMins'] ?? 30);
            const collides = bookings.some((b) => {
              if (!b['startTime'] || !b['endTime']) return false;
              const bs = timeToMinutes(b['startTime'] as string);
              const be = timeToMinutes(b['endTime'] as string);
              const bsExp = Math.max(0, bs - buffer);
              const beExp = be + buffer;
              return within(slotMins, bsExp, beExp);
            });
            if (!collides) {
              atLeastOne = true;
              break;
            }
          }

          if (atLeastOne) refined.push(k.split(':')[0]);
        }

        setAvailableTimes(refined);
      } catch (e) {
        console.error('Failed to load timeslots for reschedule:', e);
        setAvailableTimes([]);
      } finally {
        setTimesLoading(false);
      }
    }

    if (rescheduleFor) {
      void loadTimes();
    } else {
      setAvailableTimes([]);
      setTimesLoading(false);
    }
  }, [selectedDate, blockedDates, rescheduleFor]);

  // partition jobs by status
  const activeJobs = useMemo(
    () => jobs.filter((j) => !j.cancelled),
    [jobs]
  );

  // pending if not fully assigned for its required cleaners, future only
  const pending = useMemo(
    () =>
      activeJobs.filter(
        (j) =>
          !isPastDate(j.date) &&
          getAssignedIds(j).length < requiredCleaners(j)
      ),
    [activeJobs]
  );
  const assigned = useMemo(
    () =>
      activeJobs.filter(
        (j) =>
          !isPastDate(j.date) &&
          getAssignedIds(j).length >= requiredCleaners(j)
      ),
    [activeJobs]
  );

  const completed = useMemo(
    () => activeJobs.filter((j) => isPastDate(j.date)),
    [activeJobs]
  );

  const cancelledJobs = useMemo(
    () => jobs.filter((j) => j.cancelled),
    [jobs]
  );

  const assignTo = async (
    jobId: string,
    staffId: string,
    staffName: string
  ) => {
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

// NEW: cancel booking + Zapier notification if it was assigned
const cancelBooking = async (jobId: string) => {
  // Look up the job in current state
  const job = jobs.find((j) => j.id === jobId) || null;

  // Check if it was assigned to anyone
  const hadAssignment =
    !!job &&
    (getAssignedIds(job).length > 0 ||
      !!job.assignedStaffId ||
      !!job.assignedStaffName);

  try {
    // Mark as cancelled and clear staff on Firestore
    await updateDoc(doc(db, 'bookings', jobId), {
      cancelled: true,
      assignedStaffIds: [],
      assignedStaffNames: [],
      assignedStaffId: null,
      assignedStaffName: null,
      confirmedStaffIds: [],
    });

    // If there *was* an assignment, fire Zapier hook
    if (job && hadAssignment) {
      try {
        const assignedIds = getAssignedIds(job);
        const assignedNames = getAssignedNames(job);

        const assignedStaffRows = assignedIds.map((id) =>
          staff.find((s) => s.id === id)
        );

        const postcode =
          typeof job.address === 'string'
            ? job.address
            : job.address?.postcode ?? '';

        const payload = {
          trigger: 'booking_cancelled',
          jobId: job.id,
          orderId: job.orderId ?? null,
          date: job.date ?? null,
          prettyDate: formatShortDate(job.date ?? null),
          time: job.displayTime || job.startTime || null,
          customerName: job.customerName ?? null,
          postcode,
          staffIds: assignedIds,
          staffNames: assignedNames,
          staffEmails: assignedStaffRows.map((s) => s?.email ?? null),
          staffPhones: assignedStaffRows.map((s) =>
            toE164UK(s?.phone ?? null)
          ),
        };

        await fetch('https://hooks.zapier.com/hooks/catch/22652608/uz2g97n/', {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.error('Failed to send Zapier cancel webhook', err);
        // No alert so cancelling still "succeeds" from the UI point of view
      }
    }
  } catch (e) {
    console.error('Failed to cancel booking', e);
    alert('Failed to cancel booking. See console.');
  }
};


  // NEW: confirm reschedule – now using real availability slots + updating endTime in 24h
  const confirmReschedule = async () => {
    if (!rescheduleFor || !selectedDate || !selectedTime) return;
    try {
      const newDate = toYMD(selectedDate);

      // selectedTime is an hour string like "7", "14" – convert to HH:MM
      const newStart24 = `${String(parseInt(selectedTime, 10)).padStart(
        2,
        '0'
      )}:00`;

      // compute new end time from estimated hours if available,
      // otherwise keep same duration as existing booking (if set)
      let newEnd24: string | undefined;

      if (
        typeof rescheduleFor.estimatedHours === 'number' &&
        rescheduleFor.estimatedHours > 0
      ) {
        newEnd24 = addHoursTo24Time(
          newStart24,
          rescheduleFor.estimatedHours
        );
      } else if (rescheduleFor.startTime && rescheduleFor.endTime) {
        const startM = timeToMinutes(rescheduleFor.startTime);
        const endM = timeToMinutes(rescheduleFor.endTime);
        const durationHours = Math.max(0, (endM - startM) / 60);
        if (durationHours > 0) {
          newEnd24 = addHoursTo24Time(newStart24, durationHours);
        }
      }

      const endTimeToSave =
        newEnd24 ?? rescheduleFor.endTime ?? null;

      await updateDoc(doc(db, 'bookings', rescheduleFor.id), {
        date: newDate,
        startTime: newStart24,
        endTime: endTimeToSave,
        timeSlot: selectedTime, // keep simple hour label if needed elsewhere
        cancelled: false,
        assignedStaffIds: [],
        assignedStaffNames: [],
        assignedStaffId: null,
        assignedStaffName: null,
        confirmedStaffIds: [],
      });
      setRescheduleFor(null);
    } catch (e) {
      console.error('Failed to reschedule booking', e);
      alert('Failed to reschedule booking. See console.');
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
                  <div className="mt-3 md:mt-0 flex-shrink-0 flex flex-col items-end gap-2 min-w-[220px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => openAssign(j)}
                        className="cursor-pointer rounded-md bg-[#0071bc] px-3 py-2 text-white hover:opacity-95 text-sm"
                      >
                        Assign
                      </button>

                      <button
                        onClick={() => downloadChecklist(j)}
                        className="bg-[#0071bc] text-white px-3 py-2 rounded-md hover:opacity-95 text-sm"
                      >
                        Checklist
                      </button>

                      <button
                        onClick={() => cancelBooking(j.id)}
                        className="cursor-pointer rounded-md border border-red-500 text-red-600 px-3 py-2 hover:bg-red-50 text-sm"
                      >
                        Cancel
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
                    <div className="mt-3 md:mt-0 flex-shrink-0 flex flex-col items-end gap-2 min-w-[260px]">
                      {/* (no tags here, just keep the buttons layout same pattern as myJobs) */}
                      <div className="flex flex-wrap items-center gap-2">
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
                          onClick={() => downloadChecklist(j)}
                          className="bg-[#0071bc] text-white px-3 py-2 rounded-md hover:opacity-95 text-sm"
                        >
                          Checklist
                        </button>

                        <button
                          onClick={() => cancelBooking(j.id)}
                          className="cursor-pointer rounded-md border border-red-500 text-red-600 px-3 py-2 hover:bg-red-50 text-sm"
                        >
                          Cancel
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

      {/* Completed */}
      <section>
        <h2 className="text-xl font-semibold mb-3 text-gray-900">
          Completed Bookings
        </h2>
        {completed.length === 0 ? (
          <div className="text-gray-500">No completed bookings.</div>
        ) : (
          <ul className="space-y-3">
            {completed.map((j) => (
              <li
                key={j.id}
                className="rounded-lg bg-white p-4 shadow-sm"
                style={{
                  borderLeft: '6px solid #9ca3af',
                  borderRight: '1px solid #e5e7eb',
                  borderTop: '1px solid #e5e7eb',
                  borderBottom: '1px solid #e5e7eb',
                }}
              >
                <div className="md:flex md:items-start md:justify-between md:gap-6">
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
                      <span className="px-2 py-0.5 rounded-full border bg-gray-50 text-gray-700 border-gray-200 text-xs font-medium">
                        Completed
                      </span>
                      <div>
                        <span className="font-medium">
                          {formatUKDate(j.date)}
                        </span>
                        <span className="text-gray-500"> • </span>
                        <span>{j.displayTime || j.startTime || '—'}</span>
                      </div>
                    </div>

                    {typeof j.totalPrice === 'number' && (
                      <div className="mt-2">
                        <div className="text-sm font-semibold text-blue-600">
                          {money.format(j.totalPrice)}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 md:mt-0 flex-shrink-0 flex flex-col items-end gap-2 min-w-[180px]">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setRescheduleFor(j)}
                        className="cursor-pointer rounded-md bg-[#0071bc] px-3 py-2 text-white hover:opacity-95 text-sm"
                      >
                        Reschedule
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

      {/* Cancelled */}
      <section>
        <h2 className="text-xl font-semibold mb-3 text-gray-900">
          Cancelled Bookings
        </h2>
        {cancelledJobs.length === 0 ? (
          <div className="text-gray-500">No cancelled bookings.</div>
        ) : (
          <ul className="space-y-3">
            {cancelledJobs.map((j) => (
              <li
                key={j.id}
                className="rounded-lg bg-white p-4 shadow-sm"
                style={{
                  borderLeft: '6px solid #dc2626',
                  borderRight: '1px solid #e5e7eb',
                  borderTop: '1px solid #e5e7eb',
                  borderBottom: '1px solid #e5e7eb',
                }}
              >
                <div className="md:flex md:items-start md:justify-between md:gap-6">
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
                      <span className="px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-200 text-xs font-medium">
                        Cancelled
                      </span>
                      <div>
                        <span className="font-medium">
                          {formatUKDate(j.date)}
                        </span>
                        <span className="text-gray-500"> • </span>
                        <span>{j.displayTime || j.startTime || '—'}</span>
                      </div>
                    </div>

                    {typeof j.totalPrice === 'number' && (
                      <div className="mt-2">
                        <div className="text-sm font-semibold text-blue-600">
                          {money.format(j.totalPrice)}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 md:mt-0 flex-shrink-0 flex flex-col items-end gap-2 min-w-[180px]">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setRescheduleFor(j)}
                        className="cursor-pointer rounded-md bg-[#0071bc] px-3 py-2 text-white hover:opacity-95 text-sm"
                      >
                        Reschedule
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

            <div className="space-y-4 text-sm">
              {/* Customer & Contact */}
              <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
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
                    <div className="text-xs text-gray-600 mb-0.5">
                      Address
                    </div>
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
                    <div className="text-xs text-gray-600 mb-0.5">
                      Service
                    </div>
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
                                  : `${count} room${
                                      count > 1 ? 's' : ''
                                    }`;

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
                          parts.push(
                            `${b} bedroom${b > 1 ? 's' : ''}`
                          );
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
                              `${v} ${SIZE_LABELS[k]} room${
                                v > 1 ? 's' : ''
                              }`
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
                            `${v} ${SIZE_LABELS[k]} room${
                              v > 1 ? 's' : ''
                            }`
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
                    <div className="text-xs text-gray-600 mb-0.5">
                      Add-ons
                    </div>
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
                className="cursor-pointer rounded-md bg-[#0071bc] text-white px-3 py-2 hover:opacity-95"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RESCHEDULE MODAL */}
      {rescheduleFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-xl bg-white p-5 shadow-xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Reschedule Booking
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  {rescheduleFor.customerName || 'Customer'} — Booking ID:{' '}
                  {rescheduleFor.orderId || rescheduleFor.id}
                </p>
              </div>
              <button
                onClick={() => setRescheduleFor(null)}
                className="cursor-pointer rounded-md px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                Close
              </button>
            </div>

            {/* Calendar – same availability behaviour as customer booking form */}
            <div className="rounded-xl border bg-white p-4 shadow-sm mb-4">
              <div className="mb-3 flex items-center justify-between">
                <button
                  className="rounded-md px-4 py-2 text-sm font-normal cursor-pointer hover:opacity-90 disabled:opacity-60"
                  style={{
                    backgroundColor: UNAVAILABLE_BG,
                    color: PRIMARY,
                  }}
                  onClick={() =>
                    setViewMonth(
                      new Date(
                        viewMonth.getFullYear(),
                        viewMonth.getMonth() - 1,
                        1
                      )
                    )
                  }
                  disabled={toYMD(viewMonth) === toYMD(startMonth)}
                >
                  &lt; Prev
                </button>

                <div
                  className="text-sm"
                  style={{ color: PRIMARY, fontWeight: 400 }}
                >
                  {monthNames[viewMonth.getMonth()]}{' '}
                  {viewMonth.getFullYear()}
                </div>

                <button
                  className="rounded-md px-4 py-2 text-sm font-normal cursor-pointer hover:opacity-90 disabled:opacity-60"
                  style={{
                    backgroundColor: UNAVAILABLE_BG,
                    color: PRIMARY,
                  }}
                  onClick={() =>
                    setViewMonth(
                      new Date(
                        viewMonth.getFullYear(),
                        viewMonth.getMonth() + 1,
                        1
                      )
                    )
                  }
                  disabled={
                    viewMonth.getFullYear() === maxMonth.getFullYear() &&
                    viewMonth.getMonth() === maxMonth.getMonth()
                  }
                >
                  Next &gt;
                </button>
              </div>

              <div
                className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium"
                style={{ color: PRIMARY }}
              >
                {weekdays.map((w) => (
                  <div key={w} className="py-1">
                    {w}
                  </div>
                ))}
              </div>

              <div className="mt-2 grid grid-cols-7 gap-2">
                {grid.map((cell, i) => {
                  const isSelected =
                    cell.date &&
                    selectedDate &&
                    toYMD(cell.date) === toYMD(selectedDate);
                  const isBeforeToday = cell.date
                    ? new Date(
                        cell.date.getFullYear(),
                        cell.date.getMonth(),
                        cell.date.getDate()
                      ) < now
                    : false;
                  const isBlocked = cell.date
                    ? blockedDates.has(toYMD(cell.date)) || isBeforeToday
                    : false;
                  const base =
                    'h-10 w-full rounded-md border text-[12px] flex items-center justify-center';
                  const inactive = cell.muted
                    ? ' border-gray-100 text-gray-300 bg-gray-50'
                    : '';
                  let styles: any = {};
                  let extraCls =
                    ' cursor-pointer hover:opacity-90 text-white';

                  if (cell.muted) {
                    styles = {};
                    extraCls = '';
                  } else if (isBlocked) {
                    styles = {
                      backgroundColor: UNAVAILABLE_BG,
                      borderColor: UNAVAILABLE_BG,
                    };
                    extraCls = ' text-gray-400 cursor-not-allowed';
                  } else if (isSelected) {
                    styles = {
                      backgroundColor: PRIMARY,
                      borderColor: PRIMARY,
                    };
                  } else {
                    styles = {
                      backgroundColor: DATE_BG,
                      borderColor: DATE_BG,
                    };
                  }

                  return (
                    <div
                      key={i}
                      className={`${base}${inactive}${extraCls}`}
                      style={styles}
                      onClick={() => {
                        if (cell.date && !isBlocked) setSelectedDate(cell.date);
                      }}
                    >
                      {cell.d || ''}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Time slots – same availability behaviour as customer booking form */}
            <div className="rounded-xl border bg-white p-4 shadow-sm">
              {!selectedDate ? (
                <div className="text-xs text-gray-600">
                  Please select a date first
                </div>
              ) : (
                <>
                  <h3
                    className="text-base font-semibold mb-3"
                    style={{ color: PRIMARY }}
                  >
                    Select a Time
                  </h3>

                  {timesLoading ? (
                    <div className="p-3 text-center bg-gray-50 rounded-md">
                      <span className="text-gray-500">Loading...</span>
                    </div>
                  ) : availableTimes.length === 0 ? (
                    <div className="p-3 text-xs text-gray-600 rounded-md bg-gray-50">
                      No times available for this date
                    </div>
                  ) : (
                    <div className="time-slots-grid grid grid-cols-3 gap-2 md:gap-3">
                      {availableTimes.map((t, idx) => {
                        const isSel = selectedTime === t;
                        return (
                          <button
                            key={t + '-' + idx}
                            type="button"
                            onClick={() => setSelectedTime(t)}
                            className={`p-3 text-center rounded-md text-xs cursor-pointer ${
                              isSel ? '' : 'hover:opacity-90'
                            }`}
                            style={{
                              border: `1px solid ${
                                isSel ? PRIMARY : '#e5e7eb'
                              }`,
                              backgroundColor: isSel
                                ? 'rgba(0,113,188,0.08)'
                                : '#fff',
                              color: isSel ? PRIMARY : '#111827',
                            }}
                          >
                            {displayHour(t)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-3">
              <button
                onClick={() => setRescheduleFor(null)}
                className="rounded-md px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={confirmReschedule}
                disabled={!selectedDate || !selectedTime}
                className={`rounded-md px-4 py-2 text-sm text-white ${
                  selectedDate && selectedTime
                    ? 'bg-[#0071bc] hover:opacity-95'
                    : 'bg-[#0071bc]/50 cursor-not-allowed'
                }`}
              >
                Reschedule
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
