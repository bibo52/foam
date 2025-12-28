// Geographic utilities for foam

export interface Coordinates {
  lat: number;
  lng: number;
}

// Get approximate location from IP using Cloudflare's cf object
export function getLocationFromRequest(request: Request): Coordinates {
  const cf = (request as any).cf;

  if (cf?.latitude && cf?.longitude) {
    // Cloudflare provides approximate lat/lng
    return {
      lat: parseFloat(cf.latitude),
      lng: parseFloat(cf.longitude),
    };
  }

  // Fallback to a default location (will be randomized anyway)
  return { lat: 40.7128, lng: -74.0060 }; // NYC as default
}

// Get city/region info from request
export function getRegionFromRequest(request: Request): { city: string; region: string; country: string } {
  const cf = (request as any).cf;

  return {
    city: cf?.city || 'Unknown',
    region: cf?.region || 'Unknown',
    country: cf?.country || 'US',
  };
}

// Randomize coordinates within a neighborhood (~1-2km radius)
// This preserves geographic meaning while protecting exact location
export function randomizeWithinNeighborhood(coords: Coordinates): Coordinates {
  // ~1.5km radius randomization
  // 1 degree lat ≈ 111km, so 0.015 ≈ 1.5km
  // 1 degree lng varies by latitude, but roughly similar at mid-latitudes
  const radiusDegrees = 0.015;

  const randomAngle = Math.random() * 2 * Math.PI;
  const randomRadius = Math.random() * radiusDegrees;

  return {
    lat: coords.lat + randomRadius * Math.cos(randomAngle),
    lng: coords.lng + randomRadius * Math.sin(randomAngle),
  };
}

// Check if two line segments intersect
// Returns the intersection point or null
export function lineIntersection(
  a1: Coordinates, a2: Coordinates,
  b1: Coordinates, b2: Coordinates
): Coordinates | null {
  const x1 = a1.lng, y1 = a1.lat;
  const x2 = a2.lng, y2 = a2.lat;
  const x3 = b1.lng, y3 = b1.lat;
  const x4 = b2.lng, y4 = b2.lat;

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

  if (Math.abs(denom) < 1e-10) {
    return null; // Lines are parallel
  }

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      lng: x1 + t * (x2 - x1),
      lat: y1 + t * (y2 - y1),
    };
  }

  return null;
}

// Calculate distance between two coordinates (Haversine formula)
export function distance(a: Coordinates, b: Coordinates): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

function toRad(deg: number): number {
  return deg * Math.PI / 180;
}

// Format coordinates for display
export function formatCoords(coords: Coordinates): string {
  const latDir = coords.lat >= 0 ? 'N' : 'S';
  const lngDir = coords.lng >= 0 ? 'E' : 'W';
  return `${Math.abs(coords.lat).toFixed(2)}°${latDir}, ${Math.abs(coords.lng).toFixed(2)}°${lngDir}`;
}
