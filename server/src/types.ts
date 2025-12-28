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
  heat: number; // 0-100, activity/visibility level
  poiInvestments: Record<string, number>; // poiId -> nits invested
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

// Intersection/POI state stored in IntersectionDO
export interface IntersectionState {
  id: string;
  coordinates: Coordinates;
  routes: string[]; // route IDs that pass through this intersection
  custody: string[]; // usernames of players with custody (legacy, now derived from investments)
  investments: Record<string, number>; // username -> nits invested
  controller: string | null; // player with highest investment
  totalInvested: number; // sum of all investments
  lastActivity: number; // timestamp of last investment/contest
  createdAt: number;
}

// WebSocket message types
export type ServerMessage =
  | { type: 'connected'; username: string }
  | { type: 'state'; player: PlayerState }
  | { type: 'tick'; nits: number; heat: number }
  | { type: 'error'; message: string }
  | { type: 'route_request'; from: string; routeId: string }
  | { type: 'route_accepted'; routeId: string; route: RouteState }
  | { type: 'route_rejected'; routeId: string }
  | { type: 'routes'; routes: RouteState[] }
  | { type: 'intersection_created'; intersection: IntersectionState }
  | { type: 'market_update'; bids: MarketOrder[]; asks: MarketOrder[] }
  | { type: 'order_filled'; orderId: string; amount: number; price: number }
  | { type: 'heat_update'; heat: number }
  | { type: 'poi_update'; poi: IntersectionState }
  | { type: 'poi_contest'; poiId: string; attacker: string; amount: number; newController: string | null }
  | { type: 'toll_received'; amount: number; fromPoi: string }
  | { type: 'visibility_update'; visiblePlayers: VisiblePlayer[] };

export type ClientMessage =
  | { type: 'auth'; username: string }
  | { type: 'ping' }
  | { type: 'request_route'; to: string }
  | { type: 'accept_route'; routeId: string }
  | { type: 'reject_route'; routeId: string }
  | { type: 'place_order'; side: 'bid' | 'ask'; price: number; amount: number }
  | { type: 'cancel_order'; orderId: string }
  | { type: 'invest_poi'; poiId: string; amount: number }
  | { type: 'upgrade_route'; routeId: string };

// Visible player info for fog of war
export interface VisiblePlayer {
  username: string;
  coordinates: Coordinates;
  heat: number;
  nits?: number; // only visible if heat > 75
  routes?: string[]; // routes visible based on connection
}

// Market order
export interface MarketOrder {
  id: string;
  player: string;
  side: 'bid' | 'ask';
  price: number;
  amount: number;
  createdAt: number;
}

// Bot configuration
export interface BotConfig {
  username: string;
  coordinates: Coordinates;
  behavior: 'passive' | 'territorial' | 'trader' | 'expansionist';
  aggression: number; // 0-1
  riskTolerance: number; // 0-1
}

// Environment bindings
export interface Env {
  PLAYER: DurableObjectNamespace;
  ROUTE: DurableObjectNamespace;
  INTERSECTION: DurableObjectNamespace;
  MARKET: DurableObjectNamespace;
  BOT: DurableObjectNamespace;
}
