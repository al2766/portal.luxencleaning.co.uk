'use client';

import { useEffect, useMemo, useState } from 'react';
import { auth, db } from '@/lib/firebase';
import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  doc,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';

type Finance = {
  id: string;
  type: 'Expense' | 'Income';
  name: string;
  amount: number;
  frequency: string;
  paymentDay?: number; // day of month (1–31) for recurring payments
  startDate?: any;     // when a recurring payment started
  createdAt?: any;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(v: any): Date | null {
  if (!v) return null;
  try {
    if (v instanceof Date) return v;
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v === 'string') return new Date(v);
    if (v.seconds) return new Date(v.seconds * 1000);
  } catch {
    // ignore
  }
  return null;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function makeDateYMD(y: number, m: number, day: number) {
  const d = new Date(y, m + 1, 0); // last day of month
  const maxDay = d.getDate();
  const finalDay = Math.min(day, maxDay);
  const res = new Date(y, m, finalDay);
  res.setHours(0, 0, 0, 0);
  return res;
}

function getScheduleStart(item: Finance): Date | null {
  const sd = toDate((item as any).startDate);
  if (sd) return startOfDay(sd);
  const cd = toDate(item.createdAt);
  if (cd) return startOfDay(cd);
  return null;
}

function getPaymentDay(item: Finance, scheduleStart: Date) {
  if (typeof item.paymentDay === 'number' && !Number.isNaN(item.paymentDay)) {
    return item.paymentDay;
  }
  return scheduleStart.getDate();
}

function forEachOccurrenceInRange(
  item: Finance,
  scheduleStart: Date,
  freq: string,
  rangeStart: Date,
  rangeEnd: Date,
  cb: (d: Date) => void
) {
  const start = startOfDay(scheduleStart);
  const from = startOfDay(rangeStart);
  const to = startOfDay(rangeEnd);
  if (to < start) return;

  if (freq === 'Weekly') {
    let d = new Date(start);
    if (d < from) {
      const diffDays = Math.floor((from.getTime() - d.getTime()) / MS_PER_DAY);
      const weeksToAdd = Math.floor(diffDays / 7);
      d = new Date(d.getTime() + weeksToAdd * 7 * MS_PER_DAY);
      while (d < from) d = new Date(d.getTime() + 7 * MS_PER_DAY);
    }
    while (d <= to) {
      cb(new Date(d));
      d = new Date(d.getTime() + 7 * MS_PER_DAY);
    }
  } else if (freq === 'Monthly') {
    const day = getPaymentDay(item, start);
    let d = makeDateYMD(start.getFullYear(), start.getMonth(), day);
    if (d < start) {
      d = makeDateYMD(start.getFullYear(), start.getMonth() + 1, day);
    }
    while (d < from) {
      d = makeDateYMD(d.getFullYear(), d.getMonth() + 1, day);
    }
    while (d <= to) {
      cb(new Date(d));
      d = makeDateYMD(d.getFullYear(), d.getMonth() + 1, day);
    }
  } else if (freq === 'Yearly') {
    const day = getPaymentDay(item, start);
    const month = start.getMonth();
    let d = makeDateYMD(start.getFullYear(), month, day);
    if (d < start) {
      d = makeDateYMD(start.getFullYear() + 1, month, day);
    }
    while (d < from) {
      d = makeDateYMD(d.getFullYear() + 1, month, day);
    }
    while (d <= to) {
      cb(new Date(d));
      d = makeDateYMD(d.getFullYear() + 1, month, day);
    }
  }
}

export default function Finances() {
  const adminEmail = 'luxencleaninguk@gmail.com'; // <-- admin email
  const [items, setItems] = useState<Finance[]>([]);
  const [newItem, setNewItem] = useState<Partial<Finance> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [editingItem, setEditingItem] = useState<Finance | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<Finance> | null>(null);

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

  const {
    totalsAllTime,
    totalsMonth,
    monthlySeries,
    upcomingPayments,
  } = useMemo(() => {
    const today = startOfDay(new Date());
    const thisMonthYear = today.getFullYear();
    const thisMonthIndex = today.getMonth();
    const thisYear = thisMonthYear;

    const totalsAllTime = { expenses: 0, income: 0, profit: 0 };
    const totalsMonth = { expenses: 0, income: 0, profit: 0 };

    const months: {
      year: number;
      month: number;
      label: string;
      income: number;
      expenses: number;
    }[] = [];

    // 12 months of current year
    for (let m = 0; m < 12; m++) {
      months.push({
        year: thisYear,
        month: m,
        label: `${MONTH_NAMES_SHORT[m]} ${thisYear}`,
        income: 0,
        expenses: 0,
      });
    }

    const upcomingPayments: {
      id: string;
      name: string;
      type: 'Expense' | 'Income';
      amount: number;
      date: Date;
      frequency: string;
    }[] = [];

  // Start from tomorrow
const upcomingStart = new Date(today.getTime() + 1 * MS_PER_DAY);
// End after 8 days from today (i.e. tomorrow → 1 week ahead)
const upcomingEnd = new Date(today.getTime() + 8 * MS_PER_DAY);


    function addAmount(
      target: { income: number; expenses: number; profit: number },
      type: 'Expense' | 'Income',
      amount: number
    ) {
      if (type === 'Income') {
        target.income += amount;
      } else {
        target.expenses += amount;
      }
      target.profit = target.income - target.expenses;
    }

    items.forEach((item) => {
      const baseAmount = Number(item.amount) || 0;
      if (!baseAmount || !item.type) return;

      const freq = item.frequency || 'One-time';
      const scheduleStart = getScheduleStart(item);

      // ONE-TIME
      if (freq === 'One-time' || !scheduleStart) {
        const date = toDate(item.createdAt) || scheduleStart;
        if (!date) return;
        const d = startOfDay(date);

        if (d <= today) {
          addAmount(totalsAllTime, item.type, baseAmount);
        }

        const y = d.getFullYear();
        const m = d.getMonth();
        if (y === thisMonthYear && m === thisMonthIndex) {
          addAmount(totalsMonth, item.type, baseAmount);
        }

        months.forEach((month) => {
          if (month.year === y && month.month === m) {
            if (item.type === 'Income') month.income += baseAmount;
            else month.expenses += baseAmount;
          }
        });

        if (d >= upcomingStart && d <= upcomingEnd) {
          upcomingPayments.push({
            id: `${item.id}-${d.toISOString()}`,
            name: item.name,
            type: item.type,
            amount: baseAmount,
            date: d,
            frequency: freq,
          });
        }

        return;
      }

      // RECURRING
      // All-time: count occurrences from scheduleStart to today
      let countAllTime = 0;
      forEachOccurrenceInRange(item, scheduleStart, freq, scheduleStart, today, () => {
        countAllTime += 1;
      });
      if (countAllTime > 0) {
        addAmount(totalsAllTime, item.type, baseAmount * countAllTime);
      }

      // This month: occurrences in current month
      const monthStart = new Date(thisMonthYear, thisMonthIndex, 1);
      const monthEnd = new Date(thisMonthYear, thisMonthIndex + 1, 0);
      let countThisMonth = 0;
      forEachOccurrenceInRange(item, scheduleStart, freq, monthStart, monthEnd, () => {
        countThisMonth += 1;
      });
      if (countThisMonth > 0) {
        addAmount(totalsMonth, item.type, baseAmount * countThisMonth);
      }

      // Monthly series (12 months of current year)
      months.forEach((month) => {
        const rs = new Date(month.year, month.month, 1);
        const re = new Date(month.year, month.month + 1, 0);
        let cnt = 0;
        forEachOccurrenceInRange(item, scheduleStart, freq, rs, re, () => {
          cnt += 1;
        });
        if (cnt > 0) {
          const total = baseAmount * cnt;
          if (item.type === 'Income') month.income += total;
          else month.expenses += total;
        }
      });

      // Upcoming 7 days
      forEachOccurrenceInRange(item, scheduleStart, freq, upcomingStart, upcomingEnd, (d) => {
        upcomingPayments.push({
          id: `${item.id}-${d.toISOString()}`,
          name: item.name,
          type: item.type,
          amount: baseAmount,
          date: d,
          frequency: freq,
        });
      });
    });

    const monthlySeries = months.map((m) => ({
      ...m,
      profit: m.income - m.expenses,
    }));

    upcomingPayments.sort((a, b) => a.date.getTime() - b.date.getTime());

    return { totalsAllTime, totalsMonth, monthlySeries, upcomingPayments };
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

    // optional payment day (1–31)
    const paymentDayVal =
      newItem.paymentDay === undefined || newItem.paymentDay === null || (newItem as any).paymentDay === ''
        ? null
        : Number(newItem.paymentDay);

    const startDateVal =
      (newItem as any).startDate === undefined || (newItem as any).startDate === ''
        ? null
        : (newItem as any).startDate;

    setSaving(true);
    try {
      const ref = collection(db, 'finances');
      await addDoc(ref, {
        type: newItem.type,
        name: newItem.name,
        amount: Number(amountVal),
        frequency: newItem.frequency || 'One-time',
        paymentDay: paymentDayVal,
        startDate: startDateVal,
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

  async function deleteFinance(id: string) {
    if (!window.confirm('Delete this entry?')) return;
    try {
      await deleteDoc(doc(db, 'finances', id));
    } catch (e) {
      console.error('Failed to delete finance', e);
      alert('Failed to delete. See console for details.');
    }
  }

  function startEdit(item: Finance) {
    const startDateStr = item.startDate
      ? (toDate(item.startDate)?.toISOString().slice(0, 10) ?? '')
      : '';
    setEditingItem(item);
    setEditDraft({
      ...item,
      startDate: startDateStr,
    });
  }

  async function saveEdit() {
    if (!editingItem || !editDraft) return;
    if (!editDraft.name || !editDraft.type) {
      alert('Please fill name and type.');
      return;
    }
    const amountVal =
      editDraft.amount === '' || editDraft.amount === undefined || editDraft.amount === null
        ? NaN
        : Number(editDraft.amount);
    if (!Number.isFinite(amountVal) || amountVal <= 0) {
      alert('Please enter a valid positive amount.');
      return;
    }

    const paymentDayVal =
      editDraft.paymentDay === undefined || editDraft.paymentDay === null || (editDraft as any).paymentDay === ''
        ? null
        : Number(editDraft.paymentDay);

    const startDateVal =
      (editDraft as any).startDate === undefined || (editDraft as any).startDate === ''
        ? null
        : (editDraft as any).startDate;

    setSaving(true);
    try {
      const refDoc = doc(db, 'finances', editingItem.id);
      await updateDoc(refDoc, {
        type: editDraft.type,
        name: editDraft.name,
        amount: Number(amountVal),
        frequency: editDraft.frequency || 'One-time',
        paymentDay: paymentDayVal,
        startDate: startDateVal,
      });
      setEditingItem(null);
      setEditDraft(null);
    } catch (e) {
      console.error('Failed to update finance', e);
      alert('Failed to update. See console for details.');
    } finally {
      setSaving(false);
    }
  }

  const maxAbsMonthlyProfit = useMemo(() => {
    const vals = monthlySeries.map((m) => Math.abs(m.profit));
    const max = Math.max(...vals, 0);
    return max || 1;
  }, [monthlySeries]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[#0071bc]">Business Finances</h1>
        <p className="text-sm text-gray-700">Track income and expenses simply.</p>
      </div>

      {/* Summary cards: all-time + this month */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-white shadow-sm p-4 text-center">
          <div className="text-sm text-gray-600 mb-1">Income</div>
          <div className="text-xs text-gray-500">All time</div>
          <div className="text-lg font-semibold text-green-600">£{totalsAllTime.income.toFixed(2)}</div>
          <div className="mt-2 text-xs text-gray-500">This month</div>
          <div className="text-sm font-semibold text-green-700">£{totalsMonth.income.toFixed(2)}</div>
        </div>
        <div className="rounded-xl border bg-white shadow-sm p-4 text-center">
          <div className="text-sm text-gray-600 mb-1">Expenses</div>
          <div className="text-xs text-gray-500">All time</div>
          <div className="text-lg font-semibold text-red-600">£{totalsAllTime.expenses.toFixed(2)}</div>
          <div className="mt-2 text-xs text-gray-500">This month</div>
          <div className="text-sm font-semibold text-red-700">£{totalsMonth.expenses.toFixed(2)}</div>
        </div>
        <div className="rounded-xl border bg-white shadow-sm p-4 text-center">
          <div className="text-sm text-gray-600 mb-1">Net Balance</div>
          <div className="text-xs text-gray-500">All time</div>
          <div className={`text-lg font-semibold ${totalsAllTime.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            £{totalsAllTime.profit.toFixed(2)}
          </div>
          <div className="mt-2 text-xs text-gray-500">This month</div>
          <div className={`text-sm font-semibold ${totalsMonth.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            £{totalsMonth.profit.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Chart + upcoming payments */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Profit by month */}
        <div className="rounded-2xl border bg-white shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-gray-800">Profit by month</div>
            <div className="text-xs text-gray-500">Current year</div>
          </div>
          <div className="flex items-end gap-2 h-44">
            {monthlySeries.map((m) => {
              const heightPct = Math.round((Math.abs(m.profit) / maxAbsMonthlyProfit) * 100);
              const color =
                m.profit > 0 ? 'bg-green-500' : m.profit < 0 ? 'bg-red-500' : 'bg-gray-300';
              const amountColour =
                m.profit > 0 ? 'text-green-600' : m.profit < 0 ? 'text-red-600' : 'text-gray-500';
              return (
                <div key={m.label} className="flex-1 flex flex-col items-center text-xs">
                  <div className={`text-[11px] mb-1 font-medium ${amountColour}`}>
                    {m.profit === 0 ? '£0' : `${m.profit < 0 ? '-' : ''}£${Math.abs(m.profit).toFixed(0)}`}
                  </div>
                  <div className="flex-1 flex items-end justify-center w-full">
                    <div
                      className={`w-3 rounded-t-md ${color}`}
                      style={{ height: `${heightPct || 4}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-gray-600 text-center">
                    {m.label.split(' ')[0]}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Upcoming payments */}
        <div className="rounded-2xl border bg-white shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-gray-800">Upcoming payments</div>
            <div className="text-xs text-gray-500">Next 7 days</div>
          </div>
          {upcomingPayments.length === 0 ? (
            <div className="text-xs text-gray-500">
              No payments due in the next 7 days.
            </div>
          ) : (
            <ul className="space-y-2 text-xs">
              {upcomingPayments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 hover:bg-gray-50"
                >
                  <div>
                    <div className="font-medium text-gray-800">{p.name}</div>
                    <div className="text-gray-500">
                      {p.frequency} · {p.date.toLocaleDateString()}
                    </div>
                  </div>
                  <div
                    className={`text-sm font-semibold ${
                      p.type === 'Income' ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {p.type === 'Income' ? '+' : '-'}£{p.amount.toFixed(2)}
                  </div>
                </li>
              ))}
            </ul>
          )}
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
              <th className="text-left px-4 py-2 font-semibold">Payment day</th>
              <th className="text-left px-4 py-2 font-semibold">Start date</th>
              <th className="text-left px-4 py-2 font-semibold">Added</th>
              <th className="text-right px-4 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="text-center text-gray-500 py-3">Loading...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={8} className="text-center text-gray-500 py-3">No records yet.</td></tr>
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
                  <td className="px-4 py-2">{i.paymentDay ? `${i.paymentDay}` : '—'}</td>
                  <td className="px-4 py-2 text-gray-600 text-xs">
                    {i.startDate ? formatCreatedAt(i.startDate) : '—'}
                  </td>
                  <td className="px-4 py-2 text-gray-600 text-xs">
                    {formatCreatedAt(i.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        onClick={() => startEdit(i)}
                        className="text-xs px-3 py-1 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteFinance(i.id)}
                        className="text-xs px-3 py-1 rounded-md border border-red-200 text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
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

                {/* payment day input */}
                <td className="px-4 py-2" style={{ minWidth: 110 }}>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    className="border rounded px-2 py-1 w-full text-sm"
                    placeholder="Day"
                    value={
                      newItem.paymentDay === undefined || newItem.paymentDay === null || Number.isNaN(newItem.paymentDay)
                        ? ''
                        : String(newItem.paymentDay)
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      setNewItem({
                        ...newItem,
                        paymentDay: v === '' ? undefined : Number(v),
                      });
                    }}
                  />
                </td>

                {/* start date input */}
                <td className="px-4 py-2" style={{ minWidth: 130 }}>
                  <input
                    type="date"
                    className="border rounded px-2 py-1 w-full text-sm"
                    disabled={newItem.frequency === 'One-time'}
                    value={(newItem as any).startDate || ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNewItem({
                        ...newItem,
                        startDate: v || undefined,
                      });
                    }}
                  />
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
            onClick={() => setNewItem({ type: 'Expense', name: '', amount: undefined, frequency: 'One-time', paymentDay: undefined, startDate: undefined })}
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

      {/* Edit modal */}
      {editingItem && editDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-xl p-5 max-w-md w-full shadow-xl">
            <h2 className="text-sm font-semibold text-[#0071bc] mb-3">
              Edit entry
            </h2>
            <div className="space-y-3 text-sm">
              <div>
                <div className="mb-1 text-gray-700">Type</div>
                <select
                  className="text-gray-700 rounded px-2 py-1 w-full text-sm"
                  value={editDraft.type || ''}
                  onChange={(e) => setEditDraft({ ...editDraft, type: e.target.value as any })}
                >
                  <option value="">Select</option>
                  <option value="Expense">Expense</option>
                  <option value="Income">Income</option>
                </select>
              </div>
              <div>
                <div className="mb-1 text-gray-700">Name</div>
                <input
                  type="text"
                  className="text-gray-700 border rounded px-2 py-1 w-full text-sm"
                  value={editDraft.name ?? ''}
                  onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                />
              </div>
              <div>
                <div className="mb-1 text-gray-700">Amount (£)</div>
                <input
                  type="number"
                  step="0.01"
                  className="text-gray-700 border rounded px-2 py-1 w-full text-sm"
                  value={
                    editDraft.amount === undefined || Number.isNaN(editDraft.amount)
                      ? ''
                      : String(editDraft.amount)
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    setEditDraft({
                      ...editDraft,
                      amount: v === '' ? undefined : Number(v),
                    });
                  }}
                />
              </div>
              <div>
                <div className="mb-1 text-gray-700">Frequency</div>
                <select
                  className="text-gray-700 border rounded px-2 py-1 w-full text-sm"
                  value={editDraft.frequency || 'One-time'}
                  onChange={(e) => setEditDraft({ ...editDraft, frequency: e.target.value })}
                >
                  <option value="One-time">One-time</option>
                  <option value="Weekly">Weekly</option>
                  <option value="Monthly">Monthly</option>
                  <option value="Yearly">Yearly</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-gray-700">Payment day</div>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    className="text-gray-700 border rounded px-2 py-1 w-full text-sm"
                    value={
                      editDraft.paymentDay === undefined || editDraft.paymentDay === null || Number.isNaN(editDraft.paymentDay)
                        ? ''
                        : String(editDraft.paymentDay)
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      setEditDraft({
                        ...editDraft,
                        paymentDay: v === '' ? undefined : Number(v),
                      });
                    }}
                  />
                </div>
                <div>
                  <div className="mb-1 text-gray-700">Start date</div>
                  <input
                    type="date"
                    className="text-gray-700 border rounded px-2 py-1 w-full text-sm"
                    disabled={editDraft.frequency === 'One-time'}
                    value={(editDraft as any).startDate || ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEditDraft({
                        ...editDraft,
                        startDate: v || undefined,
                      });
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2 text-sm">
              <button
                onClick={() => {
                  setEditingItem(null);
                  setEditDraft(null);
                }}
                disabled={saving}
                className="px-4 py-2 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={saving}
                className="px-4 py-2 rounded-md bg-[#0071bc] text-white hover:opacity-95 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
