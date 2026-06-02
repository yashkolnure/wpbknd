import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import User from "../models/User.js";

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/api/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = (profile.emails?.[0]?.value || "").trim().toLowerCase();

        // 1. Check if user already exists by googleId OR email (case-normalized,
        //    so a prior email signup like "Yash@gmail.com" links instead of duping).
        let user = await User.findOne({
          $or: [{ googleId: profile.id }, { email }]
        });

        if (user) {
          // If user exists but didn't have googleId (signed up via email before), add it
          if (!user.googleId) {
            user.googleId = profile.id;
            await user.save();
          }
          return done(null, user);
        }

        // 2. If user doesn't exist, create a new one (Register)
        user = await User.create({
          name: profile.displayName,
          email,
          googleId: profile.id,
          avatar: profile.photos?.[0]?.value
          // password remains undefined
        });

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);