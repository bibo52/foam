// Coordinates (lat/long)
export interface Coordinates {
  lat: number;
  lng: number;
}

// Player state stored in PlayerDO
export interface PlayerState {
  username: string;
  nits: number;
  productionRate: number; // nits per tick
  coordinates: Coordinates;
  city: string;
  region: string;
  country: string;
  createdAt: number;
  routes: string[]; // route IDs this player is part of
}

// Route state stored in RouteDO
export interface RouteState {
  id: string;
  playerA: string; // username
  playerB: string; // username
  coordsA: Coordinates;
  coordsB: Coordinates;
  capacity: number;
  status: 'pending' | 'active' | 'inactive';
  createdAt: number;
}

// Intersection state stored in IntersectionDO
export interface IntersectionState {
  id: string;
  coordinates: Coordinates;
  routes: string[]; // route IDs that pass through this intersection
  custody: string[]; // usernames of players with custody
  createdAt: number;
}

// WebSocket message types
export type ServerMessage =
  | { type: 'connected'; username: string }
  | { type: 'state'; player: PlayerState }
  | { type: 'tick'; nits: number }
  | { type: 'error'; message: string }
  | { type: 'route_request'; from: string; routeId: string }
  | { type: 'route_accepted'; routeId: string; route: RouteState }
  | { type: 'route_rejected'; routeId: string }
  | { type: 'routes'; routes: RouteState[] }
  | { type: 'intersection_created'; intersection: IntersectionState }
  | { type: 'market_update'; bids: MarketOrder[]; asks: MarketOrder[] }
  | { type: 'order_filled'; orderId: string; amount: number; price: number };

export type ClientMessage =
  | { type: 'auth'; username: string }
  | { type: 'ping' }
  | { type: 'request_route'; to: string }
  | { type: 'accept_route'; routeId: string }
  | { type: 'reject_route'; routeId: string }
  | { type: 'place_order'; side: 'bid' | 'ask'; price: number; amount: number }
  | { type: 'cancel_order'; orderId: string };

// Market order
export interface MarketOrder {
  id: string;
  player: string;
  side: 'bid' | 'ask';
  price: number;
  amount: number;
  createdAt: number;
}

// Environment bindings
export interface Env {
  PLAYER: DurableObjectNamespace;
  ROUTE: DurableObjectNamespace;
  INTERSECTION: DurableObjectNamespace;
  MARKET: DurableObjectNamespace;
}
