const express = require("express");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const Ride = require("../../models/Ride");
const { getIO } = require("../sockets/io");
const { getSocketIdByUserId } = require("../sockets/socketManager");
const { findNearestDriver } = require("../utils/nearestDriver");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error("Missing JWT_SECRET in environment variables");
}

function parseCoordinate(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toLocation(value) {
    if (value && typeof value === "object") {
        const name = (value.name ?? "").toString();
        return {
            name,
            lat: parseCoordinate(value.lat),
            lng: parseCoordinate(value.lng),
        };
    }

    if (typeof value === "string") {
        return {
            name: value,
            lat: null,
            lng: null,
        };
    }

    return {
        name: "",
        lat: null,
        lng: null,
    };
}

function authMiddleware(req, res, next) {
    const authHeader = req.headers["authorization"];

    if (!authHeader) {
        return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.startsWith("Bearer ")
        ? authHeader.split(" ")[1]
        : authHeader;

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Invalid token" });
    }
}

router.use(authMiddleware);

router.post(["/book", "/book-ride"], async (req, res) => {
    try {
        const riderId = req.user.userId;

        const ride = new Ride({
            riderId,
            pickup: toLocation(req.body.pickup),
            drop: toLocation(req.body.drop),
            status: "pending"
        });

        await ride.save();

        // Find nearest online driver and send ride request
        const pickupLat = ride.pickup?.lat;
        const pickupLng = ride.pickup?.lng;

        if (pickupLat != null && pickupLng != null) {
            const nearestDriver = await findNearestDriver(pickupLat, pickupLng);
            
            if (nearestDriver) {
                const io = getIO();
                const driverSocketId = getSocketIdByUserId(nearestDriver.driverId);
                
                if (io && driverSocketId) {
                    io.to(driverSocketId).emit("rideRequest", {
                        rideId: ride._id,
                        pickup: ride.pickup,
                        drop: ride.drop,
                    });
                    console.log(`📲 Sent ride request to nearest driver ${nearestDriver.driverId}`);
                }
            }
        }

        res.json({
            message: "Ride Booked",
            rideId: ride._id.toString()
        });
    } catch (err) {
        res.status(500).json({ message: "Error booking ride" });
    }
});

router.get("/", async (req, res) => {
    try {
        const rides = await Ride.find();
        res.json(rides);
    } catch (err) {
        res.status(500).json({ message: "Error fetching rides" });
    }
});

router.get("/route-polyline", async (req, res) => {
    try {
        const originLat = Number(req.query.originLat);
        const originLng = Number(req.query.originLng);
        const destLat = Number(req.query.destLat);
        const destLng = Number(req.query.destLng);

        if (
            !Number.isFinite(originLat) ||
            !Number.isFinite(originLng) ||
            !Number.isFinite(destLat) ||
            !Number.isFinite(destLng)
        ) {
            return res.status(400).json({ message: "Invalid coordinates" });
        }

        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=full&geometries=geojson`;

        const response = await axios.get(osrmUrl, {
            timeout: 8000,
            headers: {
                "User-Agent": "trying_flutter_backend/1.0",
            },
        });

        const routes = response.data?.routes;
        const coordinates = routes?.[0]?.geometry?.coordinates;

        if (!Array.isArray(coordinates) || coordinates.length < 2) {
            return res.status(404).json({ message: "No route found" });
        }

        const points = coordinates
            .map((coord) => {
                if (!Array.isArray(coord) || coord.length < 2) return null;
                const lng = Number(coord[0]);
                const lat = Number(coord[1]);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                return { lat, lng };
            })
            .filter(Boolean);

        if (points.length < 2) {
            return res.status(404).json({ message: "No route points available" });
        }

        return res.json({
            source: "osrm",
            points,
        });
    } catch (err) {
        return res.status(502).json({
            message: "Failed to fetch route",
            error: err?.message || "Unknown error",
        });
    }
});

router.get("/my-rides/:userId", async (req, res) => {
    try {
        const rides = await Ride.find({ riderId: req.user.userId });
        res.json(rides);
    } catch (err) {
        res.status(500).json({ message: "Error fetching rides" });
    }
});

router.get("/ride/:id", async (req, res) => {
    try {
        const ride = await Ride.findById(req.params.id);
        res.json(ride);
    } catch (err) {
        res.status(500).json({ message: "Error fetching ride" });
    }
});

router.put("/ride/:id", async (req, res) => {
    try {
        const ride = await Ride.findByIdAndUpdate(
            req.params.id,
            { status: req.body.status },
            { returnDocument: 'after' }
        );
        res.json(ride);
    } catch (err) {
        res.status(500).json({ message: "Error updating ride" });
    }
});

router.put("/accept-ride/:rideId", async (req, res) => {
    try {
        const driverId = req.user.userId;

        const ride = await Ride.findByIdAndUpdate(
            req.params.rideId,
            {
                status: "accepted",
                driverId
            },
            { returnDocument: 'after' }
        );

        const io = getIO();
        const riderSocketId = getSocketIdByUserId(ride.riderId);

        if (io && riderSocketId) {
            io.to(riderSocketId).emit("rideUpdated", {
                rideId: ride._id,
                status: ride.status,
                driverId: ride.driverId || null,
                pickup: ride.pickup,
                drop: ride.drop,
            });
        }

        res.json({
            message: "Ride accepted successfully",
            ride
        });
    } catch (err) {
        res.status(500).json({ message: "Error accepting ride" });
    }
});

router.put("/update-ride-status/:rideId", async (req, res) => {
    try {
        const { status } = req.body;
        const driverId = req.user.userId;

        const existingRide = await Ride.findById(req.params.rideId);
        if (!existingRide) {
            return res.status(404).json({ message: "Ride not found" });
        }

        if (String(existingRide.driverId || "") !== String(driverId)) {
            return res.status(403).json({ message: "Not authorized for this ride" });
        }

        const ride = await Ride.findByIdAndUpdate(
            req.params.rideId,
            { status },
            { returnDocument: 'after' }
        );

        const io = getIO();
        const riderSocketId = getSocketIdByUserId(ride.riderId);

        if (io && riderSocketId) {
            io.to(riderSocketId).emit("rideUpdated", {
                rideId: ride._id,
                status: ride.status,
                driverId: ride.driverId || null,
                pickup: ride.pickup,
                drop: ride.drop,
            });
        }

        res.json(ride);
    } catch (err) {
        res.status(500).json({ message: "Error updating ride status" });
    }
});

router.get("/pending-rides", async (req, res) => {
    try {
        const rides = await Ride.find({ status: "pending" });
        res.json(rides);
    } catch (err) {
        res.status(500).json({ message: "Error fetching pending rides" });
    }
});

router.get("/driver-rides", async (req, res) => {
    try {
        const driverId = req.user.userId;
        const rides = await Ride.find({
            $or: [{ status: "pending" }, { driverId }]
        });
        res.json(rides);
    } catch (err) {
        res.status(500).json({ message: "Error fetching driver rides" });
    }
});

module.exports = router;
