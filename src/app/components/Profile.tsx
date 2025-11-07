'use client';

import { useEffect, useState } from 'react';
import { auth, db } from '@/lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

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

  // new fields to show (all start undefined/false/empty)
  hasCar?: boolean;
  bringsSupplies?: boolean;
  equipment?: string[];            // keys from Jobs.tsx
  pets?: 'dogs'|'cats'|'none' | ''; // allow empty = none selected
  services?: string[];
  teamJobs?: boolean;
  rightToWorkUk?: boolean;
};

// Blank availability (nothing pre-ticked, no times)
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
  // Start from blank; only fill what exists
  const out: Record<DayName, DayAvail> = { ...blankAvailability };
  if (!raw || typeof raw !== 'object') return out;

  const map: Record<string, DayName> = {
    monday: 'Monday',
    tuesday: 'Tuesday',
    wednesday: 'Wednesday',
    thursday: 'Thursday',
    friday: 'Friday',
    saturday: 'Saturday',
    sunday: 'Sunday',
    Monday: 'Monday',
    Tuesday: 'Tuesday',
    Wednesday: 'Wednesday',
    Thursday: 'Thursday',
    Friday: 'Friday',
    Saturday: 'Saturday',
    Sunday: 'Sunday',
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

export default function Profile() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ProfileData>({
    name: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    homePostcode: '',
    radiusMiles: null,          // ← start blank
    minNoticeHours: null,       // ← start blank
    travelBufferMins: null,     // ← start blank
    availability: blankAvailability,

    hasCar: false,
    bringsSupplies: false,
    equipment: [],
    pets: '',                   // ← none selected
    services: [],
    teamJobs: false,
    rightToWorkUk: false,
  });

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

      // If no stored value, keep it blank (null). No hidden defaults.
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

        hasCar: !!staff.hasCar,
        bringsSupplies: !!staff.bringsSupplies,
        equipment: Array.isArray(staff.equipment) ? staff.equipment : [],
        pets:
          staff.pets === 'dogs' || staff.pets === 'cats' || staff.pets === 'none'
            ? staff.pets
            : '',
        services: Array.isArray(staff.services) ? staff.services : [],
        teamJobs: !!staff.teamJobs,
        rightToWorkUk: !!staff.rightToWorkUk,
      });

      setLoading(false);
    }
    load();
  }, []);

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


  // Helper to coerce blank -> null, numeric -> number
  function toNullableNumber(v: unknown): number | null {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

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

        // Do NOT inject defaults; keep null if blank
        radiusMiles: toNullableNumber(form.radiusMiles as number | string | null),
        minNoticeHours: toNullableNumber(form.minNoticeHours as number | string | null),
        travelBufferMins: toNullableNumber(form.travelBufferMins as number | string | null),

        availability: form.availability,

        // new fields
        hasCar: !!form.hasCar,
        bringsSupplies: !!form.bringsSupplies,
        equipment: Array.isArray(form.equipment) ? form.equipment : [],
        pets: form.pets || '', // empty string = none selected
        services: Array.isArray(form.services) ? form.services : [],
        teamJobs: !!form.teamJobs,
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
            <p className="text-xs text-gray-600 mb-1">(Optional)</p>
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
            <input name='name' className={input} placeholder="e.g., M1 2AB" value={form.homePostcode || ''} onChange={e=>setField('homePostcode', e.target.value)} />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Travel distance</label>
            <p className="text-xs text-gray-600 mb-1">(Approximate max distance from your home postcode, in miles)</p>
            <input
              className={input}
              type="number"
              min={1}
              max={50}
              placeholder="Radius (miles)"
              value={form.radiusMiles ?? ''}
              onChange={e=>setField('radiusMiles', e.target.value === '' ? null : Number(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-900 mb-0.5">Notice time before jobs</label>
            <p className="text-xs text-gray-600 mb-1">(How many hours’ notice you need before a job starts)</p>
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
            <p className="text-xs text-gray-600 mb-1">(Minimum gap you need between jobs, in minutes)</p>
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="inline-flex items-center gap-2 text-gray-800">
            <input type="checkbox" className="h-4 w-4" checked={!!form.hasCar} onChange={e=>setField('hasCar', e.target.checked)} />
            I have a car
          </label>
          <label className="inline-flex items-center gap-2 text-gray-800">
            <input type="checkbox" className="h-4 w-4" checked={!!form.bringsSupplies} onChange={e=>setField('bringsSupplies', e.target.checked)} />
            I bring my own supplies
          </label>
        </div>

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
                  className={`px-3 py-1.5 rounded border ${selected ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'}`}
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

        <div className="mb-3">
          <label className="block text-base font-semibold text-gray-900 mb-0.5">Comfortable with pets?</label>
          <p className="text-xs text-gray-600 mb-1">(Choose one or leave unselected)</p>
          <div className="flex gap-2">
            {(['dogs','cats','none'] as const).map(k => (
              <button
                key={k}
                type="button"
                onClick={()=>setField('pets', k)}
                className={`px-3 py-1.5 rounded border ${form.pets === k ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'}`}
              >
                {k === 'dogs' ? 'Dogs' : k === 'cats' ? 'Cats' : 'None'}
              </button>
            ))}
          </div>
        </div>

        <div>
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
                  className={`px-3 py-1.5 rounded border ${selected ? 'border-[#0071bc] text-[#0071bc]' : 'border-gray-300 text-gray-800'}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3">
          <label className="inline-flex items-center gap-2 text-gray-800">
            <input type="checkbox" className="h-4 w-4" checked={!!form.teamJobs} onChange={e=>setField('teamJobs', e.target.checked)} />
            Okay with team jobs
          </label>
        </div>
      </div>

      {/* Legal */}
      <div className="rounded-xl border bg-white p-4 md:p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Legal</h2>
        <p className="text-sm text-gray-700 mb-2">
          Confirm you’re legally allowed to work in the UK. You may be asked to provide proof.
        </p>
        <label className="inline-flex items-center gap-2 text-gray-800">
          <input type="checkbox" className="h-4 w-4" checked={!!form.rightToWorkUk} onChange={e=>setField('rightToWorkUk', e.target.checked)} />
          I have the right to work in the UK
        </label>
      </div>

      {/* Availability (kept same layout, starts blank) */}
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
    </div>
  );
}
