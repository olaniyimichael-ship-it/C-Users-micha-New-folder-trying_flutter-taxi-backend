const mongoose = require("mongoose");
const { io } = require("socket.io-client");
const Ride = require("../models/Ride");
const DriverLocation = require("../models/DriverLocation");

const MONGO_URI = "mongodb://127.0.0.1:27017/uber_clone";
const SOCKET_URL = "http://127.0.0.1:5000";

const riderId = "smoke_rider_1";
const driverId = "smoke_driver_1";

function waitForEvent(timeoutMs, subscribe) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    subscribe((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function run() {
  await mongoose.connect(MONGO_URI);

  await Ride.deleteMany({ riderId });
  await DriverLocation.updateMany({}, { isOnline: false });
  await DriverLocation.findOneAndUpdate(
    { driverId },
    { driverId, lat: 0, lng: 0, isOnline: true, updatedAt: new Date() },
    { upsert: true }
  );

  const rider = io(SOCKET_URL, { transports: ["websocket"] });
  const driver = io(SOCKET_URL, { transports: ["websocket"] });

  let matchedPayload = null;

  rider.on("connect", () => {
    rider.emit("register", riderId);
  });

  driver.on("connect", () => {
    driver.emit("register", driverId);
    driver.emit("driverOnline", { driverId });
    driver.emit("driverPing", { driverId, lat: 0, lng: 0 });
  });

  driver.on("rideRequest", (payload) => {
    console.log("[Driver] rideRequest:", payload);
    driver.emit("rideResponse", {
      rideId: payload.rideId,
      driverId,
      accepted: true,
    });
  });

  rider.on("rideSearching", (payload) => {
    console.log("[Rider] rideSearching:", payload);
  });

  rider.on("driverOfferSent", (payload) => {
    console.log("[Rider] driverOfferSent:", payload);
  });

  rider.on("rideFailed", (payload) => {
    console.log("[Rider] rideFailed:", payload);
  });

  rider.on("rideMatched", (payload) => {
    console.log("[Rider] rideMatched:", payload);
    matchedPayload = payload;
  });

  rider.on("driverLocation", (payload) => {
    console.log("[Rider] driverLocation:", payload);
  });

  await waitForEvent(5000, (done) => {
    if (rider.connected && driver.connected) return done(true);
    rider.on("connect", () => {
      if (driver.connected) done(true);
    });
    driver.on("connect", () => {
      if (rider.connected) done(true);
    });
  });

  await waitForEvent(5000, (done) => {
    const timer = setInterval(async () => {
      const dl = await DriverLocation.findOne({ driverId });
      if (dl && dl.isOnline === true && Number(dl.lat) === 0 && Number(dl.lng) === 0) {
        clearInterval(timer);
        done(true);
      }
    }, 150);
  });

  rider.emit("requestRide", {
    riderId,
    pickup: { name: "Test Origin", lat: 0, lng: 0 },
    drop: { name: "Oxford", lat: 51.752, lng: -1.2577 },
  });

  const rideMatched = await waitForEvent(8000, (done) => {
    rider.on("rideMatched", done);
  });

  await Ride.findByIdAndUpdate(rideMatched.rideId, { status: "started" });

  const driverLocationPromise = waitForEvent(5000, (done) => {
    rider.on("driverLocation", done);
  });

  driver.emit("locationUpdate", {
    driverId,
    rideId: rideMatched.rideId,
    lat: 51.509,
    lng: -0.13,
  });

  await driverLocationPromise;

  console.log("\n✅ SMOKE TEST PASS");
  console.log("- Driver went online");
  console.log("- Rider requested ride");
  console.log("- Driver received rideRequest and accepted");
  console.log("- Rider received rideMatched");
  console.log("- Rider received driverLocation after ride started");

  rider.disconnect();
  driver.disconnect();
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("\n❌ SMOKE TEST FAIL:", err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
