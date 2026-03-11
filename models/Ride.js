const mongoose = require("mongoose");

const LocationSchema = new mongoose.Schema(
    {
        name: String,
        lat: Number,
        lng: Number,
    },
    { _id: false }
);

const RideSchema = new mongoose.Schema({
    riderId: String,
    driverId: String,
    pickup: LocationSchema,
    drop: LocationSchema,
    status: String
});

module.exports = mongoose.model("Ride", RideSchema);
