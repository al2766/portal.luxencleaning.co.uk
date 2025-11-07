'use client';

import { useEffect, useMemo, useState } from 'react';
import { auth, db } from '@/lib/firebase';
import { addDoc, collection, onSnapshot, orderBy, query, serverTimestamp } from 'firebase/firestore';

type Finance = {
  id: string;
  type: 'Expense' | 'Income';
  name: string;
  amount: number;
  frequency: string;
  createdAt?: any;
};

export default function Finances() {
  const adminEmail = 'luxencleaninguk@gmail.com'; // <-- admin email
  const [items, setItems] = useState<Finance[]>([]);
  const [newItem, setNewItem] = useState<Partial<Finance> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // If current user is not admin, avoid listening and clear loading
    if (auth.currentUser?.email !== adminEmail) {
      setLoading(false);
      setItems([]);
      return;
    }

    setLoading(true);
    const ref = collection(db, 'finances');
    const q = query(ref, orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const data: Finance[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        setItems(data);
        setLoading(false);
      },
      (err) => {
        console.error('Finances onSnapshot error', err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  // Guard UI for non-admin
  if (auth.currentUser?.email !== adminEmail) {
    return (
      <div className="text-gray-600 text-sm">
        Admin access only.
      </div>
    );
  }

  const totals = useMemo(() => {
    const expenses = items.filter(i => i.type === 'Expense').reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
    const income = items.filter(i => i.type === 'Income').reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
    return { expenses, income, profit: income - expenses };
  }, [items]);

  const formatCreatedAt = (v: any) => {
    if (!v) return '—';
    // Firestore Timestamp
    try {
      if (typeof v.toDate === 'function') {
        return v.toDate().toLocaleDateString();
      }
      // If object with seconds
      if (v.seconds) {
        return new Date(v.seconds * 1000).toLocaleDateString();
      }
    } catch {
      // ignore
    }
    return String(v);
  };

  async function addFinance() {
    if (!newItem) return;
    if (!newItem.name || !newItem.type) return alert('Please fill name and type.');
    const amountVal = newItem.amount === '' || newItem.amount === undefined || newItem.amount === null
      ? NaN
      : Number(newItem.amount);
    if (!Number.isFinite(amountVal) || amountVal <= 0) return alert('Please enter a valid positive amount.');

    setSaving(true);
    try {
      const ref = collection(db, 'finances');
      await addDoc(ref, {
        type: newItem.type,
        name: newItem.name,
        amount: Number(amountVal),
        frequency: newItem.frequency || 'One-time',
        createdAt: serverTimestamp(),
      });
      setNewItem(null);
      // success feedback
      alert('Saved ✅');
    } catch (e) {
      console.error('Failed to add finance', e);
      alert('Failed to save. See console for details.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[#0071bc]">Business Finances</h1>
        <p className="text-sm text-gray-700">Track income and expenses simply.</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-white shadow-sm p-4 text-center">
          <div className="text-sm text-gray-600">Total Income</div>
          <div className="text-lg font-semibold text-green-600">£{totals.income.toFixed(2)}</div>
        </div>
        <div className="rounded-xl border bg-white shadow-sm p-4 text-center">
          <div className="text-sm text-gray-600">Total Expenses</div>
          <div className="text-lg font-semibold text-red-600">£{totals.expenses.toFixed(2)}</div>
        </div>
        <div className="rounded-xl border bg-white shadow-sm p-4 text-center">
          <div className="text-sm text-gray-600">Net Balance</div>
          <div className={`text-lg font-semibold ${totals.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            £{totals.profit.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Table (horizontally scrollable) */}
      <div className="rounded-2xl border bg-white shadow-sm overflow-x-auto">
        <table className="min-w-[800px] w-full text-sm text-gray-800">
          <thead className="bg-gray-50 border-b text-gray-900">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">Type</th>
              <th className="text-left px-4 py-2 font-semibold">Name</th>
              <th className="text-left px-4 py-2 font-semibold">Amount (£)</th>
              <th className="text-left px-4 py-2 font-semibold">Frequency</th>
              <th className="text-left px-4 py-2 font-semibold">Added</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="text-center text-gray-500 py-3">Loading...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="text-center text-gray-500 py-3">No records yet.</td></tr>
            ) : (
              items.map((i) => (
                <tr key={i.id} className="border-b last:border-none hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${i.type === 'Expense' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                      {i.type}
                    </span>
                  </td>
                  <td className="px-4 py-2">{i.name}</td>
                  <td className="px-4 py-2">£{(Number(i.amount) || 0).toFixed(2)}</td>
                  <td className="px-4 py-2">{i.frequency || 'One-time'}</td>
                  <td className="px-4 py-2 text-gray-600 text-xs">
                    {formatCreatedAt(i.createdAt)}
                  </td>
                </tr>
              ))
            )}

            {/* Add new row (kept inside table for layout consistency) */}
            {newItem && (
              <tr className="bg-blue-50">
                <td className="px-4 py-2">
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={newItem.type || ''}
                    onChange={(e) => setNewItem({ ...newItem, type: e.target.value as any })}
                  >
                    <option value="">Select</option>
                    <option value="Expense">Expense</option>
                    <option value="Income">Income</option>
                  </select>
                </td>

                {/* Name cell made compact (~1/3 of previous wide) */}
                <td className="px-4 py-2" style={{ minWidth: 220 }}>
                  <input
                    type="text"
                    className="border rounded px-2 py-1 w-full text-sm"
                    placeholder="Name"
                    value={newItem.name ?? ''}
                    onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                  />
                </td>

                {/* Amount slightly wider than before */}
                <td className="px-4 py-2" style={{ minWidth: 140 }}>
                  <input
                    type="number"
                    step="0.01"
                    className="border rounded px-2 py-1 w-full text-sm"
                    placeholder="Amount"
                    // allow empty string for typing; store as undefined until valid
                    value={newItem.amount === undefined || Number.isNaN(newItem.amount) ? '' : String(newItem.amount)}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNewItem({ ...newItem, amount: v === '' ? undefined : Number(v) });
                    }}
                  />
                </td>

                <td className="px-4 py-2">
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={newItem.frequency || 'One-time'}
                    onChange={(e) => setNewItem({ ...newItem, frequency: e.target.value })}
                  >
                    <option value="One-time">One-time</option>
                    <option value="Weekly">Weekly</option>
                    <option value="Monthly">Monthly</option>
                    <option value="Yearly">Yearly</option>
                  </select>
                </td>

                <td className="px-4 py-2">
                  {/* empty; action buttons are rendered in normal control area below */}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add / cancel / add-button (now together, no sticky) */}
      <div className="text-right">
        {!newItem ? (
          <button
            onClick={() => setNewItem({ type: 'Expense', name: '', amount: undefined, frequency: 'One-time' })}
            className="bg-[#0071bc] text-white px-4 py-2 rounded-md hover:opacity-95"
          >
            + Add Entry
          </button>
        ) : (
          <div className="inline-flex items-center gap-2">
            <button
              onClick={() => setNewItem(null)}
              disabled={saving}
              className="text-gray-700 border border-gray-300 px-4 py-2 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>

            <button
              onClick={addFinance}
              disabled={saving}
              className="bg-[#0071bc] text-white px-4 py-2 rounded-md hover:opacity-95 disabled:opacity-50"
            >
              {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
