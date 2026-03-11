require("dotenv").config();

const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const app = require("./src/app");
const Ride = require("./models/Ride");
const DriverLocation = require("./models/DriverLocation");
const { registerUser, unregisterSocket, getSocketIdByUserId } = require("./src/sockets/socketManager");
const { setIO } = require("./src/sockets/io");
const { findNearestDriversSorted } = require("./src/services/matchingService");

// In-memory tracking of ongoing dispatch attempts
// rideId -> { riderId, pickupLat, pickupLng, candidates: [driverId...], tried: Set, currentDriverId }
const rideDispatch = new Map();

// rideId -> Timeout handle
const rideTimeouts = new Map();

const OFFER_TIMEOUT_MS = 20_000;
const PORT = Number(process.env.PORT) || 5000;
const corsOriginRaw = process.env.CORS_ORIGIN || "*";
const corsOrigins = corsOriginRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in environment variables");
}

mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => {
        console.log("❌ MongoDB connection error:", err.message);
        process.exit(1);
    });

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: corsOrigins.includes("*") ? "*" : corsOrigins,
        methods: ["GET", "POST"],
    },
});

setIO(io);

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("register", (userId) => {
        registerUser(userId, socket.id);
        console.log("🟢 registered", userId, "socket", socket.id);
    });

    socket.on("disconnect", () => {
        unregisterSocket(socket.id);
        console.log("User disconnected:", socket.id);
    });

    socket.on("locationUpdate", async ({ driverId, rideId, lat, lng }) => {
        try {
            // Update or create driver location in database
            await DriverLocation.findOneAndUpdate(
                { driverId },
                { 
                    lat, 
                    lng, 
                    isOnline: true,
                    updatedAt: new Date() 
                },
                { upsert: true, returnDocument: 'after' }
            );

            const ride = await Ride.findById(rideId);
            if (!ride) return;

            if (String(ride.driverId) !== String(driverId)) return;
            if (ride.status !== "started") return;

            const riderSocketId = getSocketIdByUserId(String(ride.riderId));
            if (!riderSocketId) return;

            io.to(riderSocketId).emit("driverLocation", {
                rideId,
                driverId,
                lat,
                lng,
            });

            console.log(`📍 Forwarded driverLocation to rider ${ride.riderId}:`, { rideId, lat, lng });
        } catch (e) {
            console.log("locationUpdate error:", e.message);
        }
    });

    socket.on("driverOnline", async ({ driverId }) => {
        try {
            await DriverLocation.findOneAndUpdate(
                { driverId },
                { isOnline: true, updatedAt: new Date() },
                { upsert: true, returnDocument: 'after' }
            );
            console.log(`🟢 Driver ${driverId} is now online`);
        } catch (e) {
            console.log("driverOnline error:", e.message);
        }
    });

    socket.on("driverOffline", async ({ driverId }) => {
        try {
            await DriverLocation.findOneAndUpdate(
                { driverId },
                { isOnline: false, updatedAt: new Date() },
                { upsert: true, returnDocument: 'after' }
            );
            console.log(`🔴 Driver ${driverId} is now offline`);
        } catch (e) {
            console.log("driverOffline error:", e.message);
        }
    });

    // Driver continuously pings location when online
    socket.on("driverPing", async ({ driverId, lat, lng }) => {
        try {
            await DriverLocation.findOneAndUpdate(
                { driverId },
                { lat, lng, isOnline: true, updatedAt: new Date() },
                { upsert: true, returnDocument: 'after' }
            );
        } catch (e) {
            console.log("driverPing error:", e.message);
        }
    });

    // Driver accepts or declines a ride request
    socket.on("requestRide", async (payload) => {
        try {
            console.log("🔥 requestRide received", payload);
            const { riderId, pickup, drop } = payload || {};
            if (!riderId || !pickup || !drop) return;

            const pickupLat = Number(pickup.lat);
            const pickupLng = Number(pickup.lng);
            if (Number.isNaN(pickupLat) || Number.isNaN(pickupLng)) return;

            const ride = await Ride.create({
                riderId: String(riderId),
                driverId: null,
                pickup,
                drop,
                status: "searching",
            });

            const candidates = await findNearestDriversSorted(pickupLat, pickupLng, 10);
            const candidateIds = candidates.map((c) => c.driverId);

            const riderSocketId = getSocketIdByUserId(riderId);
            if (!candidateIds.length) {
                await Ride.findByIdAndUpdate(ride._id, { status: "no_drivers" });
                if (riderSocketId) {
                    io.to(riderSocketId).emit("rideFailed", {
                        rideId: String(ride._id),
                        reason: "No drivers available",
                    });
                }
                return;
            }

            rideDispatch.set(String(ride._id), {
                riderId: String(riderId),
                pickupLat,
                pickupLng,
                candidates: candidateIds,
                tried: new Set(),
                currentDriverId: null,
            });

            if (riderSocketId) {
                io.to(riderSocketId).emit("rideSearching", {
                    rideId: String(ride._id),
                    status: "searching",
                });
            }

            await dispatchToNextDriver(io, String(ride._id));
        } catch (e) {
            console.log("requestRide error:", e.message);
        }
    });

    socket.on("rideResponse", async (payload) => {
        try {
            const { rideId, driverId, accepted } = payload || {};
            if (!rideId || !driverId) return;

            const state = rideDispatch.get(String(rideId));
            if (!state) return;

            if (String(state.currentDriverId) !== String(driverId)) {
                return;
            }

            clearRideTimeout(rideId);

            if (accepted) {
                const updated = await Ride.findOneAndUpdate(
                    { _id: rideId, status: "searching", driverId: null },
                    { status: "accepted", driverId: String(driverId) },
                    { returnDocument: 'after' }
                );

                const riderSocketId = getSocketIdByUserId(state.riderId);
                const driverSocketId = getSocketIdByUserId(driverId);

                if (!updated) {
                    if (driverSocketId) {
                        io.to(driverSocketId).emit("rideAssignmentFailed", {
                            rideId: String(rideId),
                            reason: "Ride no longer available",
                        });
                    }
                    await dispatchToNextDriver(io, String(rideId));
                    return;
                }

                console.log(`✅ Driver ${driverId} accepted ride ${rideId}`);

                if (riderSocketId) {
                    io.to(riderSocketId).emit("rideMatched", {
                        rideId: String(updated._id),
                        driverId: String(driverId),
                        status: updated.status,
                        pickup: updated.pickup,
                        drop: updated.drop,
                    });
                }

                if (driverSocketId) {
                    io.to(driverSocketId).emit("rideAssigned", {
                        rideId: String(updated._id),
                        riderId: String(state.riderId),
                        status: updated.status,
                        pickup: updated.pickup,
                        drop: updated.drop,
                    });
                }

                rideDispatch.delete(String(rideId));
            } else {
                state.tried.add(String(driverId));
                state.currentDriverId = null;
                rideDispatch.set(String(rideId), state);

                const driverSocketId = getSocketIdByUserId(driverId);
                if (driverSocketId) {
                    io.to(driverSocketId).emit("rideDeclinedAck", { rideId: String(rideId) });
                }

                await dispatchToNextDriver(io, String(rideId));
            }
        } catch (e) {
            console.log("rideResponse error:", e.message);
        }
    });
});

function clearRideTimeout(rideId) {
    const t = rideTimeouts.get(String(rideId));
    if (t) clearTimeout(t);
    rideTimeouts.delete(String(rideId));
}

function setRideTimeout(io, rideId) {
    clearRideTimeout(rideId);

    const handle = setTimeout(async () => {
        try {
            const state = rideDispatch.get(String(rideId));
            if (!state) return;

            const ride = await Ride.findById(rideId);
            if (!ride || ride.status !== "searching") {
                rideDispatch.delete(String(rideId));
                clearRideTimeout(rideId);
                return;
            }

            if (state.currentDriverId) {
                state.tried.add(String(state.currentDriverId));
                state.currentDriverId = null;
                rideDispatch.set(String(rideId), state);
            }

            const riderSocketId = getSocketIdByUserId(state.riderId);
            if (riderSocketId) {
                io.to(riderSocketId).emit("driverTimedOut", {
                    rideId: String(rideId),
                    message: "Driver did not respond. Trying another driver...",
                });
            }

            await dispatchToNextDriver(io, String(rideId));
        } catch (e) {
            console.log("timeout error:", e.message);
        }
    }, OFFER_TIMEOUT_MS);

    rideTimeouts.set(String(rideId), handle);
}

async function dispatchToNextDriver(io, rideId) {
    const state = rideDispatch.get(String(rideId));
    if (!state) {
        clearRideTimeout(rideId);
        return;
    }

    const ride = await Ride.findById(rideId);
    if (!ride || ride.status !== "searching") {
        rideDispatch.delete(String(rideId));
        clearRideTimeout(rideId);
        return;
    }

    const nextDriverId = state.candidates.find((id) => !state.tried.has(String(id)));
    const riderSocketId = getSocketIdByUserId(state.riderId);

    if (!nextDriverId) {
        await Ride.findByIdAndUpdate(rideId, { status: "no_drivers" });
        if (riderSocketId) {
            io.to(riderSocketId).emit("rideFailed", {
                rideId: String(rideId),
                reason: "All drivers declined/unavailable",
            });
        }
        rideDispatch.delete(String(rideId));
        clearRideTimeout(rideId);
        return;
    }

    state.currentDriverId = String(nextDriverId);
    state.tried.add(String(nextDriverId));
    rideDispatch.set(String(rideId), state);

    const driverSocketId = getSocketIdByUserId(nextDriverId);

    if (!driverSocketId) {
        await dispatchToNextDriver(io, rideId);
        return;
    }

    console.log("➡️ dispatching ride", rideId, "to driver", nextDriverId, "socket", driverSocketId);

    io.to(driverSocketId).emit("rideRequest", {
        rideId: String(ride._id),
        pickup: ride.pickup?.name ?? "Pickup",
        drop: ride.drop?.name ?? "Drop",
        pickupData: ride.pickup,
        dropData: ride.drop,
    });

    // ✅ Start offer timeout for this offer
    setRideTimeout(io, rideId);

    if (riderSocketId) {
        io.to(riderSocketId).emit("driverOfferSent", {
            rideId: String(ride._id),
            driverId: String(nextDriverId),
        });
    }
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
