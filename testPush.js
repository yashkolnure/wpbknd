// One-off helper to verify push notifications end-to-end against the LOCAL server.
//   Usage:  node testPush.js <userId|email>
//           node testPush.js                 (auto-picks the most recent user with a token)
//
// Safe to delete once notifications are confirmed working.
import 'dotenv/config';
import admin from 'firebase-admin';
import fs from 'fs';
import mongoose from 'mongoose';
import User from './models/User.js';
import { sendPushNotification } from './services/notificationService.js';

// This is a standalone process, so initialize Firebase Admin the same way
// server.js does (the running server's init doesn't carry over here).
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    fs.readFileSync(new URL('./serviceAccountKey.json', import.meta.url)),
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('🔥 Firebase Admin initialized for', serviceAccount.project_id);
}

const arg = process.argv[2];

await mongoose.connect(process.env.MONGO_URI);

// `node testPush.js token <fcmToken>` — send straight to one device token,
// bypassing the (shared, churny) DB token list. Pure delivery test.
if (arg === 'token') {
  const tok = process.argv[3];
  try {
    const id = await admin.messaging().send({
      notification: { title: 'WPLeads', body: 'Direct push test — it works! 🎉' },
      data: { type: 'test' },
      token: tok,
    });
    console.log('✅ Sent OK, messageId:', id);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.log('❌ Send failed:', e.code, '-', e.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// `node testPush.js list <userId>` — dump the user's tokens and exit.
if (arg === 'list') {
  const u = await User.findById(process.argv[3]);
  console.log('User:', u?.email, u?._id?.toString());
  (u?.fcmTokens || []).forEach((t, i) => console.log(`  [${i}] ${t.slice(0, 30)}…  (len ${t.length})`));
  await mongoose.disconnect();
  process.exit(0);
}

let user;
if (arg && arg.includes('@')) {
  user = await User.findOne({ email: arg });
} else if (arg) {
  user = await User.findById(arg);
} else {
  user = await User.findOne({ fcmTokens: { $exists: true, $ne: [] } }).sort({ _id: -1 });
}

if (!user) {
  console.log('❌ No matching user with FCM tokens. Log in on the app first.');
  await mongoose.disconnect();
  process.exit(1);
}

console.log(`→ Sending test push to: ${user.email || user._id} (${user.fcmTokens?.length || 0} device token(s))`);

const result = await sendPushNotification(
  user._id,
  'WPLeads',
  'Test notification — your push is working! 🎉',
  { type: 'test' },
);

console.log('Result:', JSON.stringify(result, null, 2));
await mongoose.disconnect();
process.exit(result.success ? 0 : 1);
