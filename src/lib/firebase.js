'use client';


// src/lib/firebase.js
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  // copy these from Firebase Console → luxen-cleaning → Project settings → Web app
  apiKey: process.env.NEXT_PUBLIC_FB_API_KEY,
  authDomain: 'luxen-cleaning.firebaseapp.com',
  projectId: 'luxen-cleaning',
  // Prefer the classic bucket host; both may work, but this is the standard:
  storageBucket: 'luxen-cleaning.appspot.com',
  messagingSenderId: '986923428354',
  appId: process.env.NEXT_PUBLIC_FB_APP_ID,
  // measurementId is optional and only used if you’ve added Analytics
  // measurementId: 'G-LDV2081BKD',
};

export const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
