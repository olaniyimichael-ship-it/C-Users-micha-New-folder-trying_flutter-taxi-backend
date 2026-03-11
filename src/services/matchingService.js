const DriverLocation = require("../../models/DriverLocation");

function haversineKm(lat1, lon1, lat2, lon2) {
	const R = 6371;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) *
			Math.cos((lat2 * Math.PI) / 180) *
			Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

async function findNearestDriversSorted(pickupLat, pickupLng, limit = 10) {
	const drivers = await DriverLocation.find({ isOnline: true });

	const scored = drivers
		.filter((d) => typeof d.lat === "number" && typeof d.lng === "number")
		.map((d) => ({
			driverId: String(d.driverId),
			lat: d.lat,
			lng: d.lng,
			distanceKm: haversineKm(pickupLat, pickupLng, d.lat, d.lng),
		}))
		.sort((a, b) => a.distanceKm - b.distanceKm)
		.slice(0, limit);

	return scored;
}

module.exports = { findNearestDriversSorted };