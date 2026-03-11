const mongoose = require("mongoose");

const DriverLocationSchema = new mongoose.Schema(
  {
    driverId: { type: String, required: true, unique: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    isOnline: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DriverLocation", DriverLocationSchema);
