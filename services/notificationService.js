// services/notificationService.js
import admin from "firebase-admin";
import User from "../models/User.js";

export const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    const user = await User.findById(userId);
    
    // Check if user exists and has tokens
    if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
      return;
    }
console.log(`Sending push to user ${userId} with tokens:`, user.fcmTokens);
    const messages = user.fcmTokens.map((token) => ({
      notification: { title, body },
      data: { ...data, click_action: "FLUTTER_NOTIFICATION_CLICK" },
      token: token,
    }));

    // Send to all devices
    const responses = await Promise.allSettled(
      messages.map((msg) => admin.messaging().send(msg))
    );

    // Optional: Clean up failed tokens (stale/uninstalled)
    const tokensToRemove = [];
    responses.forEach((res, index) => {
      if (res.status === "rejected") {
        const error = res.reason;
        if (error.code === 'messaging/registration-token-not-registered' || 
            error.code === 'messaging/invalid-registration-token') {
          tokensToRemove.push(user.fcmTokens[index]);
        }
      }
    });

    if (tokensToRemove.length > 0) {
      await User.findByIdAndUpdate(userId, {
        $pull: { fcmTokens: { $in: tokensToRemove } }
      });
    }

  } catch (error) {
    console.error("Firebase Notification Error:", error);
  }
};