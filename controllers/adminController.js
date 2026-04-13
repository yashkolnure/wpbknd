// controllers/adminController.js
import User from "../models/User.js";
// controllers/adminController.js
export const getAllUsersData = async (req, res) => {
  try {
    const data = await User.aggregate([
      { $sort: { createdAt: -1 } }, // Newest first
      {
        $lookup: {
          from: "whatsapps",
          localField: "_id",
          foreignField: "userId",
          as: "waInfo"
        }
      },
      {
        $project: {
          name: 1,
          email: 1,
          phone: 1,
          createdAt: 1,
          plan: 1,
          // Explicitly pull these for the dashboard
          whatsapp: { $arrayElemAt: ["$waInfo", 0] }
        }
      }
    ]);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: "Fetch failed", error: error.message });
  }
};