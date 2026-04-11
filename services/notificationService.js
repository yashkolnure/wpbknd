import admin from "firebase-admin";
import User from "../models/User.js";

export const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    // ── 1. VALIDATION ────────────────────────────────────────────────────
    if (!userId) {
      console.error("❌ sendPushNotification: Missing userId");
      return { success: false, error: "Missing userId" };
    }

    // ── 2. CHECK FIREBASE INITIALIZATION ─────────────────────────────────
    if (!admin.messaging()) {
      console.error("❌ Firebase not initialized");
      return { success: false, error: "Firebase not initialized" };
    }

    // ── 3. FETCH USER AND FCM TOKENS ─────────────────────────────────────
    const user = await User.findById(userId);
    
    if (!user) {
      console.warn(`⚠️  User not found: ${userId}`);
      return { success: false, error: "User not found" };
    }

    if (!user.fcmTokens || user.fcmTokens.length === 0) {
      console.warn(`⚠️  No FCM tokens for user ${userId}. Tokens list: ${JSON.stringify(user.fcmTokens)}`);
      return { success: false, error: "No FCM tokens available" };
    }

// ── 4. BUILD MESSAGES ────────────────────────────────────────────────
const messages = user.fcmTokens.map((token) => ({
  notification: { 
    title: title || "New Message",
    body: body || "You have a new message"
  },
  data: { 
    ...data, 
    click_action: "FLUTTER_NOTIFICATION_CLICK",
    userId: userId.toString(),  // ← Convert to string
  },
  token: token,
}));
    // ── 5. SEND TO ALL DEVICES ───────────────────────────────────────────
    const responses = await Promise.allSettled(
      messages.map((msg) => admin.messaging().send(msg))
    );

    // ── 6. PROCESS RESPONSES ─────────────────────────────────────────────
    let successCount = 0;
    let failureCount = 0;
    const tokensToRemove = [];

    responses.forEach((res, index) => {
      const token = user.fcmTokens[index];
      
      if (res.status === "fulfilled") {
        successCount++;
      } else {
        failureCount++;
        const error = res.reason;
        console.error(`❌ Failed to send to device ${index + 1}:`, error.message);

        // Remove invalid/unregistered tokens
        if (error.code === 'messaging/registration-token-not-registered' || 
            error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/mismatched-credential') {
          tokensToRemove.push(token);
        }
      }
    });

    // ── 7. CLEAN UP STALE TOKENS ─────────────────────────────────────────
    if (tokensToRemove.length > 0) {
          await User.findByIdAndUpdate(userId, {
        $pull: { fcmTokens: { $in: tokensToRemove } }
      });
    }

    // ── 8. RETURN RESULT ─────────────────────────────────────────────────
    const result = {
      success: successCount > 0,
      successCount,
      failureCount,
      totalTokens: user.fcmTokens.length,
    };

    if (successCount > 0) {
    } else if (failureCount > 0) {
      console.error(`❌ All ${failureCount} notification(s) failed`);
    }

    return result;

  } catch (error) {
    console.error("🔥 Firebase Notification Service Error:", {
      message: error.message,
      code: error.code,
      userId,
      stack: error.stack,
    });
    return { success: false, error: error.message };
  }
};

// Helper function to manually test notifications
export const testPushNotification = async (userId) => {
  return await sendPushNotification(
    userId,
    "Test Notification",
    "If you see this, notifications are working!",
    { type: "test" }
  );
};