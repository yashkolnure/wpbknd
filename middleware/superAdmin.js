// Middleware: must run AFTER protect (req.user must exist)
export const superAdmin = (req, res, next) => {
  const allowed = (process.env.SUPERADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase());

  if (!req.user || !allowed.includes(req.user.email.toLowerCase())) {
    return res.status(403).json({ message: "Superadmin access only." });
  }
  next();
};
