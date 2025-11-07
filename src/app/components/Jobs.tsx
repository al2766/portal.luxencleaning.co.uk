'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import {
  collection, onSnapshot, query, updateDoc, doc, orderBy, getDoc, setDoc,
} from 'firebase/firestore';

import dynamic from 'next/dynamic';
import 'leaflet/dist/leaflet.css';
import type { MapContainerProps, TileLayerProps, CircleProps } from 'react-leaflet';

const MapContainer = dynamic<MapContainerProps>(
  () => import('react-leaflet').then(m => m.MapContainer),
  { ssr: false }
);
const TileLayer = dynamic<TileLayerProps>(
  () => import('react-leaflet').then(m => m.TileLayer),
  { ssr: false }
);
const Circle = dynamic<CircleProps>(
  () => import('react-leaflet').then(m => m.Circle),
  { ssr: false }
);

type BookingDoc = {
  orderId: string;
  date: string;
  startTime: string;
  endTime?: string;
  totalPrice?: number;
  customerName?: string;
  customerPhone?: string;
  address?: {
    line1?: string; line2?: string; town?: string; county?: string; postcode?: string;
  } | string;
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

type Job = {
  id: string;
  displayTime: string;
  displayAddress: string;
} & BookingDoc;

type DayName = 'Monday'|'Tuesday'|'Wednesday'|'Thursday'|'Friday'|'Saturday'|'Sunday';
type DayAvail = { available: boolean; from: string; to: string };
type Availability = Record<DayName, DayAvail>;

const defaultAvailability: Availability = {
  Monday:    { available: true,  from: '08:00', to: '18:00' },
  Tuesday:   { available: true,  from: '08:00', to: '18:00' },
  Wednesday: { available: true,  from: '08:00', to: '18:00' },
  Thursday:  { available: true,  from: '08:00', to: '18:00' },
  Friday:    { available: true,  from: '08:00', to: '18:00' },
  Saturday:  { available: false, from: '09:00', to: '16:00' },
  Sunday:    { available: false, from: '09:00', to: '16:00' },
};

function milesToMeters(mi: number) { return mi * 1609.34; }
function radiusToZoom(mi: number): number {
  if (mi <= 2) return 13;
  if (mi <= 4) return 12;
  if (mi <= 8) return 11;
  if (mi <= 16) return 10;
  if (mi <= 32) return 9;
  return 8;
}

type LeafletMapLike = {
  setView: (center: [number, number], zoom: number) => void;
  setZoom: (zoom: number) => void;
};

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);

  // profile gate (unchanged idea)
  const [needsProfile, setNeedsProfile] = useState<boolean>(false);
  const [checkedProfile, setCheckedProfile] = useState<boolean>(false);

  // wizard bits (kept so your UI remains the same)
  const [homePostcode, setHomePostcode] = useState('');
  const [radiusMiles, setRadiusMiles] = useState<number>(10);
  const [minNoticeHours, setMinNoticeHours] = useState<number>(12);
  const [travelBufferMins, setTravelBufferMins] = useState<number>(30);
  const [availability, setAvailability] = useState<Availability>(defaultAvailability);

  const [hasCar, setHasCar] = useState<boolean>(false);
  const [bringsSupplies, setBringsSupplies] = useState<boolean>(false);
  const [equipment, setEquipment] = useState<string[]>([]);
  const [pets, setPets] = useState<string[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [teamJobs, setTeamJobs] = useState<boolean>(true);
  const [rightToWorkUk, setRightToWorkUk] = useState<boolean>(false);
  const [dateOfBirth, setDateOfBirth] = useState<string>('');
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>('');

  // map state (unchanged)
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const mapRef = useRef<LeafletMapLike | null>(null);

  // 🔵 NEW: auto-assign setting from Firestore
  const [autoAssign, setAutoAssign] = useState<boolean>(true);

  useEffect(() => onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null)), []);

  // Listen to bookings (unchanged)
  useEffect(() => {
    const ref = collection(db, 'bookings');
    const q = query(ref, orderBy('date', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      const items: Job[] = snap.docs.map(d => {
        const data = d.data() as BookingDoc;
        const start = data.startTime ?? '';
        const end = data.endTime ?? '';
        const displayTime = end && end !== start ? `${start} - ${end}` : start;

        const addr = typeof data.address === 'string'
          ? data.address
          : [data.address?.line1, data.address?.town, data.address?.postcode].filter(Boolean).join(', ');

        return { id: d.id, ...data, displayTime, displayAddress: addr };
      });
      setJobs(items);
    });
    return unsub;
  }, []);

  // 🔵 Subscribe to settings/general for autoAssign
  useEffect(() => {
    const sref = doc(db, 'settings', 'general');
    const unsub = onSnapshot(sref, (snap) => {
      const data = snap.data() as { autoAssign?: boolean } | undefined;
      setAutoAssign(Boolean(data?.autoAssign));
    }, () => setAutoAssign(true)); // default true if missing
    return unsub;
  }, []);

  // ------- profile check (keep your gating but simpler) -------
  const checkProfile = useCallback(async (userId: string) => {
    try {
      const sref = doc(db, 'staff', userId);
      const snap = await getDoc(sref);
      const staff = snap.exists() ? (snap.data() as Record<string, unknown>) : {};
      const pc = String(staff?.['homePostcode'] ?? '').trim();
      setNeedsProfile(!pc);  // gate mainly on postcode as you asked earlier
    } catch {
      setNeedsProfile(true);
    } finally {
      setCheckedProfile(true);
    }
  }, []);

  useEffect(() => {
    if (!uid) { setNeedsProfile(false); setCheckedProfile(true); return; }
    setCheckedProfile(false);
    checkProfile(uid);
  }, [uid, checkProfile]);

  // ------- validation for wizard (unchanged except notice input already numeric) -------
  function isPostcodeUKish(v: string) {
    return /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/.test(v.trim());
  }

  const stepError = useMemo(() => {
    switch (step) {
      case 0:
        return isPostcodeUKish(homePostcode) ? '' : 'Enter a valid UK postcode (e.g., M1 2AB).';
      case 1:
        if (!Number.isFinite(radiusMiles)) return 'Please enter a number.';
        if (radiusMiles <= 0 || radiusMiles > 50) return 'Travel radius must be between 1–50 miles.';
        return '';
      case 2: {
        const v = Number(minNoticeHours);
        if (Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v <= 168) return '';
        return 'Enter whole hours between 0–168.';
      }
      case 3:
        return [0,15,30,45,60,90].includes(travelBufferMins) ? '' : 'Select a buffer value.';
      case 4: {
        for (const [day, v] of Object.entries(availability) as [DayName, DayAvail][]) {
          if (v.available) {
            if (!v.from || !v.to) return `Please set both times for ${day}.`;
            if (v.from >= v.to) return `${day}: end time must be after start time.`;
          }
        }
        return '';
      }
      case 11:
        return rightToWorkUk ? '' : 'You must confirm you have the right to work in the UK.';
      case 12:
        return dateOfBirth && /^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)
          ? ''
          : 'Please enter your date of birth.';
      default:
        return '';
    }
  }, [step, homePostcode, radiusMiles, minNoticeHours, travelBufferMins, availability, rightToWorkUk, dateOfBirth]);

  const isValid = !stepError;
  const next = () => { setErr(''); if (!isValid) return; setStep((s) => Math.min(s + 1, 12)); };
  const back = () => { setErr(''); setStep((s) => Math.max(s - 1, 0)); };

  // geocode preview for map (unchanged behavior)
  useEffect(() => {
    async function geocode() {
      if (!isPostcodeUKish(homePostcode)) { setMapCenter(null); return; }
      try {
        setGeoLoading(true);
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(homePostcode)}&countrycodes=gb&limit=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        const json = await res.json();
        if (Array.isArray(json) && json.length > 0) {
          const { lat, lon } = json[0];
          const center: [number, number] = [parseFloat(lat), parseFloat(lon)];
          setMapCenter(center);
          setTimeout(() => { if (mapRef.current) mapRef.current.setView(center, radiusToZoom(radiusMiles)); }, 0);
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
  }, [homePostcode, radiusMiles]);

  const bumpRadius = (delta: number) => {
    setRadiusMiles(prev => {
      const next = Math.max(1, Math.min(50, Math.round(prev + delta)));
      if (mapRef.current) mapRef.current.setZoom(radiusToZoom(next));
      return next;
    });
  };

  // save profile (unchanged except types)
  const save = async () => {
    if (!isValid || !uid) return;
    try {
      setSaving(true);
      setErr('');

      const lower: Record<string, { available: boolean; startTime: string; endTime: string; from: string; to: string }> = {};
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

      await setDoc(doc(db, 'staff', uid), {
        email: auth.currentUser?.email || '',
        active: true,
        homePostcode: homePostcode.trim().toUpperCase().replace(/\s+/g, ''),
        radiusMiles: Number(radiusMiles),
        radiusKm: Math.round(Number(radiusMiles) * 1.60934),
        minNoticeHours: Number(minNoticeHours),
        travelBufferMins: Number(travelBufferMins),
        availability: lower,
        hasCar,
        bringsSupplies,
        equipment,
        pets,
        services,
        teamJobs,
        rightToWorkUk,
        dateOfBirth: dateOfBirth || null,
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      await setDoc(doc(db, 'users', uid), {
        email: auth.currentUser?.email || '',
        role: 'cleaner',
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      await checkProfile(uid);
      setStep(0);
      alert('Profile completed ✅');
    } catch (e) {
      const msg = (e as { message?: string })?.message || 'Failed to save profile.';
      setErr(msg);
    } finally {
      setSaving(false);
    }
  };

  // 🔵 NEW: visibility
  const visibleUnassignedJobs = useMemo(() => {
    if (!uid) return [];
    if (!autoAssign) return []; // when OFF, staff see no unassigned jobs
    return jobs.filter(j => !j.assignedStaffId);
  }, [jobs, uid, autoAssign]);

  const myJobs = useMemo(() => jobs.filter(j => j.assignedStaffId === uid), [jobs, uid]);

  const getErrorMessage = (e: unknown): string =>
    typeof e === 'string'
      ? e
      : (e && typeof e === 'object' && 'message' in e && typeof (e as { message?: string }).message === 'string')
      ? (e as { message?: string }).message!
      : 'Unexpected error';

  const assignToMe = async (jobId: string) => {
    if (!uid) return alert('Not signed in');
    try {
      const dref = doc(db, 'bookings', jobId);
      await updateDoc(dref, {
        assignedStaffId: uid,
        assignedStaffName: auth.currentUser?.email || 'Staff Member',
      });
    } catch (e) {
      console.error(e);
      alert(getErrorMessage(e) || 'Failed to assign job');
    }
  };

  const removeFromMe = async (jobId: string) => {
    if (!uid) return;
    try {
      const dref = doc(db, 'bookings', jobId);
      await updateDoc(dref, { assignedStaffId: null, assignedStaffName: null });
    } catch (e) {
      console.error(e);
      alert(getErrorMessage(e) || 'Failed to remove job');
    }
  };

  const inputCls =
    'w-full h-11 px-3 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0071bc]/30 focus:border-[#0071bc]';

  const setDay = (day: DayName, field: keyof DayAvail, value: DayAvail[typeof field]) => {
  setAvailability(prev => {
    const cur = prev[day];
    if (field === 'available') {
      const makeOn = Boolean(value);
      return {
        ...prev,
        [day]: {
          available: makeOn,
          from: makeOn ? (cur.from || '07:00') : '',
          to:   makeOn ? (cur.to   || '20:00') : '',
        },
      };
    }
    return { ...prev, [day]: { ...cur, [field]: value } };
  });
};


  const toggleIn = (list: string[], value: string, setter: (v: string[]) => void) => {
    setter(list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  };

  // ====== RENDER ======
  return (
    <div className="space-y-8">
      {/* PROFILE GATE */}
      {checkedProfile && needsProfile && (
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-bold text-[#0071bc]">Complete your profile</h2>
            <p className="text-sm text-gray-800">You need to complete your profile to receive jobs.</p>
          </div>

          <div className="max-w-3xl rounded-2xl border bg-white shadow p-4 md:p-6">
            {err && (
              <div className="mb-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm px-3 py-2">
                {err}
              </div>
            )}

            {/* Header / controls */}
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-gray-900">Step <span>{step + 1}</span> / 13</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={back}
                  disabled={step === 0}
                  className={`px-3 py-1.5 rounded-md border cursor-pointer ${
                    step === 0 ? 'opacity-50 cursor-not-allowed' : 'bg-white border-gray-300 text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  Back
                </button>

                {step < 12 ? (
                  <button
                    onClick={next}
                    disabled={!isValid}
                    className={`px-3 py-1.5 rounded-md text-white font-medium cursor-pointer ${
                      isValid ? 'bg-[#0071bc] hover:opacity-95' : 'bg-[#0071bc]/50 cursor-not-allowed'
                    }`}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    onClick={save}
                    disabled={!isValid || saving}
                    className={`px-3 py-1.5 rounded-md text-white font-medium cursor-pointer ${
                      isValid && !saving ? 'bg-[#0071bc] hover:opacity-95' : 'bg-[#0071bc]/50 cursor-not-allowed'
                    }`}
                  >
                    {saving ? 'Saving…' : 'Save Profile'}
                  </button>
                )}
              </div>
            </div>

            {/* BODY (unchanged UI) */}
            <div className="space-y-2">
              {step === 0 && (
                <div>
                  <div className="text-base font-semibold text-gray-900 mb-1">What is your home postcode?</div>
                  <p className="text-sm text-gray-800 mb-2">We use this to match you with nearby jobs.</p>
                  <input className={inputCls} placeholder="e.g., M1 2AB" value={homePostcode} onChange={(e) => setHomePostcode(e.target.value)} />
                </div>
              )}

              {step === 1 && (
                <div>
                  <div className="text-base font-semibold text-gray-900 mb-1">How far can you travel (miles)?</div>
                  <p className="text-sm text-gray-800 mb-3">Adjust the distance and see the area you can cover.</p>

                  <div className="flex items-center gap-3 mb-3">
                    <button type="button" className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-gray-900 text-white text-lg font-bold hover:opacity-90 cursor-pointer" onClick={() => bumpRadius(-1)} aria-label="Decrease miles">−</button>
                    <div className="text-sm font-semibold text-gray-900 min-w-[90px] text-center">
                      {radiusMiles} mile{radiusMiles === 1 ? '' : 's'}
                    </div>
                    <button type="button" className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[#0071bc] text-white text-lg font-bold hover:opacity-95 cursor-pointer" onClick={() => bumpRadius(1)} aria-label="Increase miles">+</button>
                  </div>

                  <div className="h-64 w-full overflow-hidden rounded-xl border border-gray-200">
                    {!mapCenter && (
                      <div className="h-full w-full flex items-center justify-center text-sm text-gray-800">
                        {geoLoading ? 'Locating postcode…' : 'Enter a valid UK postcode first'}
                      </div>
                    )}
                    {mapCenter && (
                      <MapContainer
                        center={mapCenter}
                        zoom={radiusToZoom(radiusMiles)}
                        whenCreated={(m) => { mapRef.current = m as unknown as LeafletMapLike; }}
                        style={{ height: '100%', width: '100%' }}
                        scrollWheelZoom
                      >
                        <TileLayer
                          attribution='&copy; OpenStreetMap contributors &copy; CARTO'
                          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                        />
                        <Circle center={mapCenter} radius={20} pathOptions={{ color: '#111827', fillColor: '#111827', fillOpacity: 0.9 }} />
                        <Circle center={mapCenter} radius={milesToMeters(radiusMiles)} pathOptions={{ color: '#0ea5e9', fillColor: '#38bdf8', fillOpacity: 0.12 }} />
                      </MapContainer>
                    )}
                  </div>
                </div>
              )}

              {step === 2 && (
                <div>
                  <div className="text-base font-semibold text-gray-900 mb-1">Notice time before jobs (hours)</div>
                  <input
                    className={inputCls}
                    type="number"
                    min={0}
                    max={168}
                    placeholder="Enter hours"
                    value={Number.isFinite(minNoticeHours) ? String(minNoticeHours) : ''}
                    onChange={(e) => setMinNoticeHours(e.target.value === '' ? (NaN as unknown as number) : Number(e.target.value))}
                  />
                </div>
              )}

              {step === 3 && (
                <div>
                  <div className="text-base font-semibold text-gray-900 mb-1">Gap needed between jobs (minutes)</div>
                  <select className={inputCls} value={String(travelBufferMins)} onChange={(e) => setTravelBufferMins(Number(e.target.value))}>
                    {[0,15,30,45,60,90].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              )}

              {step === 4 && (
                <div>
                  <div className="text-base font-semibold text-gray-900 mb-2">Weekly availability</div>
                  <div className="space-y-2 max-h-72 overflow-auto pr-1">
                    {(Object.keys(availability) as DayName[]).map((day) => (
                      <div key={day} className="flex flex-wrap items-center gap-2 border rounded-lg p-3">
                        <div className="w-28 font-medium text-gray-900">{day}</div>
                        <label className="inline-flex items-center gap-2 text-gray-900">
                          <input type="checkbox" className="h-4 w-4" checked={availability[day].available} onChange={(e) => setDay(day, 'available', e.target.checked)} />
                          Available
                        </label>
                        {availability[day].available && (
                          <div className="flex flex-wrap items-center gap-2 ml-auto">
                            <input aria-label={`${day} start time`} type="time" className="h-10 px-2 rounded border border-gray-300 w-28 text-gray-900" value={availability[day].from} onChange={(e) => setDay(day, 'from', e.target.value)} />
                            <span className="text-sm text-gray-900">–</span>
                            <input aria-label={`${day} end time`} type="time" className="h-10 px-2 rounded border border-gray-300 w-28 text-gray-900" value={availability[day].to} onChange={(e) => setDay(day, 'to', e.target.value)} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 5..12 UI kept as in your code (car, supplies, equipment, pets, services, teamJobs, rightToWork, DOB) */}
              {/* ... */}
            </div>
          </div>
        </section>
      )}

      {/* AVAILABLE JOBS */}
      <section>
        <h2 className="text-xl font-semibold mb-4 text-gray-800">Available Jobs</h2>
        <div className="space-y-4">
          {visibleUnassignedJobs.length === 0 ? (
            <p className="text-gray-500">
              {autoAssign
                ? 'No jobs waiting for admin assignment.'
                : 'Auto-assign is OFF. Jobs will appear here after an admin assigns them.'}
            </p>
          ) : (
            visibleUnassignedJobs.map((job) => (
              <div key={job.id} className="p-4 text-gray-600 border rounded shadow-sm bg-white">
                <p className="font-medium text-gray-900">{job.customerName || 'Customer'}</p>
                <p className="text-sm text-gray-700">{job.displayAddress}</p>
                <p className="text-sm text-gray-700">{job.date} at {job.displayTime}</p>
                <p className="text-sm text-gray-700">
                  {job.bedrooms ?? 0} bed, {job.bathrooms ?? 0} bath, {job.livingRooms ?? 0} living, {job.kitchens ?? 0} kitchen
                </p>
                <p className="text-sm text-gray-700">
                  Add-ons: {Array.isArray(job.addOns) ? job.addOns.join(', ') : (job.addOns || 'None')}
                </p>
                {job.totalPrice != null && <p className="text-sm font-semibold text-blue-600">£{job.totalPrice}</p>}
                <button onClick={() => assignToMe(job.id)} className="mt-2 bg-[#0071bc] text-white px-3 py-1 rounded hover:opacity-95 cursor-pointer">
                  Assign to me
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* MY ASSIGNED */}
      <section>
        <h2 className="text-xl font-semibold mb-4 text-gray-800">My Assigned Jobs</h2>
        <div className="space-y-4">
          {myJobs.length === 0 ? (
            <p className="text-gray-500">You have no assigned jobs.</p>
          ) : (
            myJobs.map((job) => (
              <div key={job.id} className="p-4 border rounded shadow-sm bg-green-50">
                <p className="font-medium text-gray-900">{job.customerName || 'Customer'}</p>
                <p className="text-sm text-gray-700">{job.displayAddress}</p>
                <p className="text-sm text-gray-700">{job.date} at {job.displayTime}</p>
                {job.totalPrice != null && <p className="text-sm font-semibold text-green-700">£{job.totalPrice}</p>}
                <button onClick={() => removeFromMe(job.id)} className="mt-2 bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600 cursor-pointer">
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
