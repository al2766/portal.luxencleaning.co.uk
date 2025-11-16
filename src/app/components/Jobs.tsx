'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import {
  collection,
  onSnapshot,
  query,
  updateDoc,
  doc,
  orderBy,
  getDoc,
  setDoc,
  arrayUnion,
} from 'firebase/firestore';

import dynamic from 'next/dynamic';
import 'leaflet/dist/leaflet.css';
import type {
  MapContainerProps,
  TileLayerProps,
  CircleProps,
} from 'react-leaflet';

const staffRate = 12.21; // £/hour

const currency = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 2,
});

// UPDATED: include extra small to match new room formats
const SIZE_LABELS: Record<string, string> = {
  xs: 'extra small',
  s: 'small',
  m: 'medium',
  l: 'large',
  xl: 'extra large',
};

const parseCount = (v?: number | string): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

// NEW: labels for room types from structured selections (home + office)
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
  return typeId
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const MapContainer = dynamic<MapContainerProps>(
  () => import('react-leaflet').then((m) => m.MapContainer),
  { ssr: false }
);
const TileLayer = dynamic<TileLayerProps>(
  () => import('react-leaflet').then((m) => m.TileLayer),
  { ssr: false }
);
const Circle = dynamic<CircleProps>(
  () => import('react-leaflet').then((m) => m.Circle),
  { ssr: false }
);

type Address =
  | string
  | {
      line1?: string;
      line2?: string;
      town?: string;
      county?: string;
      postcode?: string;
    };

// NEW: shared room/toilet selection types for newer bookings
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
  totalPrice?: number;
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

  // NEW: booking-builder summaries used in checkout
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

  // two-cleaner support
  twoCleaners?: boolean;
  assignedStaffIds?: string[];
  assignedStaffNames?: string[];
  confirmedStaffIds?: string[];
};

type Job = {
  id: string;
  displayTime: string;
  displayAddress: string;
} & BookingDoc;

type DayName =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday'
  | 'Sunday';
type DayAvail = { available: boolean; from: string; to: string };
type Availability = Record<DayName, DayAvail>;

const defaultAvailability: Availability = {
  Monday: { available: true, from: '08:00', to: '18:00' },
  Tuesday: { available: true, from: '08:00', to: '18:00' },
  Wednesday: { available: true, from: '08:00', to: '18:00' },
  Thursday: { available: true, from: '08:00', to: '18:00' },
  Friday: { available: true, from: '08:00', to: '18:00' },
  Saturday: { available: false, from: '09:00', to: '16:00' },
  Sunday: { available: false, from: '09:00', to: '16:00' },
};

function milesToMeters(mi: number) {
  return mi * 1609.34;
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

// NEW: compute bounding box for a circle in miles, for auto fit
function circleBoundsFromMiles(center: [number, number], miles: number) {
  const [lat, lon] = center;
  const meters = miles * 1609.34;
  const dLat = meters / 111_320; // rough meters per degree latitude
  const dLon =
    meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  const south = lat - dLat;
  const north = lat + dLat;
  const west = lon - dLon;
  const east = lon + dLon;
  return [
    [south, west],
    [north, east],
  ] as [[number, number], [number, number]];
}

type LeafletMapLike = {
  setView: (center: [number, number], zoom: number) => void;
  setZoom: (zoom: number) => void;
  // NEW: add fitBounds so TS is happy
  fitBounds?: (bounds: [[number, number], [number, number]], options?: any) => void;
};

function formatUKDate(dateStr: string): string {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  const date = new Date(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day)
  );
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// helpers for two-cleaner model (works with legacy fields)
function getAssignedIds(job: BookingDoc): string[] {
  if (
    Array.isArray(job.assignedStaffIds) &&
    job.assignedStaffIds.length
  )
    return job.assignedStaffIds.filter(Boolean) as string[];
  return job.assignedStaffId ? [job.assignedStaffId] : [];
}
function getAssignedNames(job: BookingDoc): string[] {
  if (
    Array.isArray(job.assignedStaffNames) &&
    job.assignedStaffNames.length
  )
    return job.assignedStaffNames.filter(Boolean) as string[];
  return job.assignedStaffName ? [job.assignedStaffName] : [];
}
function requiredCleaners(job: BookingDoc): number {
  return job.twoCleaners ? 2 : 1;
}

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [uid, setUid] = useState<string | null>(
    auth.currentUser?.uid ?? null
  );

  const [needsProfile, setNeedsProfile] = useState<boolean>(false);
  const [checkedProfile, setCheckedProfile] = useState<boolean>(false);

  const [homePostcode, setHomePostcode] = useState('');
  const [radiusMiles, setRadiusMiles] = useState<number>(10);
  const [minNoticeHours, setMinNoticeHours] = useState<number>(12);
  const [travelBufferMins, setTravelBufferMins] = useState<number>(30);
  const [availability, setAvailability] =
    useState<Availability>(defaultAvailability);

  const [hasCar, setHasCar] = useState<boolean | null>(null);
  const [bringsSupplies, setBringsSupplies] = useState<boolean | null>(null);
  const [teamJobs, setTeamJobs] = useState<boolean | null>(null);
  const [equipment, setEquipment] = useState<string[]>([]);
  const [pets, setPets] = useState<string[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [rightToWorkUk, setRightToWorkUk] = useState<boolean>(false);
  const [dateOfBirth, setDateOfBirth] = useState<string>('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankSortCode, setBankSortCode] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>('');

  const [mapCenter, setMapCenter] = useState<[number, number] | null>(
    null
  );
  const [geoLoading, setGeoLoading] = useState(false);
  const mapRef = useRef<LeafletMapLike | null>(null);

  const [autoAssign, setAutoAssign] = useState<boolean>(true);

  const [viewJob, setViewJob] = useState<Job | null>(null);
  const [stepDirection, setStepDirection] =
    useState<'forward' | 'backward'>('forward');
  const [confirmedJobs, setConfirmedJobs] = useState<string[]>([]);

  useEffect(
    () => onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null)),
    []
  );

  useEffect(() => {
    const ref = collection(db, 'bookings');
    const q = query(ref, orderBy('date', 'asc'));
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
    const sref = doc(db, 'settings', 'general');
    const unsub = onSnapshot(
      sref,
      (snap) => {
        const data = snap.data() as { autoAssign?: boolean } | undefined;
        setAutoAssign(Boolean(data?.autoAssign));
      },
      () => setAutoAssign(true)
    );
    return unsub;
  }, []);

  const checkProfile = useCallback(async (userId: string) => {
    try {
      const sref = doc(db, 'staff', userId);
      const snap = await getDoc(sref);
      const staff = snap.exists()
        ? (snap.data() as Record<string, unknown>)
        : {};
      const pc = String(staff?.['homePostcode'] ?? '').trim();
      setNeedsProfile(!pc);
    } catch {
      setNeedsProfile(true);
    } finally {
      setCheckedProfile(true);
    }
  }, []);

  useEffect(() => {
    if (!uid) {
      setNeedsProfile(false);
      setCheckedProfile(true);
      return;
    }
    setCheckedProfile(false);
    checkProfile(uid);
  }, [uid, checkProfile]);

  function isPostcodeUKish(v: string) {
    return /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/.test(
      v.trim()
    );
  }

  const stepError = useMemo(() => {
    switch (step) {
      case 0:
        return isPostcodeUKish(homePostcode)
          ? ''
          : 'Enter a valid UK postcode (e.g., M1 2AB).';
      case 1:
        if (!Number.isFinite(radiusMiles)) return 'Please enter a number.';
        if (radiusMiles <= 0 || radiusMiles > 50)
          return 'Travel radius must be between 1–50 miles.';
        return '';
      case 2: {
        const v = Number(minNoticeHours);
        if (
          Number.isFinite(v) &&
          Number.isInteger(v) &&
          v >= 0 &&
          v <= 168
        )
          return '';
        return 'Enter whole hours between 0–168.';
      }
      case 3:
        return [0, 15, 30, 45, 60, 90].includes(travelBufferMins)
          ? ''
          : 'Select a buffer value.';
      case 4: {
        for (const [day, v] of Object.entries(
          availability
        ) as [DayName, DayAvail][]) {
          if (v.available) {
            if (!v.from || !v.to)
              return `Please set both times for ${day}.`;
            if (v.from >= v.to)
              return `${day}: end time must be after start time.`;
          }
        }
        return '';
      }
      case 5:
        return hasCar !== null ? '' : 'Please select yes or no.';
      case 6:
        return bringsSupplies !== null ? '' : 'Please select yes or no.';
      case 7:
        if (bringsSupplies === true) {
          return Array.isArray(equipment) && equipment.length > 0
            ? ''
            : 'Please select at least one equipment option.';
        }
        return '';
      case 8:
        return '';
      case 9:
        return Array.isArray(services) && services.length > 0
          ? ''
          : 'Please select at least one service you can do.';
      case 10:
        return teamJobs !== null ? '' : 'Please select yes or no.';
      case 11:
        return rightToWorkUk
          ? ''
          : 'You must confirm you have the right to work in the UK.';
      case 12:
        return dateOfBirth && /^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)
          ? ''
          : 'Please enter your date of birth.';
      case 13:
        return bankAccountName.trim() &&
          bankName.trim() &&
          bankSortCode.trim() &&
          bankAccountNumber.trim()
          ? ''
          : 'Please enter your bank details.';
      default:
        return '';
    }
  }, [
    step,
    homePostcode,
    radiusMiles,
    minNoticeHours,
    travelBufferMins,
    availability,
    hasCar,
    bringsSupplies,
    equipment,
    pets,
    services,
    teamJobs,
    rightToWorkUk,
    dateOfBirth,
    bankAccountName,
    bankName,
    bankSortCode,
    bankAccountNumber,
  ]);

  const isValid = !stepError;
  const next = () => {
    setErr('');
    if (!isValid) return;
    setStepDirection('forward');
    if (step === 6 && bringsSupplies === false) {
      setEquipment([]);
      setStep((s) => Math.min(s + 2, 13));
    } else {
      setStep((s) => Math.min(s + 1, 13));
    }
  };

  const back = () => {
    setErr('');
    setStepDirection('backward');
    if (step === 8 && bringsSupplies === false) {
      setStep((s) => Math.max(s - 2, 0));
    } else {
      setStep((s) => Math.max(s - 1, 0));
    }
  };

  useEffect(() => {
    async function geocode() {
      if (!isPostcodeUKish(homePostcode)) {
        setMapCenter(null);
        return;
      }
      try {
        setGeoLoading(true);
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
          homePostcode
        )}&countrycodes=gb&limit=1`;
        const res = await fetch(url, {
          headers: { 'Accept-Language': 'en' },
        });
        const json = await res.json();
        if (Array.isArray(json) && json.length > 0) {
          const { lat, lon } = json[0];
          const center: [number, number] = [
            parseFloat(lat),
            parseFloat(lon),
          ];
          setMapCenter(center);
          // Smooth fit after setting center
          setTimeout(() => {
            if (
              mapRef.current &&
              mapRef.current.fitBounds &&
              center
            ) {
              const bounds = circleBoundsFromMiles(center, radiusMiles);
              // @ts-ignore leaflet options typing
              mapRef.current.fitBounds(bounds, {
                padding: [24, 24],
                animate: true,
                duration: 0.8,
              });
            }
          }, 0);
        } else {
          setMapCenter(null);
        }
      } catch {
        setMapCenter(null);
      } finally {
        setGeoLoading(false);
      }
    }
    geocode();
    // postcode change triggers a refit (radius change handled in separate effect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homePostcode]);

  // Smoothly refit whenever miles changes (and we have a center)
  useEffect(() => {
    if (!mapRef.current || !mapCenter || !mapRef.current.fitBounds) return;
    const bounds = circleBoundsFromMiles(mapCenter, radiusMiles);
    // @ts-ignore leaflet options typing
    mapRef.current.fitBounds(bounds, {
      padding: [24, 24],
      animate: true,
      duration: 0.8,
    });
  }, [mapCenter, radiusMiles]);

  const bumpRadius = (delta: number) => {
    setRadiusMiles((prev) =>
      Math.max(1, Math.min(50, Math.round(prev + delta)))
    );
  };

  const save = async () => {
    if (!isValid || !uid) return;
    try {
      setSaving(true);
      setErr('');

      const lower: Record<
        string,
        {
          available: boolean;
          startTime: string;
          endTime: string;
          from: string;
          to: string;
        }
      > = {};
      Object.entries(availability).forEach(([Day, v]) => {
        const key = Day.toLowerCase();
        lower[key] = {
          available: !!v.available,
          startTime: v.from,
          endTime: v.to,
          from: v.from,
          to: v.to,
        };
      });

      await setDoc(
        doc(db, 'staff', uid),
        {
          email: auth.currentUser?.email || '',
          active: true,
          homePostcode: homePostcode
            .trim()
            .toUpperCase()
            .replace(/\s+/g, ''),
          radiusMiles: Number(radiusMiles),
          radiusKm: Math.round(Number(radiusMiles) * 1.60934),
          minNoticeHours: Number(minNoticeHours),
          travelBufferMins: Number(travelBufferMins),
          availability: lower,
          hasCar: hasCar === true,
          bringsSupplies: bringsSupplies === true,
          equipment,
          pets,
          services,
          teamJobs: teamJobs === true,
          rightToWorkUk,
          dateOfBirth: dateOfBirth || null,
          bankAccountName: bankAccountName || null,
          bankName: bankName || null,
          bankSortCode: bankSortCode || null,
          bankAccountNumber: bankAccountNumber || null,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

      await checkProfile(uid);
      setStep(0);
      alert('Profile completed ✅');
    } catch (e) {
      const msg =
        (e as { message?: string })?.message ||
        'Failed to save profile.';
      setErr(msg);
    } finally {
      setSaving(false);
    }
  };

  // unassigned = not fully staffed yet
  const visibleUnassignedJobs = useMemo(() => {
    if (!uid) return [];
    if (!autoAssign) return [];
    return jobs.filter(
      (j) => getAssignedIds(j).length < requiredCleaners(j)
    );
  }, [jobs, uid, autoAssign]);

  // my jobs = I'm in assigned list
  const myJobs = useMemo(() => {
    if (!uid) return [];
    return jobs.filter((j) => getAssignedIds(j).includes(uid));
  }, [jobs, uid]);

  const getErrorMessage = (e: unknown): string =>
    typeof e === 'string'
      ? e
      : e &&
        typeof e === 'object' &&
        'message' in e &&
        typeof (e as { message?: string }).message === 'string'
      ? (e as { message?: string }).message!
      : 'Unexpected error';

  // self-assign supporting 2 cleaners + Zapier hook
  const assignToMe = async (jobId: string) => {
    if (!uid) return alert('Not signed in');
    if (
      !confirm(
        'Assign this job to you and send you the booking details?'
      )
    )
      return;
    try {
      const dref = doc(db, 'bookings', jobId);
      const snap = await getDoc(dref);
      if (!snap.exists()) throw new Error('Booking not found');
      const data = snap.data() as BookingDoc;

      const need = requiredCleaners(data);
      const ids = getAssignedIds(data);
      const names = getAssignedNames(data);

      if (ids.includes(uid)) {
        alert('You are already assigned to this job.');
        return;
      }
      if (ids.length >= need) {
        alert('This job already has the required cleaners.');
        return;
      }

      const staffRef = doc(db, 'staff', uid);
      const staffSnap = await getDoc(staffRef);
      const staff = staffSnap.exists()
        ? (staffSnap.data() as Record<string, unknown>)
        : {};

      const myName =
        auth.currentUser?.displayName ||
        (staff['name'] as string | undefined) ||
        (staff['fullName'] as string | undefined) ||
        (staff['bankAccountName'] as string | undefined) ||
        'Staff Member';

      const nextIds = [...ids, uid].slice(0, need);
      const nextNames = [...names, myName].slice(0, need);

      await updateDoc(dref, {
        assignedStaffIds: nextIds,
        assignedStaffNames: nextNames,
        assignedStaffId: nextIds[0] ?? null,
        assignedStaffName: nextNames[0] ?? null,
      });

      try {
        const staffEmail =
          auth.currentUser?.email ||
          (staff['email'] as string | undefined) ||
          '';

        const rawStaffPhone =
          (staff['phone'] as string | undefined) ||
          auth.currentUser?.phoneNumber ||
          (staff['mobile'] as string | undefined) ||
          '';

        const staffPhone = toE164UK(rawStaffPhone) ?? '';

        const estimatedHours = Number(data.estimatedHours ?? 0) || 0;
        const staffPay = estimatedHours
          ? estimatedHours * staffRate
          : 0;

        const postcode =
          typeof data.address === 'string'
            ? data.address
            : ((data.address?.postcode as string | undefined) || '');

        const time =
          data.endTime && data.endTime !== data.startTime
            ? `${data.startTime} - ${data.endTime}`
            : data.startTime || '';

        const snippet = `New booking: ${
          data.customerName || 'Customer'
        } - ${postcode} on ${formatUKDate(
          data.date || ''
        )} at ${
          time || 'time TBC'
        } • Pay: ${
          staffPay
            ? currency.format(staffPay)
            : currency.format(0)
        }`;

        await fetch(
          'https://hooks.zapier.com/hooks/catch/22652608/u85wg6z/',
          {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              trigger: 'booking_assigned',
              jobId,
              staffId: uid,
              staffName: myName,
              staffEmail,
              staffPhone,
              rawStaffPhone,
              customerName: data.customerName || '',
              postcode,
              date: data.date || '',
              time,
              estimatedHours,
              staffPay,
              snippet,
            }),
          }
        );
      } catch (zapErr) {
        console.error('Zapier assign webhook failed', zapErr);
      }
    } catch (e) {
      console.error(e);
      alert(getErrorMessage(e) || 'Failed to assign job');
    }
  };

  const confirmBooking = async (job: Job) => {
    if (!uid) return alert('Not signed in');
    if (!confirm('Confirm you will attend this booking?')) return;
    try {
      const staffRef = doc(db, 'staff', uid);
      const staffSnap = await getDoc(staffRef);
      const staff = staffSnap.exists()
        ? (staffSnap.data() as Record<string, unknown>)
        : {};

      const staffName =
        auth.currentUser?.displayName ||
        (staff['name'] as string | undefined) ||
        (staff['fullName'] as string | undefined) ||
        (staff['bankAccountName'] as string | undefined) ||
        'Staff Member';

      const staffEmail =
        auth.currentUser?.email ||
        (staff['email'] as string | undefined) ||
        '';

      const rawStaffPhone =
        (staff['phone'] as string | undefined) ||
        auth.currentUser?.phoneNumber ||
        (staff['mobile'] as string | undefined) ||
        '';

      const staffPhone = toE164UK(rawStaffPhone) ?? '';

      const postcode =
        typeof job.address === 'string'
          ? job.address
          : ((job.address?.postcode as string | undefined) || '');

      const estimatedHours = Number(job.estimatedHours ?? 0) || 0;
      const staffPay = estimatedHours
        ? estimatedHours * staffRate
        : 0;

      const snippet = `Booking confirmed: ${
        job.customerName || 'Customer'
      } - ${postcode} on ${formatUKDate(
        job.date || ''
      )} at ${
        job.displayTime || job.startTime || ''
      } • Pay: ${
        staffPay
          ? currency.format(staffPay)
          : currency.format(0)
      }`;

      await fetch(
        'https://hooks.zapier.com/hooks/catch/22652608/u85aagf/',
        {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trigger: 'booking_confirmed',
            jobId: job.id,
            staffId: uid,
            staffName,
            staffEmail,
            staffPhone,
            customerName: job.customerName || '',
            postcode,
            rawStaffPhone,
            date: job.date || '',
            time: job.displayTime || job.startTime || '',
            estimatedHours,
            staffPay,
            snippet,
          }),
        }
      );

      // NEW: persist confirmation on the booking doc
      await updateDoc(doc(db, 'bookings', job.id), {
        confirmedStaffIds: arrayUnion(uid),
      });

      setConfirmedJobs((prev) =>
        prev.includes(job.id) ? prev : [...prev, job.id]
      );
      alert('Booking confirmed. Thank you!');
    } catch (e) {
      console.error(e);
      alert(getErrorMessage(e) || 'Failed to confirm booking');
    }
  };

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
      'Standard Home Cleaning Checklist',
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

    const showTime =
      job.displayTime || job.startTime || '—';
    const hours = Number(job.estimatedHours ?? 0) || 0;
    const pay = hours > 0 ? money.format(hours * STAFF_RATE) : '—';
    const cleaners =
      getAssignedNames(job).join(', ') || '—';

    // NEW: nicer rooms line using roomSummaries when present
    let roomsLine: string;
    if (Array.isArray(job.roomSummaries) && job.roomSummaries.length > 0) {
      const segments = job.roomSummaries
        .map((r) => {
          const label =
            r.label || labelRoomType(r.typeId);
          const sizes = Array.isArray(r.sizes) ? r.sizes : [];
          const sizeCounts: Record<string, number> = {};
          for (const sid of sizes) {
            const key = (sid || '').toLowerCase();
            if (!key) continue;
            sizeCounts[key] = (sizeCounts[key] || 0) + 1;
          }
          const totalRooms =
            Number(r.count ?? sizes.length ?? 0) || 0;

          if (!totalRooms) return null;

          if (Object.keys(sizeCounts).length > 0) {
            const sizeText = Object.entries(sizeCounts)
              .map(([key, count]) => {
                const sizeName =
                  SIZE_LABELS[key] || key;
                return `${count} ${sizeName}`;
              })
              .join(', ');
            return `${label}: ${totalRooms} room${
              totalRooms > 1 ? 's' : ''
            } (${sizeText})`;
          }

          return `${label}: ${totalRooms} room${
            totalRooms > 1 ? 's' : ''
          }`;
        })
        .filter(Boolean) as string[];

      roomsLine = segments.length
        ? segments.join(' · ')
        : 'Not set';
    } else {
      const b = parseCount(job.bedrooms);
      const baths = parseCount(job.bathrooms);
      const liv = parseCount(job.livingRooms);
      const k = parseCount(job.kitchens);

      const parts: string[] = [];
      if (b) parts.push(`${b} bed${b > 1 ? 's' : ''}`);
      if (baths)
        parts.push(
          `${baths} bath${baths > 1 ? 's' : ''}`
        );
      if (liv) parts.push(`${liv} living`);
      if (k)
        parts.push(
          `${k} kitchen${k > 1 ? 's' : ''}`
        );

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
    yR = kvInline(
      R,
      yR,
      'Assigned Cleaners',
      cleaners,
      rightW
    );
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

    const entry_items = [
      'Put on shoe covers (if required)',
      'Knock, greet politely, confirm job scope & time',
      'Place equipment neatly by the entrance',
      'Tidy shoes/coats if asked; clear floor area',
      'Vacuum/mop floors; wipe skirting boards and door handles',
    ];
    const kitchen_items = [
      'Load/unload dishwasher if asked; wash remaining dishes',
      'Wipe worktops, splashbacks, cupboard doors and handles',
      'Clean hob and front of oven; wipe appliances (kettle, microwave)',
      'Empty bins & replace liners; take rubbish out (if instructed)',
      'Vacuum/mop floor; leave sink & taps shining',
    ];
    const bathroom_items = [
      'Spray & clean toilet (top to bottom) and base',
      'Clean sink, taps, plugholes & polish mirrors',
      'Wipe shower/bath, screen/tiles; rinse & squeegee',
      'Wipe light switches, door handles & skirting',
      'Vacuum/mop floor; leave surfaces dry & tidy',
    ];
    const bedroom_items = [
      'Tidy surfaces; dust reachable areas and skirting',
      'Make bed/change bedding if clean bedding provided',
      'Wipe mirrors & glass surfaces',
      'Empty small bins (if present)',
      'Vacuum/mop floors; check under bed reachable area',
    ];
    const living_items = [
      'Tidy and dust surfaces, TV stand, shelves (reachable)',
      'Wipe coffee table and reachable glass',
      'Fluff cushions & fold throws neatly',
      'Wipe light switches, door handles & skirting',
      'Vacuum/mop floors and visible edges',
    ];
    const finish_items = [
      'Walk-through with customer (if present) & confirm satisfaction',
      'Check lights off, windows closed (unless instructed)',
      'Take rubbish/recycling out if instructed',
      'Pack equipment, leave entry tidy',
      'Note any damages/issues in app/notes',
    ];

    let yL1 = section('Entry & Hallway', entry_items, M, y, colW2);
    let yR1 = section('Kitchen', kitchen_items, M + colW2 + colGap2, y, colW2);
    y = Math.max(yL1, yR1) + ROW_GAP;

    let yL2 = section('Bathrooms', bathroom_items, M, y, colW2);
    let yR2 = section('Bedrooms', bedroom_items, M + colW2 + colGap2, y, colW2);
    y = Math.max(yL2, yR2) + ROW_GAP;

    let yL3 = section('Living Areas', living_items, M, y, colW2);
    let yR3 = section('Finishing Up', finish_items, M + colW2 + colGap2, y, colW2);
    y = Math.max(yL3, yR3);

    const footerY = Math.min(A4_H - 22, y + 20);
    set('helvetica', 'italic', 9, '#555');
    docPdf.text('Thank you for choosing Luxen Cleaning.', M, footerY);

    const pc =
      typeof job.address === 'string'
        ? ''
        : job.address?.postcode ?? '';
    docPdf.save(
      `${job.customerName ?? 'Customer'} (${pc}) Checklist.pdf`
    );
  }

  const inputCls =
    'w-full h-11 px-3 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0071bc]/30 focus:border-[#0071bc]';

  const setDay = (
    day: DayName,
    field: keyof DayAvail,
    value: DayAvail[typeof field]
  ) => {
    setAvailability((prev) => {
      const cur = prev[day];
      if (field === 'available') {
        const makeOn = Boolean(value);
        return {
          ...prev,
          [day]: {
            available: makeOn,
            from: makeOn ? cur.from || '07:00' : '',
            to: makeOn ? cur.to || '20:00' : '',
          },
        };
      }
      return { ...prev, [day]: { ...cur, [field]: value } };
    });
  };

  const toggleIn = (
    list: string[],
    value: string,
    setter: (v: string[]) => void
  ) => {
    setter(
      list.includes(value)
        ? list.filter((v) => v !== value)
        : [...list, value]
    );
  };

  const payText = (j: Job) => {
    const hours = Number(j.estimatedHours ?? 0) || 0;
    return hours ? currency.format(hours * staffRate) : '—';
  };

  const twoCleanerLine = (j: Job): string | null => {
    if (!j.twoCleaners) return null;
    const ids = getAssignedIds(j);
    const names = getAssignedNames(j);
    if (ids.length >= 2) {
      if (!uid) return 'Two-cleaner job';
      const myIdx = ids.findIndex((x) => x === uid);
      const otherIdx = myIdx === 0 ? 1 : 0;
      const other =
        names[otherIdx] || ids[otherIdx] || 'Second cleaner';
      return `Also assigned: ${other}`;
    }
    return 'Awaiting second cleaner';
  };

  // small badge
  const Tag = ({ children }: { children: React.ReactNode }) => (
    <span className="px-2 py-1 rounded bg-gray-50 border text-xs text-gray-700">
      {children}
    </span>
  );

  // hours badge content
  const hoursTag = (j: Job) => {
    const h = Number(j.estimatedHours ?? 0) || 0;
    return `Est: ${h || '—'} h`;
  };

  return (
    <div className="space-y-8">
      {/* PROFILE GATE (unchanged) */}
      {checkedProfile && needsProfile && (
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-bold text-[#0071bc]">
              Complete your profile
            </h2>
            <p className="text-sm text-gray-800">
              You need to complete your profile to receive jobs.
            </p>
          </div>

          <div className="max-w-3xl rounded-2xl border bg-white shadow p-4 md:p-6">
            {err && (
              <div className="mb-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm px-3 py-2">
                {err}
              </div>
            )}

            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-gray-900">
                Step <span>{step + 1}</span> / 14
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={back}
                  disabled={step === 0}
                  className={`px-3 py-1.5 rounded-md border cursor-pointer ${
                    step === 0
                      ? 'opacity-50 cursor-not-allowed'
                      : 'bg-white border-gray-300 text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  Back
                </button>

                {step < 13 ? (
                  <button
                    onClick={next}
                    disabled={!isValid}
                    className={`px-3 py-1.5 rounded-md text-white font-medium cursor-pointer ${
                      isValid
                        ? 'bg-[#0071bc] hover:opacity-95'
                        : 'bg-[#0071bc]/50 cursor-not-allowed'
                    }`}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    onClick={save}
                    disabled={!isValid || saving}
                    className={`px-3 py-1.5 rounded-md text-white font-medium cursor-pointer ${
                      isValid && !saving
                        ? 'bg-[#0071bc] hover:opacity-95'
                        : 'bg-[#0071bc]/50 cursor-not-allowed'
                    }`}
                  >
                    {saving ? 'Saving…' : 'Save Profile'}
                  </button>
                )}
              </div>
            </div>

            {/* BODY (unchanged fields) */}
            <div className="space-y-2 relative overflow-hidden">
              <div
                key={step}
                className={`step-panel ${
                  stepDirection === 'forward'
                    ? 'step-forward'
                    : 'step-backward'
                }`}
              >
                {step === 0 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      What is your home postcode?
                    </div>
                    <p className="text-sm text-gray-800 mb-2">
                      We use this to match you with nearby jobs.
                    </p>
                    <input
                      className={inputCls}
                      placeholder="e.g., M1 2AB"
                      value={homePostcode}
                      onChange={(e) =>
                        setHomePostcode(e.target.value)
                      }
                    />
                  </div>
                )}

                {step === 1 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      How far can you travel (miles)?
                    </div>
                    <p className="text-sm text-gray-800 mb-3">
                      Adjust the distance and see the area you can cover.
                    </p>

                    <div className="flex items-center gap-3 mb-3">
                      <button
                        type="button"
                        className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-gray-900 text-white text-lg font-bold hover:opacity-90 cursor-pointer"
                        onClick={() => bumpRadius(-1)}
                        aria-label="Decrease miles"
                      >
                        −
                      </button>
                      <div className="text-sm font-semibold text-gray-900 min-w-[90px] text-center">
                        {radiusMiles} mile
                        {radiusMiles === 1 ? '' : 's'}
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[#0071bc] text-white text-lg font-bold hover:opacity-95 cursor-pointer"
                        onClick={() => bumpRadius(1)}
                        aria-label="Increase miles"
                      >
                        +
                      </button>
                    </div>

                    <div className="h-64 w-full overflow-hidden rounded-xl border border-gray-200">
                      {!mapCenter && (
                        <div className="h-full w-full flex items-center justify-center text-sm text-gray-800">
                          {geoLoading
                            ? 'Locating postcode…'
                            : 'Enter a valid UK postcode first'}
                        </div>
                      )}
                      {mapCenter && (
                        <MapContainer
                          center={mapCenter}
                          zoom={9}
                          whenCreated={(m) => {
                            mapRef.current =
                              m as unknown as LeafletMapLike;
                          }}
                          style={{ height: '100%', width: '100%' }}
                          scrollWheelZoom
                        >
                          <TileLayer
                            attribution="&copy; OpenStreetMap contributors &copy; CARTO"
                            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                          />
                          <Circle
                            center={mapCenter}
                            radius={20}
                            pathOptions={{
                              color: '#111827',
                              fillColor: '#111827',
                              fillOpacity: 0.9,
                            }}
                          />
                          <Circle
                            center={mapCenter}
                            radius={milesToMeters(radiusMiles)}
                            pathOptions={{
                              color: '#0ea5e9',
                              fillColor: '#38bdf8',
                              fillOpacity: 0.12,
                            }}
                          />
                        </MapContainer>
                      )}
                    </div>
                  </div>
                )}

                {step === 2 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Notice time before jobs (hours)
                    </div>
                    <input
                      className={inputCls}
                      type="number"
                      min={0}
                      max={168}
                      placeholder="Enter hours"
                      value={
                        Number.isFinite(minNoticeHours)
                          ? String(minNoticeHours)
                          : ''
                      }
                      onChange={(e) =>
                        setMinNoticeHours(
                          e.target.value === ''
                            ? (NaN as unknown as number)
                            : Number(e.target.value)
                        )
                      }
                    />
                  </div>
                )}

                {step === 3 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Gap needed between jobs (minutes)
                    </div>
                    <select
                      className={inputCls}
                      value={String(travelBufferMins)}
                      onChange={(e) =>
                        setTravelBufferMins(Number(e.target.value))
                      }
                    >
                      {[0, 15, 30, 45, 60, 90].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {step === 4 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-2">
                      Weekly availability
                    </div>
                    <div className="space-y-2 max-h-72 overflow-auto pr-1">
                      {(Object.keys(availability) as DayName[]).map(
                        (day) => (
                          <div
                            key={day}
                            className="flex flex-wrap items-center gap-2 border rounded-lg p-3"
                          >
                            <div className="w-28 font-medium text-gray-900">
                              {day}
                            </div>
                            <label className="inline-flex items-center gap-2 text-gray-900">
                              <input
                                type="checkbox"
                                className="h-4 w-4"
                                checked={availability[day].available}
                                onChange={(e) =>
                                  setDay(
                                    day,
                                    'available',
                                    e.target.checked
                                  )
                                }
                              />
                              Available
                            </label>
                            {availability[day].available && (
                              <div className="flex flex-wrap items-center gap-2 ml-auto">
                                <input
                                  aria-label={`${day} start time`}
                                  type="time"
                                  className="h-10 px-2 rounded border border-gray-300 w-28 text-gray-900"
                                  value={availability[day].from}
                                  onChange={(e) =>
                                    setDay(day, 'from', e.target.value)
                                  }
                                />
                                <span className="text-sm text-gray-900">
                                  –
                                </span>
                                <input
                                  aria-label={`${day} end time`}
                                  type="time"
                                  className="h-10 px-2 rounded border border-gray-300 w-28 text-gray-900"
                                  value={availability[day].to}
                                  onChange={(e) =>
                                    setDay(day, 'to', e.target.value)
                                  }
                                />
                              </div>
                            )}
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}

                {step === 5 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Do you have a car?
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setHasCar(false)}
                        className={`px-3 py-1.5 rounded border cursor-pointer ${
                          hasCar === false
                            ? 'border-[#0071bc] text-[#0071bc]'
                            : 'border-gray-300 text-gray-800'
                        }`}
                      >
                        No
                      </button>
                      <button
                        type="button"
                        onClick={() => setHasCar(true)}
                        className={`px-3 py-1.5 rounded border cursor-pointer ${
                          hasCar === true
                            ? 'border-[#0071bc] text-[#0071bc]'
                            : 'border-gray-300 text-gray-800'
                        }`}
                      >
                        Yes
                      </button>
                    </div>
                  </div>
                )}

                {step === 6 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Do you have your own supplies?
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setBringsSupplies(false)}
                        className={`px-3 py-1.5 rounded border cursor-pointer ${
                          bringsSupplies === false
                            ? 'border-[#0071bc] text-[#0071bc]'
                            : 'border-gray-300 text-gray-800'
                        }`}
                      >
                        No
                      </button>
                      <button
                        type="button"
                        onClick={() => setBringsSupplies(true)}
                        className={`px-3 py-1.5 rounded border cursor-pointer ${
                          bringsSupplies === true
                            ? 'border-[#0071bc] text-[#0071bc]'
                            : 'border-gray-300 text-gray-800'
                        }`}
                      >
                        Yes
                      </button>
                    </div>
                  </div>
                )}

                {step === 7 && bringsSupplies && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Which equipment can you bring?
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        ['vacuum', 'Vacuum cleaner'],
                        ['mopBucket', 'Mop & bucket'],
                        ['duster', 'Duster'],
                        ['broomDustpan', 'Broom & dustpan'],
                        ['microfibre', 'Microfibre cloths'],
                        ['spotCleaner', 'Carpet spot cleaner (handheld)'],
                        ['none', 'None of the above'],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            if (key === 'none') {
                              setEquipment(['none']);
                            } else {
                              const next = equipment.includes('none')
                                ? []
                                : [...equipment];
                              if (next.includes(key)) {
                                setEquipment(
                                  next.filter((k) => k !== key)
                                );
                              } else {
                                setEquipment([...next, key]);
                              }
                            }
                          }}
                          className={`px-3 py-1.5 rounded border cursor-pointer ${
                            equipment.includes(key)
                              ? 'border-[#0071bc] text-[#0071bc]'
                              : 'border-gray-300 text-gray-800'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {step === 7 && !bringsSupplies && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Equipment
                    </div>
                    <p className="text-sm text-gray-700">
                      You indicated you don't bring your own supplies, so
                      we'll skip the equipment question.
                    </p>
                  </div>
                )}

                {step === 8 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Are you allergic to any animals?
                    </div>
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setPets([])}
                          className={`px-3 py-1.5 rounded border cursor-pointer ${
                            pets.length === 0
                              ? 'border-[#0071bc] text-[#0071bc]'
                              : 'border-gray-300 text-gray-800'
                          }`}
                        >
                          No
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (pets.length === 0) setPets(['dogs']);
                          }}
                          className={`px-3 py-1.5 rounded border cursor-pointer ${
                            pets.length > 0
                              ? 'border-[#0071bc] text-[#0071bc]'
                              : 'border-gray-300 text-gray-800'
                          }`}
                        >
                          Yes
                        </button>
                      </div>

                      {pets.length > 0 && (
                        <div>
                          <p className="text-sm text-gray-700 mb-2">
                            Select all animals you're allergic to:
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {[
                              ['dogs', 'Dogs'],
                              ['cats', 'Cats'],
                              ['birds', 'Birds'],
                              ['rabbits', 'Rabbits'],
                              ['rodents', 'Rodents (hamsters, guinea pigs, etc.)'],
                              ['reptiles', 'Reptiles'],
                              ['horses', 'Horses'],
                            ].map(([key, label]) => (
                              <button
                                key={key}
                                type="button"
                                onClick={() => {
                                  if (pets.includes(key)) {
                                    const remaining = pets.filter(
                                      (p) => p !== key
                                    );
                                    setPets(
                                      remaining.length > 0
                                        ? remaining
                                        : [key]
                                    );
                                  } else {
                                    setPets([...pets, key]);
                                  }
                                }}
                                className={`px-3 py-1.5 rounded border cursor-pointer ${
                                  pets.includes(key)
                                    ? 'border-[#0071bc] bg-[#0071bc] text-white'
                                    : 'border-gray-300 text-gray-800 hover:border-gray-400'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <p className="text-xs text-gray-600 mt-2">
                            Click to select/deselect. You can choose multiple.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {step === 9 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Services you can do
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        ['standard', 'Standard clean'],
                        ['deep', 'Deep clean'],
                        ['eot', 'End of tenancy / Move-out'],
                        ['oven', 'Oven clean'],
                        ['fridge', 'Fridge clean'],
                        ['laundry', 'Laundry / Ironing'],
                        ['spotClean', 'Carpet / Upholstery spot clean'],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() =>
                            toggleIn(services, key, setServices)
                          }
                          className={`px-3 py-1.5 rounded border cursor-pointer ${
                            services.includes(key)
                              ? 'border-[#0071bc] text-[#0071bc]'
                              : 'border-gray-300 text-gray-800'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {step === 10 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Okay with team jobs?
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setTeamJobs(false)}
                        className={`px-3 py-1.5 rounded border cursor-pointer ${
                          teamJobs === false
                            ? 'border-[#0071bc] text-[#0071bc]'
                            : 'border-gray-300 text-gray-800'
                        }`}
                      >
                        No
                      </button>
                      <button
                        type="button"
                        onClick={() => setTeamJobs(true)}
                        className={`px-3 py-1.5 rounded border cursor-pointer ${
                          teamJobs === true
                            ? 'border-[#0071bc] text-[#0071bc]'
                            : 'border-gray-300 text-gray-800'
                        }`}
                      >
                        Yes
                      </button>
                    </div>
                  </div>
                )}

                {step === 11 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Right to work in the UK
                    </div>
                    <p className="text-sm text-gray-800 mb-2">
                      Confirm you're legally allowed to work in the UK.
                      You may be asked to provide proof.
                    </p>
                    <label className="inline-flex items-center gap-2 text-gray-900">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={rightToWorkUk}
                        onChange={(e) =>
                          setRightToWorkUk(e.target.checked)
                        }
                      />
                      I confirm I have the right to work in the UK
                    </label>
                  </div>
                )}

                {step === 12 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Date of birth
                    </div>
                    <input
                      className={inputCls}
                      type="date"
                      value={dateOfBirth}
                      onChange={(e) =>
                        setDateOfBirth(e.target.value)
                      }
                    />
                  </div>
                )}

                {step === 13 && (
                  <div>
                    <div className="text-base font-semibold text-gray-900 mb-1">
                      Bank details
                    </div>
                    <p className="text-sm text-gray-800 mb-2">
                      We use these details to pay you for completed jobs.
                    </p>
                    <div className="space-y-2">
                      <input
                        className={inputCls}
                        placeholder="Account holder name"
                        value={bankAccountName}
                        onChange={(e) =>
                          setBankAccountName(e.target.value)
                        }
                      />
                      <input
                        className={inputCls}
                        placeholder="Bank name"
                        value={bankName}
                        onChange={(e) =>
                          setBankName(e.target.value)
                        }
                      />
                      <input
                        className={inputCls}
                        placeholder="Sort code"
                        value={bankSortCode}
                        onChange={(e) =>
                          setBankSortCode(e.target.value)
                        }
                      />
                      <input
                        className={inputCls}
                        placeholder="Account number"
                        value={bankAccountNumber}
                        onChange={(e) =>
                          setBankAccountNumber(e.target.value)
                        }
                      />
                    </div>
                  </div>
                )}
              </div>

              {stepError && (
                <p className="text-sm text-red-600">{stepError}</p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* AVAILABLE JOBS */}
      <section>
        <h2 className="text-xl font-semibold mb-4 text-gray-800">
          Available Jobs
        </h2>
        <div className="space-y-4">
          {visibleUnassignedJobs.length === 0 ? (
            <p className="text-gray-500">
              {autoAssign
                ? 'No jobs waiting for assignment.'
                : 'Auto-assign is OFF.'}
            </p>
          ) : (
            visibleUnassignedJobs.map((job) => {
              const teamNote =
                twoCleanerLine(job) ||
                (job.twoCleaners
                  ? 'Team job — needs 2 cleaners'
                  : null);
              return (
                <article
                  key={job.id}
                  className="bg-white border rounded-lg shadow-sm p-4 md:p-5"
                >
                  <div className="md:flex md:items-start md:justify-between md:gap-6">
                    {/* LEFT content (flex-1 keeps width as content grows) */}
                    <div className="flex-1 space-y-3">
                      <div>
                        <h3 className="text-base font-semibold text-gray-900">
                          {job.customerName || 'Customer'}
                        </h3>
                        <div className="text-sm text-gray-600 mt-1">
                          {job.displayAddress}
                        </div>
                        {job.customerPhone && (
                          <div className="text-sm text-gray-700 mt-1">
                            {job.customerPhone}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                        <span className="inline-flex items-center gap-2 px-2 py-1 rounded border border-gray-200">
                          <strong className="text-gray-800">
                            {formatUKDate(job.date)}
                          </strong>
                          <span>•</span>
                          <span>{job.displayTime}</span>
                        </span>
                      </div>

                      {teamNote && (
                        <div className="text-xs text-amber-700 bg-amber-50 inline-block px-2 py-1 rounded border border-amber-200">
                          {teamNote}
                        </div>
                      )}

                      <div className="text-sm font-semibold text-blue-700">
                        {payText(job)}
                      </div>
                    </div>

                    {/* RIGHT actions (auto width, small balanced gap) */}
                    <div className="mt-3 md:mt-0 flex-shrink-0 flex flex-col items-end gap-2 min-w-[180px]">
                      {/* mini tags above buttons, right-aligned */}
                      <div className="flex items-center gap-2">
                        {job.twoCleaners && <Tag>2 cleaners</Tag>}
                        <Tag>{hoursTag(job)}</Tag>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => assignToMe(job.id)}
                          className="bg-[#0071bc] text-white px-3 py-2 rounded-md hover:opacity-95 text-sm"
                        >
                          Assign to me
                        </button>
                        <button
                          onClick={() => setViewJob(job)}
                          className="rounded-md border px-3 py-2 text-gray-800 hover:bg-gray-50 text-sm"
                        >
                          View
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>

      {/* MY ASSIGNED */}
      <section>
        <h2 className="text-xl font-semibold mb-4 text-gray-800">
          My Assigned Jobs
        </h2>
        <div className="space-y-4">
          {myJobs.length === 0 ? (
            <p className="text-gray-500">You have no assigned jobs.</p>
          ) : (
            myJobs.map((job) => {
              const teamNote = twoCleanerLine(job);
              const isConfirmed = confirmedJobs.includes(job.id);
              return (
                <article
                  key={job.id}
                  className="bg-white rounded-2xl shadow p-4 md:p-5 border border-gray-100"
                  style={{
                    borderLeftWidth: 6,
                    borderLeftColor: isConfirmed
                      ? '#16a34a'
                      : '#f59e0b',
                  }}
                >
                  <div className="md:flex md:items-start md:justify-between md:gap-6">
                    {/* LEFT content */}
                    <div className="flex-1 space-y-3">
                      <div>
                        <h3 className="text-base font-semibold text-gray-900">
                          {job.customerName || 'Customer'}
                        </h3>
                        <div className="text-sm text-gray-600 mt-1">
                          {job.displayAddress}
                        </div>
                        {job.customerPhone && (
                          <div className="text-sm text-gray-700 mt-1">
                            {job.customerPhone}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                        <span className="inline-flex items-center gap-2 px-2 py-1 rounded border border-gray-200">
                          <strong className="text-gray-800">
                            {formatUKDate(job.date)}
                          </strong>
                          <span>•</span>
                          <span>{job.displayTime}</span>
                        </span>
                      </div>

                      {teamNote && (
                        <div className="text-xs text-amber-700 bg-amber-50 inline-block px-2 py-1 rounded border border-amber-200">
                          {teamNote}
                        </div>
                      )}

                      <div className="text-sm font-semibold text-blue-700">
                        {payText(job)}
                      </div>
                    </div>

                    {/* RIGHT actions */}
                    <div className="mt-3 md:mt-0 flex-shrink-0 flex flex-col items-end gap-2 min-w-[180px]">
                      {/* mini tags above buttons */}
                      <div className="flex items-center gap-2">
                        {job.twoCleaners && <Tag>2 cleaners</Tag>}
                        <Tag>{hoursTag(job)}</Tag>
                        {isConfirmed && (
                          <span className="px-2 py-1 rounded bg-green-50 border border-green-200 text-xs text-green-700">
                            Confirmed
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => downloadChecklist(job)}
                          className="bg-[#0071bc] text-white px-3 py-2 rounded-md hover:opacity-95 text-sm"
                        >
                          Checklist
                        </button>
                        {!isConfirmed && (
                          <button
                            onClick={() => confirmBooking(job)}
                            className="bg-green-600 text-white px-3 py-2 rounded-md hover:opacity-95 text-sm"
                          >
                            Confirm
                          </button>
                        )}
                        <button
                          onClick={() => setViewJob(job)}
                          className="rounded-md border px-3 py-2 text-gray-800 hover:bg-gray-50 text-sm"
                        >
                          View
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>

      {/* VIEW JOB MODAL (updated rooms display) */}
      {viewJob && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-4 shadow-xl overflow-auto max-h-[85vh]">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold text-gray-900">
                {viewJob.customerName || 'Customer'}
              </div>
              <button
                className="cursor-pointer rounded-md px-2 py-1 text-sm text-gray-700 hover:bg-gray-100"
                onClick={() => setViewJob(null)}
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-800">
              <div>
                <div className="text-sm text-gray-600">Contact</div>
                <div className="text-sm text-gray-900">
                  {viewJob.customerPhone || '—'}
                </div>

                <div className="text-sm text-gray-600 mt-3">Address</div>
                <div className="text-sm text-gray-900">
                  {typeof viewJob.address === 'string'
                    ? viewJob.address
                    : [
                        viewJob.address?.line1,
                        viewJob.address?.line2,
                        viewJob.address?.town,
                        viewJob.address?.county,
                        viewJob.address?.postcode,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                </div>

                <div className="text-sm text-gray-600 mt-3">
                  Rooms / Areas
                </div>
                <div className="text-sm text-gray-900">
                  {(() => {
                    // Prefer new booking-builder summaries (roomSummaries)
                    if (
                      Array.isArray(viewJob.roomSummaries) &&
                      viewJob.roomSummaries.length > 0
                    ) {
                      const rows = viewJob.roomSummaries
                        .map((r, idx) => {
                          const count = Number(r.count ?? 0);
                          if (!count) return null;

                          const label =
                            r.label ||
                            labelRoomType(r.typeId);

                          const sizeNames = Array.isArray(r.sizes)
                            ? r.sizes
                                .map((sid) => {
                                  const key = (sid || '')
                                    .toLowerCase();
                                  return (
                                    SIZE_LABELS[key] || sid
                                  );
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
                        return (
                          <div className="space-y-1">
                            {rows}
                          </div>
                        );
                      }
                    }

                    // Prefer structured roomSelections (new format) if no roomSummaries
                    if (
                      Array.isArray(viewJob.roomSelections) &&
                      viewJob.roomSelections.length > 0
                    ) {
                      const items = viewJob.roomSelections
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

                    // Fallback: legacy home-style counts
                    const b = parseCount(viewJob.bedrooms);
                    const baths = parseCount(viewJob.bathrooms);
                    const liv = parseCount(viewJob.livingRooms);
                    const k = parseCount(viewJob.kitchens);
                    const util = parseCount(viewJob.utilityRooms);

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
                        `${baths} bathroom${
                          baths > 1 ? 's' : ''
                        }`
                      );
                    if (util)
                      parts.push(
                        `${util} utility room${
                          util > 1 ? 's' : ''
                        }`
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

                    if (Array.isArray(viewJob.additionalRooms)) {
                      if (!viewJob.additionalRooms.length) return '—';
                      return (
                        <ul className="list-disc list-inside space-y-1">
                          {viewJob.additionalRooms.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      );
                    }

                    return viewJob.additionalRooms ?? '—';
                  })()}
                </div>

                {(() => {
                  // For the new roomSummaries format we already show counts & sizes above, so don't repeat.
                  if (
                    Array.isArray(viewJob.roomSummaries) &&
                    viewJob.roomSummaries.length > 0
                  ) {
                    return null;
                  }

                  // Structured summary for room sizes & toilets (roomSelections / office / toilets)
                  if (
                    Array.isArray(viewJob.roomSelections) &&
                    viewJob.roomSelections.length > 0
                  ) {
                    const sizeCounts: Record<string, number> = {};
                    for (const r of viewJob.roomSelections) {
                      const key = (r.sizeId || '').toLowerCase();
                      const count = Number(r.count ?? 0);
                      if (!key || !count) continue;
                      sizeCounts[key] = (sizeCounts[key] || 0) + count;
                    }
                    const sizeParts = Object.entries(sizeCounts)
                      .filter(
                        ([k, v]) => v > 0 && SIZE_LABELS[k]
                      )
                      .map(
                        ([k, v]) =>
                          `${v} ${SIZE_LABELS[k]} room${
                            v > 1 ? 's' : ''
                          }`
                      );

                    let totalCubicles =
                      typeof viewJob.totalCubicles === 'number'
                        ? viewJob.totalCubicles
                        : 0;
                    if (
                      !totalCubicles &&
                      Array.isArray(viewJob.toiletSelections)
                    ) {
                      totalCubicles = viewJob.toiletSelections.reduce(
                        (sum, t) => sum + (Number(t.count ?? 0) || 0),
                        0
                      );
                    }
                    const toiletRooms =
                      typeof viewJob.toiletRoomsCount === 'number'
                        ? viewJob.toiletRoomsCount
                        : 0;
                    const toiletSizeKey = (
                      viewJob.toiletSizeId || ''
                    ).toLowerCase();
                    const toiletSizeLabel =
                      SIZE_LABELS[toiletSizeKey] || '';

                    if (
                      !sizeParts.length &&
                      !totalCubicles &&
                      !toiletRooms
                    )
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
                                    totalCubicles === 1
                                      ? ''
                                      : 's'
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

                  const rooms = viewJob.office?.rooms;
                  if (!Array.isArray(rooms) || rooms.length === 0)
                    return null;
                  const sizeCounts: Record<string, number> = {};
                  for (const r of rooms) {
                    const key = (r.sizeId || '').toLowerCase();
                    if (!key) continue;
                    sizeCounts[key] = (sizeCounts[key] || 0) + 1;
                  }
                  const sizeParts = Object.entries(sizeCounts)
                    .filter(
                      ([k, v]) =>
                        v > 0 && SIZE_LABELS[k]
                    )
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

                <div className="text-sm text-gray-600 mt-3">
                  Add-ons
                </div>
                <div className="text-sm text-gray-900">
                  {Array.isArray(viewJob.addOns)
                    ? viewJob.addOns.join(', ')
                    : viewJob.addOns ?? 'None'}
                </div>

                <div className="text-sm text-gray-600 mt-3">
                  Notes / Additional Rooms
                </div>
                <div className="text-sm text-gray-900">
                  {viewJob.additionalInfo?.trim()
                    ? viewJob.additionalInfo
                    : '—'}
                </div>
              </div>

              <div>
                <div className="text-sm text-gray-600">Date & Time</div>
                <div className="text-sm text-gray-900">
                  {formatUKDate(viewJob.date)} •{' '}
                  {viewJob.displayTime ||
                    viewJob.startTime ||
                    '—'}
                </div>

                <div className="text-sm text-gray-600 mt-3">Service</div>
                <div className="text-sm text-gray-900">
                  {viewJob.serviceType || 'Cleaning Service'}
                </div>

                <div className="text-sm text-gray-600 mt-3">Team</div>
                <div className="text-sm text-gray-900">
                  {viewJob.twoCleaners
                    ? twoCleanerLine(viewJob) ?? 'Two-cleaner job'
                    : 'Single cleaner'}
                </div>

                <div className="text-sm text-gray-600 mt-3">
                  Your Pay
                </div>
                <div className="text-sm text-gray-900">
                  {(() => {
                    const h = Number(viewJob.estimatedHours ?? 0) || 0;
                    return h
                      ? `${currency.format(h * staffRate)}`
                      : '—';
                  })()}
                </div>
              </div>
            </div>

            <div className="mt-4 text-right">
              <button
                onClick={() => setViewJob(null)}
                className="rounded-md bg-[#0071bc] text-white px-3 py-2 hover:opacity-95"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .step-panel {
          animation-duration: 0.3s;
          animation-timing-function: ease-out;
          animation-fill-mode: both;
        }
        .step-forward {
          animation-name: slide-in-right-fade;
        }
        .step-backward {
          animation-name: slide-in-left-fade;
        }
        @keyframes slide-in-right-fade {
          from {
            opacity: 0;
            transform: translateX(24px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        @keyframes slide-in-left-fade {
          from {
            opacity: 0;
            transform: translateX(-24px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
      `}</style>
    </div>
  );
}
