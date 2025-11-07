'use client';

import { useEffect, useMemo, useState } from 'react';
import { auth, db } from '@/lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

type DayName = 'Monday'|'Tuesday'|'Wednesday'|'Thursday'|'Friday'|'Saturday'|'Sunday';

type Availability = Record<
  DayName,
  { available: boolean; from: string; to: string }
>;

type WizardKey =
  | 'homePostcode'
  | 'radiusMiles'
  | 'transportMode'
  | 'minNoticeHours'
  | 'travelBufferMins'
  | 'availability';

type WizardStep = {
  key: WizardKey;
  title: string;
  type: 'text' | 'number' | 'select' | 'availability';
  placeholder?: string;
  options?: string[];
  helper?: string;
};

export default function CompleteProfile({ onDone }: { onDone?: () => void }) {
  const steps: WizardStep[] = [
    {
      key: 'homePostcode',
      title: 'What is your home postcode?',
      type: 'text',
      placeholder: 'e.g., M1 2AB',
      helper: 'We use this to match you with nearby jobs.'
    },
    {
      key: 'radiusMiles',
      title: 'How far can you travel (miles)?',
      type: 'number',
      placeholder: 'e.g., 10',
      helper: 'Between 1–50 miles.'
    },
    {
      key: 'transportMode',
      title: 'How do you usually travel?',
      type: 'select',
      options: ['car', 'public', 'bike', 'walk'],
      helper: 'This helps us estimate travel time between bookings.'
    },
    {
      key: 'minNoticeHours',
      title: 'Minimum notice needed (hours)',
      type: 'select',
      options: ['0','6','12','24','36','48'],
      helper: 'Earliest we can schedule you from the time of booking.'
    },
    {
      key: 'travelBufferMins',
      title: 'Gap needed between jobs (minutes)',
      type: 'select',
      options: ['0','15','30','45','60','90'],
      helper: 'Time for travel and a short reset between bookings.'
    },
    {
      key: 'availability',
      title: 'Weekly availability',
      type: 'availability',
      helper: 'Tick the days you work and set start/end times.'
    },
  ];

  const inputCls =
    'w-full h-11 px-3 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0071bc]/30 focus:border-[#0071bc]';

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>('');

  const [homePostcode, setHomePostcode] = useState('');
  const [radiusMiles, setRadiusMiles] = useState('');
  const [transportMode, setTransportMode] = useState('');
  const [minNoticeHours, setMinNoticeHours] = useState('12');
  const [travelBufferMins, setTravelBufferMins] = useState('30');

  const [availability, setAvailability] = useState<Availability>({
    Monday:    { available: true,  from: '08:00', to: '18:00' },
    Tuesday:   { available: true,  from: '08:00', to: '18:00' },
    Wednesday: { available: true,  from: '08:00', to: '18:00' },
    Thursday:  { available: true,  from: '08:00', to: '18:00' },
    Friday:    { available: true,  from: '08:00', to: '18:00' },
    Saturday:  { available: false, from: '09:00', to: '16:00' },
    Sunday:    { available: false, from: '09:00', to: '16:00' },
  });

  const [step, setStep] = useState(0);

  // load existing (if any)
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'staff', uid));
        if (!snap.exists()) return;
        const data = snap.data() as Partial<{
          homePostcode: string;
          radiusMiles: number;
          transportMode: string;
          minNoticeHours: number;
          travelBufferMins: number;
          availability: Availability;
        }>;
        if (data.homePostcode) setHomePostcode(data.homePostcode);
        if (typeof data.radiusMiles === 'number') setRadiusMiles(String(data.radiusMiles));
        if (data.transportMode) setTransportMode(data.transportMode);
        if (typeof data.minNoticeHours === 'number') setMinNoticeHours(String(data.minNoticeHours));
        if (typeof data.travelBufferMins === 'number') setTravelBufferMins(String(data.travelBufferMins));
        if (data.availability) setAvailability(data.availability);
      } catch {
        // ignore
      }
    })();
  }, []);

  // helpers
  function isPostcodeUKish(v: string) {
    return /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/.test(v.trim());
  }

  const stepError = useMemo(() => {
    const k = steps[step].key;
    switch (k) {
      case 'homePostcode':
        return isPostcodeUKish(homePostcode) ? '' : 'Enter a valid UK postcode (e.g., M1 2AB).';
      case 'radiusMiles': {
        const n = Number(radiusMiles);
        if (!Number.isFinite(n)) return 'Please enter a number.';
        if (n <= 0 || n > 50) return 'Travel radius must be between 1–50 miles.';
        return '';
      }
      case 'transportMode':
        return transportMode ? '' : 'Please select a transport mode.';
      case 'minNoticeHours':
        return ['0','6','12','24','36','48'].includes(minNoticeHours) ? '' : 'Select a notice value.';
      case 'travelBufferMins':
        return ['0','15','30','45','60','90'].includes(travelBufferMins) ? '' : 'Select a buffer value.';
      case 'availability': {
        for (const [day, v] of Object.entries(availability) as [DayName, Availability[DayName]][]) {
          if (v.available) {
            if (!v.from || !v.to) return `Please set both times for ${day}.`;
            if (v.from >= v.to) return `${day}: end time must be after start time.`;
          }
        }
        return '';
      }
      default:
        return '';
    }
  }, [step, homePostcode, radiusMiles, transportMode, minNoticeHours, travelBufferMins, availability]);

  const isValid = !stepError;

  const next = () => {
    setErr('');
    if (!isValid) return;
    setStep((s) => Math.min(s + 1, steps.length - 1));
  };
  const back = () => {
    setErr('');
    setStep((s) => Math.max(s - 1, 0));
  };

  const save = async () => {
    if (!isValid) return;
    const uid = auth.currentUser?.uid;
    const email = auth.currentUser?.email || '';
    if (!uid) {
      setErr('Please log in first.');
      return;
    }
    try {
      setErr('');
      setLoading(true);

      const profile = {
        homePostcode: homePostcode.trim().toUpperCase(),
        radiusMiles: Number(radiusMiles),
        transportMode,
        minNoticeHours: Number(minNoticeHours),
        travelBufferMins: Number(travelBufferMins),
        availability,
        updatedAt: new Date().toISOString(),
      };

      await setDoc(
        doc(db, 'staff', uid),
        {
          role: 'cleaner',
          active: true,
          email,
          ...profile,
        },
        { merge: true }
      );

      await setDoc(
        doc(db, 'users', uid),
        {
          email,
          role: 'cleaner',
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

      // inform parent to re-check
      onDone?.();
      alert('Profile completed ✅');
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message || 'Failed to save profile.';
      setErr(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-white rounded-2xl shadow p-6 md:p-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-[#0071bc]">Complete Profile</h2>
          <div className="text-sm text-gray-700">
            Step <span className="font-medium">{step + 1}</span> / {steps.length}
          </div>
        </div>

        {err && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {err}
          </div>
        )}

        <div className="space-y-2">
          <div className="text-base font-medium text-gray-900">{steps[step].title}</div>
          {steps[step].helper && <div className="text-sm text-gray-700">{steps[step].helper}</div>}
        </div>

        <div className="mt-4">
          {steps[step].type === 'text' && steps[step].key === 'homePostcode' && (
            <input
              className={inputCls}
              placeholder={steps[step].placeholder || 'Type here…'}
              value={homePostcode}
              onChange={(e) => setHomePostcode(e.target.value)}
            />
          )}

          {steps[step].type === 'number' && steps[step].key === 'radiusMiles' && (
            <input
              className={inputCls}
              type="number"
              min={1}
              max={50}
              placeholder={steps[step].placeholder || '10'}
              value={radiusMiles}
              onChange={(e) => setRadiusMiles(e.target.value)}
            />
          )}

          {steps[step].type === 'select' && steps[step].key === 'transportMode' && (
            <select
              className={inputCls}
              value={transportMode}
              onChange={(e) => setTransportMode(e.target.value)}
            >
              <option value="">Select one</option>
              <option value="car">Car</option>
              <option value="public">Public transport</option>
              <option value="bike">Bike</option>
              <option value="walk">Walk</option>
            </select>
          )}

          {steps[step].type === 'select' && steps[step].key === 'minNoticeHours' && (
            <select
              className={inputCls}
              value={minNoticeHours}
              onChange={(e) => setMinNoticeHours(e.target.value)}
            >
              {['0','6','12','24','36','48'].map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          )}

          {steps[step].type === 'select' && steps[step].key === 'travelBufferMins' && (
            <select
              className={inputCls}
              value={travelBufferMins}
              onChange={(e) => setTravelBufferMins(e.target.value)}
            >
              {['0','15','30','45','60','90'].map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          )}

          {steps[step].type === 'availability' && (
            <div className="space-y-2 max-h-72 overflow-auto pr-1">
              {(Object.keys(availability) as DayName[]).map((day) => (
                <div
                  key={day}
                  className="flex flex-wrap items-center gap-2 border rounded-lg p-3"
                >
                  <div className="w-28 font-medium">{day}</div>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={availability[day].available}
                      onChange={(e) =>
                        setAvailability((prev) => ({
                          ...prev,
                          [day]: { ...prev[day], available: e.target.checked },
                        }))
                      }
                    />
                    Available
                  </label>
                  {availability[day].available && (
                    <div className="flex flex-wrap items-center gap-2 ml-auto">
                      <input
                        aria-label={`${day} start time`}
                        type="time"
                        className="h-10 px-2 rounded border border-gray-300 w-28"
                        value={availability[day].from}
                        onChange={(e) =>
                          setAvailability((prev) => ({
                            ...prev,
                            [day]: { ...prev[day], from: e.target.value },
                          }))
                        }
                      />
                      <span className="text-sm">–</span>
                      <input
                        aria-label={`${day} end time`}
                        type="time"
                        className="h-10 px-2 rounded border border-gray-300 w-28"
                        value={availability[day].to}
                        onChange={(e) =>
                          setAvailability((prev) => ({
                            ...prev,
                            [day]: { ...prev[day], to: e.target.value },
                          }))
                        }
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {stepError && <p className="mt-2 text-sm text-red-600">{stepError}</p>}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={back}
            disabled={step === 0}
            className={`px-4 py-2 rounded-md border ${
              step === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'
            }`}
          >
            Back
          </button>

          {step < steps.length - 1 ? (
            <button
              onClick={next}
              disabled={!isValid}
              className={`px-4 py-2 rounded-md text-white ${
                isValid ? 'bg-[#0071bc] hover:opacity-95' : 'bg-[#0071bc]/50 cursor-not-allowed'
              }`}
            >
              Next
            </button>
          ) : (
            <button
              onClick={save}
              disabled={!isValid || loading}
              className={`px-4 py-2 rounded-md text-white ${
                isValid && !loading ? 'bg-[#0071bc] hover:opacity-95' : 'bg-[#0071bc]/50 cursor-not-allowed'
              }`}
            >
              {loading ? 'Saving…' : 'Save Profile'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
