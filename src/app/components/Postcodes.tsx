'use client';

import { useEffect, useMemo, useState } from 'react';
import { auth, db } from '@/lib/firebase';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  doc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';

type CoveredPostcode = {
  id: string;          // doc id, e.g. "M19"
  outwardCode: string; // stored as full first-part postcode, e.g. "M19"
  createdAt?: any;
};

const ADMIN_EMAIL = 'luxencleaninguk@gmail.com';

// Normalise + validate postcode (first part only): 1–2 letters + 1–2 digits (e.g. M1, M19, LS2)
function normaliseOutward(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/\s+/g, '');
  const m = compact.match(/^([A-Z]{1,2})([0-9]{1,2})$/);
  if (!m) return null;
  return compact;
}

// Split outward code into area letters + numeric part
function splitOutward(code: string): { area: string; num: number } | null {
  const compact = code.toUpperCase().replace(/\s+/g, '');
  const m = compact.match(/^([A-Z]{1,2})([0-9]{1,2})$/);
  if (!m) return null;
  const area = m[1];
  const num = Number(m[2]);
  if (!Number.isFinite(num)) return null;
  return { area, num };
}

export default function CoveredPostcodesPage() {
  const [items, setItems] = useState<CoveredPostcode[]>([]);
  const [loading, setLoading] = useState(true);

  // single add
  const [singleCode, setSingleCode] = useState('');
  const [savingSingle, setSavingSingle] = useState(false);

  // range add
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [savingRange, setSavingRange] = useState(false);

  const currentEmail = auth.currentUser?.email || '';

  useEffect(() => {
    if (currentEmail !== ADMIN_EMAIL) {
      setLoading(false);
      setItems([]);
      return;
    }

    const ref = collection(db, 'postcodes');
    const q = query(ref, orderBy('outwardCode'));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const data: CoveredPostcode[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }));
        setItems(data);
        setLoading(false);
      },
      (err) => {
        console.error('postcodes onSnapshot error', err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [currentEmail]);

  if (currentEmail !== ADMIN_EMAIL) {
    return <div className="text-gray-600 text-sm">Admin access only.</div>;
  }

  const totalCount = items.length;

  // Preview for single postcode add
  const singlePreview = useMemo(() => {
    if (!singleCode.trim()) return '';
    const norm = normaliseOutward(singleCode);
    if (!norm) {
      return 'Enter a valid postcode (first part only, e.g. M19 or LS2).';
    }
    return `Will add: ${norm}`;
  }, [singleCode]);

  // Preview text for range
  const rangePreview = useMemo(() => {
    const startNorm = normaliseOutward(rangeStart || '');
    const endNorm = normaliseOutward(rangeEnd || '');

    if (!startNorm || !endNorm) return '';

    const a = splitOutward(startNorm);
    const b = splitOutward(endNorm);
    if (!a || !b) return '';

    if (a.area !== b.area) return 'The letter part must match (e.g. M19 → M21, not M19 → SK3).';

    const from = Math.min(a.num, b.num);
    const to = Math.max(a.num, b.num);

    if (from === to) return `${a.area}${from} (1 postcode)`;

    const count = to - from + 1;
    if (count > 100) return 'Range too large (max 100 postcodes at once).';

    const examples: string[] = [];
    for (let n = from; n <= to && examples.length < 3; n++) {
      examples.push(`${a.area}${n}`);
    }
    const exampleStr =
      count <= 3
        ? examples.join(', ')
        : `${examples.join(', ')} … ${a.area}${to}`;

    return `Will add: ${exampleStr} (${count} postcodes)`;
  }, [rangeStart, rangeEnd]);

  async function addSingle() {
    const norm = normaliseOutward(singleCode || '');
    if (!norm) {
      alert('Please enter a valid postcode (first part only, e.g. M19 or LS2).');
      return;
    }

    setSavingSingle(true);
    try {
      const ref = doc(db, 'postcodes', norm);
      await setDoc(
        ref,
        {
          outwardCode: norm,
          createdAt: serverTimestamp(),
        },
        { merge: true }
      );
      setSingleCode('');
      alert(`Added ${norm} ✅`);
    } catch (e) {
      console.error('Failed to add postcode', e);
      alert('Failed to add postcode. See console for details.');
    } finally {
      setSavingSingle(false);
    }
  }

  async function addRange() {
    const startNorm = normaliseOutward(rangeStart || '');
    const endNorm = normaliseOutward(rangeEnd || '');

    if (!startNorm || !endNorm) {
      alert('Please enter valid postcodes for both start and end (first part only).');
      return;
    }

    const a = splitOutward(startNorm);
    const b = splitOutward(endNorm);
    if (!a || !b) {
      alert('Invalid postcode(s). Use e.g. M19 or LS2 (first part only).');
      return;
    }

    if (a.area !== b.area) {
      alert('The letter part must match (e.g. M19 → M21, not M19 → SK3).');
      return;
    }

    const from = Math.min(a.num, b.num);
    const to = Math.max(a.num, b.num);
    const count = to - from + 1;

    if (count <= 0) return;
    if (count > 100) {
      alert('Please add at most 100 postcodes in one go.');
      return;
    }

    if (
      !confirm(
        `This will add ${count} postcodes from ${a.area}${from} to ${a.area}${to}. Continue?`
      )
    ) {
      return;
    }

    setSavingRange(true);
    try {
      const ops: Promise<any>[] = [];
      for (let n = from; n <= to; n++) {
        const outwardCode = `${a.area}${n}`;
        const ref = doc(db, 'postcodes', outwardCode);
        ops.push(
          setDoc(
            ref,
            {
              outwardCode,
              createdAt: serverTimestamp(),
            },
            { merge: true }
          )
        );
      }
      await Promise.all(ops);
      setRangeStart('');
      setRangeEnd('');
      alert('Postcodes added ✅');
    } catch (e) {
      console.error('Failed to add postcode range', e);
      alert('Failed to add postcodes. See console for details.');
    } finally {
      setSavingRange(false);
    }
  }

  async function removeCode(id: string) {
    if (!confirm(`Remove postcode ${id}?`)) return;
    try {
      await deleteDoc(doc(db, 'postcodes', id));
    } catch (e) {
      console.error('Failed to remove postcode', e);
      alert('Failed to remove. See console for details.');
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-[#0071bc]">Covered Postcodes</h1>
        <p className="text-sm text-gray-700">
          Define which postcode areas (first part only, e.g. M19, LS2) your service covers.
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-white shadow-sm p-4 text-center">
          <div className="text-sm text-gray-600">Total Covered Postcode Areas</div>
          <div className="text-lg font-semibold text-[#0071bc]">
            {totalCount}
          </div>
        </div>
      </div>

      {/* Single add */}
      <div className="rounded-2xl border bg-white shadow-sm p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[#0071bc]">
          Add a single postcode area
        </h2>
        <div className="flex flex-col sm:flex-row gap-3 items-end">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Postcode (first part only)
            </label>
            <input
              type="text"
              maxLength={4}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-800"
              placeholder="e.g. M19 or LS2"
              value={singleCode}
              onChange={(e) => setSingleCode(e.target.value.toUpperCase())}
            />
          </div>
          <button
            onClick={addSingle}
            disabled={savingSingle}
            className="bg-[#0071bc] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-95 disabled:opacity-60 w-full sm:w-auto"
          >
            {savingSingle ? 'Adding…' : 'Add postcode'}
          </button>
        </div>
        {singlePreview && (
          <p className="text-xs text-gray-600">
            {singlePreview}
          </p>
        )}
        <p className="text-xs text-gray-500">
          Format: 1–2 letters + 1–2 digits (e.g. <span className="font-mono">M1</span>,{' '}
          <span className="font-mono">M19</span>, <span className="font-mono">LS2</span>). Use the first part of the postcode only.
        </p>
      </div>

      {/* Range add */}
      <div className="rounded-2xl border bg-white shadow-sm p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[#0071bc]">
          Add a range of postcode areas
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              From (first part)
            </label>
            <input
              type="text"
              maxLength={4}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-800"
              placeholder="e.g. M19"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              To (first part)
            </label>
            <input
              type="text"
              maxLength={4}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-800"
              placeholder="e.g. M21"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(e.target.value.toUpperCase())}
            />
          </div>
          <div className="flex sm:justify-end">
            <button
              onClick={addRange}
              disabled={savingRange}
              className="bg-[#0071bc] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-95 disabled:opacity-60 w-full sm:w-auto"
            >
              {savingRange ? 'Adding…' : 'Add range'}
            </button>
          </div>
        </div>

        {rangePreview && (
          <div className="text-xs text-gray-600">
            {rangePreview}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="rounded-2xl border bg-white shadow-sm overflow-x-auto">
        <table className="min-w-[520px] w-full text-sm text-gray-800">
          <thead className="bg-gray-50 border-b text-gray-900">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">Postcode Area (first part)</th>
              <th className="text-left px-4 py-2 font-semibold">Added</th>
              <th className="text-left px-4 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={3} className="px-4 py-3 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-3 text-center text-gray-500">
                  No postcodes yet. Add a postcode above.
                </td>
              </tr>
            ) : (
              items.map((pc) => (
                <tr
                  key={pc.id}
                  className="border-b last:border-none hover:bg-gray-50"
                >
                  <td className="px-4 py-2 font-medium">{pc.outwardCode}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {pc.createdAt &&
                    typeof (pc.createdAt as any).toDate === 'function'
                      ? (pc.createdAt as any).toDate().toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => removeCode(pc.id)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
