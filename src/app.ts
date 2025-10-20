// src/app.ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import clientRoutes from './routes/clientRoutes';
import businessRoutes from './routes/businessRoutes';
// NOTE: bookingRoutes is intentionally imported AFTER firebase admin init below
// import bookingRoutes from './routes/bookingRoutes';

import admin from 'firebase-admin';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Firebase Admin initialization (run once, before routes that use admin) ----------
if (!admin.apps.length) {
  try {
    // Priority order:
    // 1) FIREBASE_SERVICE_ACCOUNT_B64 = base64 of service-account JSON (recommended for .env)
    // 2) FIREBASE_SERVICE_ACCOUNT = raw JSON string (if you put full JSON into env)
    // 3) google default/app credentials (GOOGLE_APPLICATION_CREDENTIALS path or GCP default)
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64?.trim();
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();

    if (b64 && b64.length > 0) {
      // Option 1: decode base64 and parse JSON
      const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
      const serviceAccount = JSON.parse(jsonStr);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
      });
      console.log('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_B64 (base64).');
    } else if (raw && raw.length > 0) {
      // Option 2: raw JSON in env (less recommended because of newlines)
      const serviceAccount = JSON.parse(raw);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
      });
      console.log('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT (raw JSON env var).');
    } else {
      // Option 3: rely on GOOGLE_APPLICATION_CREDENTIALS env var (path) or default application credentials
      admin.initializeApp();
      console.log('Firebase Admin initialized using default application credentials (GOOGLE_APPLICATION_CREDENTIALS or GCP default).');
    }
  } catch (err) {
    // Log details for easier debugging but continue running (notifications will simply fail)
    console.error('Failed to initialize Firebase Admin SDK:', err);
  }
}
// -----------------------------------------------------------------------------------------

// Import booking routes after admin init so route modules that import `admin` get the initialized instance
import bookingRoutes from './routes/bookingRoutes';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/eduvision';
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
  });

app.use('/api/client', clientRoutes);
app.use('/api/businessInfo', businessRoutes);
app.use('/api/booking', bookingRoutes);

app.use((err: any, req: any, res: any, next: any) => {
  console.error('Global error handler:', err);
  res.status(err?.status || 500).json({
    success: false,
    message: err?.message || 'Internal Server Error',
  });
});

export default app;
