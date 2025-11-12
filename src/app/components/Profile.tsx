'use client';

import { useEffect, useState, useRef } from 'react';
import { auth, db } from '@/lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

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

type DayName = 'Monday'|'Tuesday'|'Wednesday'|'Thursday'|'Friday'|'Saturday'|'Sunday';
type DayAvail = { available: boolean; from: string; to: string };

type ProfileData = {
  name: string;
  email: string;
  phone: string;
  dateOfBirth?: string;

  homePostcode?: string;
  radiusMiles?: number | null;
  minNoticeHours?: number | null;
  travelBufferMins?: number | null;
  availability: Record<DayName, DayAvail>;

  hasCar?: boolean | null;
  bringsSupplies?: boolean | null;
  equipment?: string[];
  pets?: string[]; // Changed to array for multi-select
  services?: string[];
  teamJobs?: boolean | null;
  rightToWorkUk?: boolean;
};

const blankAvailability: Record<DayName, DayAvail> = {
  Monday:    { available: false, from: '', to: '' },
  Tuesday:   { available: false, from: '', to: '' },
  Wednesday: { available: false, from: '', to: '' },
  Thursday:  { available: false, from: '', to: '' },
  Friday:    { available: false, from: '', to: '' },
  Saturday:  { available: false, from: '', to: '' },
  Sunday:    { available: false, from: '', to: '' },
};

function normalizeAvailability(raw: any): Record<DayName, DayAvail> {
  const out: Record<DayName, DayAvail> = { ...blankAvailability };
  if (!raw || typeof raw !== 'object') return out;

  const map: Record<string, DayName> = {
    monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
    friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
    Monday: 'Monday', Tuesday: 'Tuesday', Wednesday: 'Wednesday', Thursday: 'Thursday',
    Friday: 'Friday', Saturday: 'Saturday', Sunday: 'Sunday',
  };

  for (const k of Object.keys(raw)) {
    const day = map[k];
    if (!day) continue;
    const v = raw[k];
    if (v && typeof v === 'object') {
      out[day] = {
        available: Boolean(v.available),
        from: typeof v.from === 'string' ? v.from : (v.startTime || ''),
        to:   typeof v.to   === 'string' ? v.to   : (v.endTime   || ''),
      };
    }
  }
  return out;
}

function isPostcodeUKish(v: string) {
  return /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/.test((v || '').trim());
}

function milesToMeters(mi: number) { return mi * 1609.34; }

function circleBoundsFromMiles(center: [number, number], miles: number) {
  const [lat, lon] = center;
  const meters = miles * 1609.34;
  const dLat = meters / 111_320;
  const dLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
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
  fitBounds?: (bounds: [[number, number], [number, number]], options?: any) => void;
};

export default function Profile() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ProfileData>({
    name: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    homePostcode: '',
    radiusMiles: null,
    minNoticeHours: null,
    travelBufferMins: null,
    availability: blankAvailability,
    hasCar: null,
    bringsSupplies: null,
    equipment: [],
    pets: [],
    services: [],
    teamJobs: null,
    rightToWorkUk: false,
  });

  // Modal for setting radius with map
  const [radiusOpen, setRadiusOpen] = useState(false);
  const [tempMiles, setTempMiles] = useState<number>(10);
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const mapRef = useRef<LeafletMapLike | null>(null);

  useEffect(() => {
    async function load() {
      const uid = auth.currentUser?.uid;
      if (!uid) { setLoading(false); return; }

      const sRef = doc(db, 'staff', uid);
      const sSnap = await getDoc(sRef);

      const uRef = doc(db, 'users', uid);
      const uSnap = await getDoc(uRef);

      const staff = sSnap.exists() ? (sSnap.data() as any) : {};
      const user = uSnap.exists() ? (uSnap.data() as any) : {};

      const availability = normalizeAvailability(staff.availability || {});

      const radiusMiles =
        typeof staff.radiusMiles === 'number'
          ? staff.radiusMiles
          : typeof staff.radiusMiles === 'string' && staff.radiusMiles !== ''
          ? Number(staff.radiusMiles)
          : typeof staff.radiusKm === 'number'
          ? Math.round(staff.radiusKm * 0.621371)
          : null;

      const minNoticeHours =
        typeof staff.minNoticeHours === 'number'
          ? staff.minNoticeHours
          : (staff.minNoticeHours === '' || staff.minNoticeHours == null)
          ? null
          : Number(staff.minNoticeHours);

      const travelBufferMins =
        typeof staff.travelBufferMins === 'number'
          ? staff.travelBufferMins
          : (staff.travelBufferMins === '' || staff.travelBufferMins == null)
          ? null
          : Number(staff.travelBufferMins);

      const hasCar = typeof staff.hasCar === 'boolean' ? staff.hasCar : null;
      const bringsSupplies = typeof staff.bringsSupplies === 'boolean' ? staff.bringsSupplies : null;
      const teamJobs = typeof staff.teamJobs === 'boolean' ? staff.teamJobs : null;
      const pets = Array.isArray(staff.pets) ? staff.pets : [];

      setForm({
        name: (user.name || staff.name || '').trim(),
        email: user.email || staff.email || auth.currentUser?.email || '',
        phone: user.phone || staff.phone || '',
        dateOfBirth: staff.dateOfBirth || '',
        homePostcode: staff.homePostcode || '',
        radiusMiles,
        minNoticeHours,
        travelBufferMins,
        availability,
        hasCar,
        bringsSupplies,
        equipment: Array.isArray(staff.equipment) ? staff.equipment : [],
        pets,
        services: Array.isArray(staff.services) ? staff.services : [],
        teamJobs,
        rightToWorkUk: !!staff.rightToWorkUk,
      });

      setLoading(false);
    }
    load();
  }, []);

  // Open modal and prepare state
  const openRadiusModal = async () => {
    setTempMiles(form.radiusMiles ?? 10);
    if (isPostcodeUKish(form.homePostcode || '')) {
      try {
        setGeoLoading(true);
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(form.homePostcode!)}&countrycodes=gb&limit=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        const json = await res.json();
        if (Array.isArray(json) && json.length > 0) {
          const { lat, lon } = json[0];
          setMapCenter([parseFloat(lat), parseFloat(lon)]);
        } else {
          setMapCenter(null);
        }
      } catch {
        setMapCenter(null);
      } finally {
        setGeoLoading(false);
      }
    } else {
      setMapCenter(null);
    }
    setRadiusOpen(true);
  };

  // Smooth fit when mapCenter or tempMiles change
  useEffect(() => {
    if (!mapRef.current || !mapRef.current.fitBounds || !mapCenter) return;
    const bounds = circleBoundsFromMiles(mapCenter, tempMiles || 1);
    // @ts-ignore leaflet options typing
    mapRef.current.fitBounds(bounds, { padding: [24, 24], animate: true, duration: 0.8 });
  }, [mapCenter, tempMiles, radiusOpen]);

  function setField<K extends keyof ProfileData>(key: K, value: ProfileData[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function setDay(day: DayName, field: keyof DayAvail, value: DayAvail[typeof field]) {
    setForm(prev => {
      const cur = prev.availability[day];
      if (field === 'available') {
        const makeOn = Boolean(value);
        return {
          ...prev,
          availability: {
            ...prev.availability,
            [day]: {
              available: makeOn,
              from: makeOn ? (cur.from || '07:00') : '',
              to:   makeOn ? (cur.to   || '20:00') : '',
            },
          },
        };
      }
      return {
        ...prev,
        availability: {
          ...prev.availability,
          [day]: { ...cur, [field]: value },
        },
      };
    });
  }

  function toNullableNumber(v: unknown): number | null {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  const toggleIn = (list: string[], value: string) => {
    const newList = list.includes(value) ? list.filter(v => v !== value) : [...list, value];
    return newList;
  };

  const save = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return alert('Not signed in');

    await setDoc(
      doc(db, 'staff', uid),
      {
        email: form.email,
        phone: form.phone,
        name: form.name,
        dateOfBirth: form.dateOfBirth || null,
        homePostcode: (form.homePostcode || '').toUpperCase().trim(),
        radiusMiles: toNullableNumber(form.radiusMiles as number | string | null),
        minNoticeHours: toNullableNumber(form.minNoticeHours as number | string | null),
        travelBufferMins: toNullableNumber(form.travelBufferMins as number | string | null),
        availability: form.availability,
        hasCar: form.hasCar === true,
        bringsSupplies: form.bringsSupplies === true,
        equipment: Array.isArray(form.equipment) ? form.equipment : [],
        pets: Array.isArray(form.pets) ? form.pets : [],
        services: Array.isArray(form.services) ? form.services : [],
        teamJobs: form.teamJobs === true,
        rightToWorkUk: !!form.rightToWorkUk,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    await setDoc(
      doc(db, 'users', uid),
      {
        name: form.name,
        phone: form.phone,
        email: form.email,
        role: 'cleaner',
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    alert('Profile saved ✅');
  };

  if (loading) {
    return <div className="text-sm text-gray-600">Loading profile…</div>;
  }

  const input = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#0071bc]/30';

  return (
    <div className="space-y-6">
      {/* Basics */}
      <div className="rounded-xl border bg-white p-4 md:p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Profile</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Name</label>
            <input className={input} placeholder="Full name" value={form.name} onChange={e=>setField('name', e.target.value)} />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Email</label>
            <input className={input} placeholder="Email" value={form.email} onChange={e=>setField('email', e.target.value)} />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Phone</label>
            <input className={input} placeholder="Phone" value={form.phone} onChange={e=>setField('phone', e.target.value)} />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Date of Birth</label>
            <input className={input} type="date" placeholder="DOB" value={form.dateOfBirth || ''} onChange={e=>setField('dateOfBirth', e.target.value)} />
          </div>
        </div>
      </div>

      {/* Ops settings */}
      <div className="rounded-xl border bg-white p-4 md:p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Operational Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Postcode</label>
            <p className="text-xs text-gray-600 mb-1">(Used to match you with nearby jobs)</p>
            <input className={input} placeholder="e.g., M1 2AB" value={form.homePostcode || ''} onChange={e=>setField('homePostcode', e.target.value)} />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Travel distance</label>
            <p className="text-xs text-gray-600 mb-1">(Miles from home)</p>

            {/* REPLACED INPUT WITH BUTTON THAT OPENS MODAL */}
            <button
              type="button"
              onClick={openRadiusModal}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 hover:bg-gray-50"
            >
              {form.radiusMiles ? `${form.radiusMiles} mile${form.radiusMiles === 1 ? '' : 's'}` : 'Set travel radius'}
            </button>
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Notice time</label>
            <p className="text-xs text-gray-600 mb-1">(Hours before job)</p>
            <input
              className={input}
              type="number"
              min={0}
              placeholder="Hours"
              value={form.minNoticeHours ?? ''}
              onChange={e=>setField('minNoticeHours', e.target.value === '' ? null : Number(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Time between jobs</label>
            <p className="text-xs text-gray-600 mb-1">(Gap in minutes)</p>
            <input
              className={input}
              type="number"
              min={0}
              placeholder="Minutes"
              value={form.travelBufferMins ?? ''}
              onChange={e=>setField('travelBufferMins', e.target.value === '' ? null : Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      {/* Transport & Equipment */}
      <div className="rounded-xl border bg-white p-4 md:p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Transport & Equipment</h2>
        
        {/* Has Car - Yes/No */}
        <div className="mb-3">
          <label className="block text-base font-semibold text-gray-900 mb-1">Do you have a car?</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setField('hasCar', false)}
              className={`px-3 py-1.5 rounded border cursor-pointer ${
                form.hasCar === false ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'
              }`}
            >
              No
            </button>
            <button
              type="button"
              onClick={() => setField('hasCar', true)}
              className={`px-3 py-1.5 rounded border cursor-pointer ${
                form.hasCar === true ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'
              }`}
            >
              Yes
            </button>
          </div>
        </div>

        {/* Brings Supplies - Yes/No */}
        <div className="mb-3">
          <label className="block text-base font-semibold text-gray-900 mb-1">Do you have your own supplies?</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setField('bringsSupplies', false)}
              className={`px-3 py-1.5 rounded border cursor-pointer ${
                form.bringsSupplies === false ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'
              }`}
            >
              No
            </button>
            <button
              type="button"
              onClick={() => setField('bringsSupplies', true)}
              className={`px-3 py-1.5 rounded border cursor-pointer ${
                form.bringsSupplies === true ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'
              }`}
            >
              Yes
            </button>
          </div>
        </div>

        {/* Equipment */}
        <div className="mt-3">
          <label className="block text-base font-semibold text-gray-900 mb-0.5">Equipment you can bring</label>
          <p className="text-xs text-gray-600 mb-1">(Select all that apply)</p>
          <div className="flex flex-wrap gap-2">
            {[
              ['vacuum','Vacuum cleaner'],
              ['mopBucket','Mop & bucket'],
              ['duster','Duster'],
              ['broomDustpan','Broom & dustpan'],
              ['microfibre','Microfibre cloths'],
              ['spotCleaner','Carpet spot cleaner (handheld)'],
              ['none','None of the above'],
            ].map(([key,label]) => {
              const selected = !!form.equipment?.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={()=>{
                    const curr = Array.isArray(form.equipment) ? [...form.equipment] : [];
                    if (key === 'none') {
                      setField('equipment', ['none']);
                    } else {
                      const next = curr.includes('none') ? [] : curr;
                      const i = next.indexOf(key);
                      if (i >= 0) next.splice(i,1); else next.push(key);
                      setField('equipment', next);
                    }
                  }}
                  className={`px-3 py-1.5 rounded border cursor-pointer ${selected ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Services & Preferences */}
      <div className="rounded-xl border bg-white p-4 md:p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Services & Preferences</h2>

        {/* Pet Allergies - Yes/No with multi-select */}
        <div className="mb-3">
          <label className="block text-base font-semibold text-gray-900 mb-1">Are you allergic to any animals?</label>
          <div className="space-y-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setField('pets', [])}
                className={`px-3 py-1.5 rounded border cursor-pointer ${
                  form.pets?.length === 0 ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'
                }`}
              >
                No
              </button>
              <button
                type="button"
                onClick={() => {
                  if (form.pets?.length === 0) setField('pets', ['dogs']);
                }}
                className={`px-3 py-1.5 rounded border cursor-pointer ${
                  (form.pets?.length ?? 0) > 0 ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'
                }`}
              >
                Yes
              </button>
            </div>
            
            {(form.pets?.length ?? 0) > 0 && (
              <div>
                <p className="text-sm text-gray-700 mb-2">Select all animals you're allergic to:</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    ['dogs','Dogs'],
                    ['cats','Cats'],
                    ['birds','Birds'],
                    ['rabbits','Rabbits'],
                    ['rodents','Rodents (hamsters, guinea pigs, etc.)'],
                    ['reptiles','Reptiles'],
                    ['horses','Horses'],
                  ].map(([key,label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        const curr = Array.isArray(form.pets) ? [...form.pets] : [];
                        if (curr.includes(key)) {
                          const remaining = curr.filter(p => p !== key);
                          setField('pets', remaining.length > 0 ? remaining : [key]);
                        } else {
                          setField('pets', [...curr, key]);
                        }
                      }}
                      className={`px-3 py-1.5 rounded border cursor-pointer ${
                        form.pets?.includes(key) ? 'border-[#0071bc] bg-[#0071bc] text-white' : 'border-gray-300 text-gray-800 hover:border-gray-400'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-600 mt-2">Click to select/deselect. You can choose multiple.</p>
              </div>
            )}
          </div>
        </div>

        {/* Services */}
        <div className="mb-3">
          <label className="block text-base font-semibold text-gray-900 mb-0.5">Service types</label>
          <p className="text-xs text-gray-600 mb-1">(Select all that you can do)</p>
          <div className="flex flex-wrap gap-2">
            {[
              ['standard','Standard clean'],
              ['deep','Deep clean'],
              ['eot','End of tenancy / Move-out'],
              ['oven','Oven clean'],
              ['fridge','Fridge clean'],
              ['laundry','Laundry / Ironing'],
              ['spotClean','Carpet / Upholstery spot clean'],
            ].map(([key,label]) => {
              const selected = (form.services || []).includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={()=>{
                    const curr = Array.isArray(form.services) ? [...form.services] : [];
                    const i = curr.indexOf(key);
                    if (i >= 0) curr.splice(i,1); else curr.push(key);
                    setField('services', curr);
                  }}
                  className={`px-3 py-1.5 rounded border cursor-pointer ${selected ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Team Jobs - Yes/No */}
        <div className="mt-3">
          <label className="block text-base font-semibold text-gray-900 mb-1">Okay with team jobs?</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setField('teamJobs', false)}
              className={`px-3 py-1.5 rounded border cursor-pointer ${
                form.teamJobs === false ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'
              }`}
            >
              No
            </button>
            <button
              type="button"
              onClick={() => setField('teamJobs', true)}
              className={`px-3 py-1.5 rounded border cursor-pointer ${
                form.teamJobs === true ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'
              }`}
            >
              Yes
            </button>
          </div>
        </div>
      </div>

      {/* Legal */}
      <div className="rounded-xl border bg-white p-4 md:p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Legal</h2>
        <p className="text-sm text-gray-700 mb-2">
          Confirm you're legally allowed to work in the UK. You may be asked to provide proof.
        </p>
        <label className="inline-flex items-center gap-2 text-gray-800">
          <input type="checkbox" className="h-4 w-4" checked={!!form.rightToWorkUk} onChange={e=>setField('rightToWorkUk', e.target.checked)} />
          I have the right to work in the UK
        </label>
      </div>

      {/* Availability */}
      <div className="rounded-xl border bg-white p-4 md:p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Weekly Availability</h2>
        <div className="space-y-2">
          {(Object.keys(form.availability) as DayName[]).map((day) => (
            <div key={day} className="flex flex-wrap items-center gap-2 border rounded-lg p-3">
              <div className="w-28 font-medium text-gray-900">{day}</div>
              <label className="inline-flex items-center gap-2 text-gray-800">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={form.availability[day].available}
                  onChange={(e) => setDay(day, 'available', e.target.checked)}
                />
                Available
              </label>
              {form.availability[day].available && (
                <div className="flex flex-wrap items-center gap-2 ml-auto">
                  <input
                    aria-label={`${day} start time`}
                    type="time"
                    className="h-10 px-2 rounded border border-gray-300 w-28 text-gray-900"
                    value={form.availability[day].from}
                    onChange={(e) => setDay(day, 'from', e.target.value)}
                  />
                  <span className="text-sm text-gray-800">–</span>
                  <input
                    aria-label={`${day} end time`}
                    type="time"
                    className="h-10 px-2 rounded border border-gray-300 w-28 text-gray-900"
                    value={form.availability[day].to}
                    onChange={(e) => setDay(day, 'to', e.target.value)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="text-right">
        <button onClick={save} className="rounded-md bg-[#0071bc] text-white px-4 py-2 hover:opacity-95">
          Save
        </button>
      </div>

      {/* Radius modal */}
      {radiusOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold text-gray-900">Set travel radius</div>
              <button
                className="cursor-pointer rounded-md px-2 py-1 text-sm text-gray-700 hover:bg-gray-100"
                onClick={() => setRadiusOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="text-sm text-gray-700 mb-2">
              Postcode: <span className="font-medium">{form.homePostcode || '—'}</span>
            </div>

            <div className="flex items-center gap-3 mb-3">
              <button
                type="button"
                className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-gray-900 text-white text-lg font-bold hover:opacity-90 cursor-pointer"
                onClick={() => setTempMiles(m => Math.max(1, Math.min(50, Math.round(m - 1))))}
                aria-label="Decrease miles"
              >
                −
              </button>
              <div className="text-sm font-semibold text-gray-900 min-w-[90px] text-center">
                {tempMiles} mile{tempMiles === 1 ? '' : 's'}
              </div>
              <button
                type="button"
                className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[#0071bc] text-white text-lg font-bold hover:opacity-95 cursor-pointer"
                onClick={() => setTempMiles(m => Math.max(1, Math.min(50, Math.round(m + 1))))}
                aria-label="Increase miles"
              >
                +
              </button>
            </div>

            <div className="h-64 w-full overflow-hidden rounded-xl border border-gray-200">
              {!isPostcodeUKish(form.homePostcode || '') ? (
                <div className="h-full w-full flex items-center justify-center text-sm text-gray-800">
                  Enter a valid UK postcode first
                </div>
              ) : !mapCenter ? (
                <div className="h-full w-full flex items-center justify-center text-sm text-gray-800">
                  {geoLoading ? 'Locating postcode…' : 'Unable to locate postcode'}
                </div>
              ) : (
                <MapContainer
                  center={mapCenter}
                  zoom={12}
                  whenCreated={(m) => { mapRef.current = m as unknown as LeafletMapLike; }}
                  style={{ height: '100%', width: '100%' }}
                  scrollWheelZoom
                >
                  <TileLayer
                    attribution='&copy; OpenStreetMap contributors &copy; CARTO'
                    url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                  />
                  <Circle center={mapCenter} radius={20} pathOptions={{ color: '#111827', fillColor: '#111827', fillOpacity: 0.9 }} />
                  <Circle center={mapCenter} radius={milesToMeters(tempMiles)} pathOptions={{ color: '#0ea5e9', fillColor: '#38bdf8', fillOpacity: 0.12 }} />
                </MapContainer>
              )}
            </div>

            <div className="mt-4 text-right">
              <button
                onClick={() => { setField('radiusMiles', tempMiles); setRadiusOpen(false); }}
                className="rounded-md bg-[#0071bc] text-white px-3 py-2 hover:opacity-95"
              >
                Save radius
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
