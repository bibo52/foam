import { PlayerState, ServerMessage, ClientMessage, RouteState, IntersectionState, Env, VisiblePlayer } from '../types';
import { getLocationFromRequest, getRegionFromRequest, randomizeWithinNeighborhood } from '../lib/geo';

// Heat constants
const HEAT_DECAY_PER_TICK = 1;
const HEAT_MAX = 100;
const HEAT_MIN = 0;
const HEAT_POI_INVEST = 5;
const HEAT_POI_WIN = 10;
const HEAT_TRADE = 2;
const HEAT_ATTACK = 15;
const HEAT_ROUTE_UPGRADE = 3;

// Production bonus from controlled POIs
const POI_PRODUCTION_BONUS = 0.5;

// Tick interval in milliseconds
const TICK_INTERVAL = 10000;

export class PlayerDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Set<WebSocket> = new Set();
  private player: PlayerState | null = null;
  private pendingRouteRequests: Map<string, { from: string; routeId: string }> = new Map();
  private lastRequest: Request | null = null;
  private controlledPois: string[] = []; // POI IDs this player controls

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.lastRequest = request;

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // REST endpoints
    if (url.pathname === '/state' && request.method === 'GET') {
      return this.getState();
    }

    // Route request notification (called by another player's DO)
    if (url.pathname === '/route-request' && request.method === 'POST') {
      const body = await request.json() as { from: string; routeId: string };
      return this.handleRouteRequestNotification(body.from, body.routeId);
    }

    // Route accepted notification
    if (url.pathname === '/route-accepted' && request.method === 'POST') {
      const body = await request.json() as { routeId: string; route: RouteState };
      return this.handleRouteAcceptedNotification(body.routeId, body.route);
    }

    // Update nits (called by market when trade fills)
    if (url.pathname === '/update-nits' && request.method === 'POST') {
      const body = await request.json() as { delta: number; reason: string };
      return this.handleUpdateNits(body.delta, body.reason);
    }

    // Add heat (called by various systems)
    if (url.pathname === '/add-heat' && request.method === 'POST') {
      const body = await request.json() as { amount: number; reason: string };
      return this.handleAddHeat(body.amount, body.reason);
    }

    // POI control changed
    if (url.pathname === '/poi-control-changed' && request.method === 'POST') {
      const body = await request.json() as { poiId: string; isController: boolean };
      return this.handlePoiControlChanged(body.poiId, body.isController);
    }

    // Toll received from POI
    if (url.pathname === '/toll-received' && request.method === 'POST') {
      const body = await request.json() as { amount: number; fromPoi: string };
      return this.handleTollReceived(body.amount, body.fromPoi);
    }

    // Get visible players for fog of war
    if (url.pathname === '/visibility-info' && request.method === 'GET') {
      return this.getVisibilityInfo();
    }

    // Bot initialization (create player without WebSocket)
    if (url.pathname === '/bot-create' && request.method === 'POST') {
      const playerState = await request.json() as PlayerState;
      return this.handleBotCreate(playerState);
    }

    // Intersection created notification
    if (url.pathname === '/intersection-created' && request.method === 'POST') {
      const intersection = await request.json() as IntersectionState;
      this.broadcast({ type: 'intersection_created', intersection });
      return new Response('OK');
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleBotCreate(playerState: PlayerState): Promise<Response> {
    // Only create if player doesn't exist
    const existing = await this.state.storage.get<PlayerState>('player');
    if (existing) {
      return Response.json(existing);
    }

    this.player = playerState;
    await this.state.storage.put('player', this.player);

    // Start production alarm
    await this.state.storage.setAlarm(Date.now() + TICK_INTERVAL);

    return Response.json(this.player);
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.sessions.add(server);

    server.addEventListener('message', (event) => {
      this.webSocketMessage(server, event.data);
    });

    server.addEventListener('close', () => {
      this.webSocketClose(server);
    });

    server.addEventListener('error', () => {
      this.webSocketError(server);
    });

    // Load player state
    this.player = await this.state.storage.get<PlayerState>('player') ?? null;
    this.controlledPois = await this.state.storage.get<string[]>('controlledPois') ?? [];

    // Ensure new fields exist (backwards compatibility)
    if (this.player) {
      if (!this.player.routes) this.player.routes = [];
      if (this.player.heat === undefined) this.player.heat = 0;
      if (!this.player.poiInvestments) this.player.poiInvestments = {};
    }

    // Load pending route requests from storage
    const storedRequests = await this.state.storage.get<[string, { from: string; routeId: string }][]>('pendingRequests');
    if (storedRequests) {
      this.pendingRouteRequests = new Map(storedRequests);
    }

    if (this.player) {
      this.send(server, { type: 'connected', username: this.player.username });
      this.send(server, { type: 'state', player: this.player });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const msg: ClientMessage = JSON.parse(message);
      await this.handleMessage(ws, msg);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Invalid message format';
      this.send(ws, { type: 'error', message: errorMsg });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }

  private async handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'auth':
        await this.handleAuth(ws, msg.username);
        break;
      case 'ping':
        break;
      case 'request_route':
        await this.handleRequestRoute(ws, msg.to);
        break;
      case 'accept_route':
        await this.handleAcceptRoute(ws, msg.routeId);
        break;
      case 'reject_route':
        await this.handleRejectRoute(ws, msg.routeId);
        break;
      case 'place_order':
        await this.handlePlaceOrder(ws, msg.side, msg.price, msg.amount);
        break;
      case 'cancel_order':
        await this.handleCancelOrder(ws, msg.orderId);
        break;
      case 'invest_poi':
        await this.handleInvestPoi(ws, msg.poiId, msg.amount);
        break;
      case 'upgrade_route':
        await this.handleUpgradeRoute(ws, msg.routeId);
        break;
    }
  }

  private async handleAuth(ws: WebSocket, username: string): Promise<void> {
    if (!/^[a-zA-Z0-9]{1,7}$/.test(username)) {
      this.send(ws, { type: 'error', message: 'Username must be 1-7 alphanumeric characters' });
      return;
    }

    if (!this.player) {
      // Get location from request (Cloudflare cf object)
      const baseCoords = this.lastRequest
        ? getLocationFromRequest(this.lastRequest)
        : { lat: 40.7128, lng: -74.0060 };

      const region = this.lastRequest
        ? getRegionFromRequest(this.lastRequest)
        : { city: 'Unknown', region: 'Unknown', country: 'US' };

      // Randomize within neighborhood for privacy
      const coords = randomizeWithinNeighborhood(baseCoords);

      this.player = {
        username: username.toLowerCase(),
        nits: 100,
        productionRate: 1,
        coordinates: coords,
        city: region.city,
        region: region.region,
        country: region.country,
        createdAt: Date.now(),
        routes: [],
        heat: 0,
        poiInvestments: {},
      };
      await this.state.storage.put('player', this.player);
      await this.state.storage.setAlarm(Date.now() + TICK_INTERVAL);
    }

    this.send(ws, { type: 'connected', username: this.player.username });
    this.send(ws, { type: 'state', player: this.player });
  }

  private async handleRequestRoute(ws: WebSocket, toUsername: string): Promise<void> {
    if (!this.player) {
      this.send(ws, { type: 'error', message: 'Not authenticated' });
      return;
    }

    if (!/^[a-zA-Z0-9]{1,7}$/.test(toUsername)) {
      this.send(ws, { type: 'error', message: 'Invalid target username' });
      return;
    }

    const targetUsername = toUsername.toLowerCase();
    if (targetUsername === this.player.username) {
      this.send(ws, { type: 'error', message: 'Cannot create route to yourself' });
      return;
    }

    // Generate route ID
    const routeId = `${this.player.username}-${targetUsername}-${Date.now()}`;

    // Notify the target player
    const targetId = this.env.PLAYER.idFromName(targetUsername);
    const targetDO = this.env.PLAYER.get(targetId);

    try {
      const response = await targetDO.fetch(new Request('http://internal/route-request', {
        method: 'POST',
        body: JSON.stringify({ from: this.player.username, routeId }),
        headers: { 'Content-Type': 'application/json' },
      }));

      if (!response.ok) {
        this.send(ws, { type: 'error', message: 'Failed to send route request' });
        return;
      }

      // Store pending request on our side
      this.pendingRouteRequests.set(routeId, { from: this.player.username, routeId });
    } catch (e) {
      this.send(ws, { type: 'error', message: 'Target player not found' });
    }
  }

  private async handleRouteRequestNotification(from: string, routeId: string): Promise<Response> {
    // Load pending requests if not already loaded (REST call, no WebSocket)
    if (this.pendingRouteRequests.size === 0) {
      const storedRequests = await this.state.storage.get<[string, { from: string; routeId: string }][]>('pendingRequests');
      if (storedRequests) {
        this.pendingRouteRequests = new Map(storedRequests);
      }
    }

    // Store the pending request
    this.pendingRouteRequests.set(routeId, { from, routeId });
    await this.state.storage.put('pendingRequests', Array.from(this.pendingRouteRequests.entries()));

    // Notify connected clients
    this.broadcast({ type: 'route_request', from, routeId });

    return new Response('OK');
  }

  private async handleAcceptRoute(ws: WebSocket, routeId: string): Promise<void> {
    if (!this.player) {
      this.send(ws, { type: 'error', message: 'Not authenticated' });
      return;
    }

    const request = this.pendingRouteRequests.get(routeId);
    if (!request) {
      this.send(ws, { type: 'error', message: 'Route request not found' });
      return;
    }

    // Get the requesting player's state
    const fromId = this.env.PLAYER.idFromName(request.from);
    const fromDO = this.env.PLAYER.get(fromId);
    const fromStateResp = await fromDO.fetch(new Request('http://internal/state'));

    if (!fromStateResp.ok) {
      this.send(ws, { type: 'error', message: 'Could not get requesting player state' });
      return;
    }

    const fromPlayer = await fromStateResp.json() as PlayerState;

    // Create the route in RouteDO
    const routeDOId = this.env.ROUTE.idFromName(routeId);
    const routeDO = this.env.ROUTE.get(routeDOId);

    const route: RouteState = {
      id: routeId,
      playerA: request.from,
      playerB: this.player.username,
      coordsA: fromPlayer.coordinates,
      coordsB: this.player.coordinates,
      capacity: 10,
      status: 'active',
      createdAt: Date.now(),
    };

    await routeDO.fetch(new Request('http://internal/create', {
      method: 'POST',
      body: JSON.stringify(route),
      headers: { 'Content-Type': 'application/json' },
    }));

    // Add route to both players
    this.player.routes.push(routeId);
    await this.state.storage.put('player', this.player);

    // Notify the requesting player
    await fromDO.fetch(new Request('http://internal/route-accepted', {
      method: 'POST',
      body: JSON.stringify({ routeId, route }),
      headers: { 'Content-Type': 'application/json' },
    }));

    // Remove from pending
    this.pendingRouteRequests.delete(routeId);
    await this.state.storage.put('pendingRequests', Array.from(this.pendingRouteRequests.entries()));

    // Notify our clients
    this.broadcast({ type: 'route_accepted', routeId, route });

    // Check for intersections with existing routes
    await this.checkForIntersections(route);
  }

  private async handleRouteAcceptedNotification(routeId: string, route: RouteState): Promise<Response> {
    // Load player state if not already loaded (REST call, no WebSocket)
    if (!this.player) {
      this.player = await this.state.storage.get<PlayerState>('player') ?? null;
    }

    if (this.player) {
      if (!this.player.routes) {
        this.player.routes = [];
      }
      this.player.routes.push(routeId);
      await this.state.storage.put('player', this.player);
    }

    this.pendingRouteRequests.delete(routeId);
    this.broadcast({ type: 'route_accepted', routeId, route });

    return new Response('OK');
  }

  private async handleRejectRoute(ws: WebSocket, routeId: string): Promise<void> {
    const request = this.pendingRouteRequests.get(routeId);
    if (!request) {
      this.send(ws, { type: 'error', message: 'Route request not found' });
      return;
    }

    this.pendingRouteRequests.delete(routeId);
    await this.state.storage.put('pendingRequests', Array.from(this.pendingRouteRequests.entries()));

    // Could notify the requester, but for now just remove locally
    this.broadcast({ type: 'route_rejected', routeId });
  }

  private async checkForIntersections(newRoute: RouteState): Promise<void> {
    // Get all existing routes
    const allRouteIds = new Set<string>();

    // Collect route IDs from both players involved
    const playerAId = this.env.PLAYER.idFromName(newRoute.playerA);
    const playerBId = this.env.PLAYER.idFromName(newRoute.playerB);

    const [playerAResp, playerBResp] = await Promise.all([
      this.env.PLAYER.get(playerAId).fetch(new Request('http://internal/state')),
      this.env.PLAYER.get(playerBId).fetch(new Request('http://internal/state')),
    ]);

    if (playerAResp.ok) {
      const playerA = await playerAResp.json() as PlayerState;
      playerA.routes.forEach(r => allRouteIds.add(r));
    }
    if (playerBResp.ok) {
      const playerB = await playerBResp.json() as PlayerState;
      playerB.routes.forEach(r => allRouteIds.add(r));
    }

    // Remove the new route from the set
    allRouteIds.delete(newRoute.id);

    // Check each existing route for intersection
    for (const routeId of allRouteIds) {
      const routeDOId = this.env.ROUTE.idFromName(routeId);
      const routeDO = this.env.ROUTE.get(routeDOId);
      const routeResp = await routeDO.fetch(new Request('http://internal/state'));

      if (!routeResp.ok) continue;

      const existingRoute = await routeResp.json() as RouteState;

      // Import line intersection check
      const { lineIntersection } = await import('../lib/geo');

      const intersection = lineIntersection(
        newRoute.coordsA, newRoute.coordsB,
        existingRoute.coordsA, existingRoute.coordsB
      );

      if (intersection) {
        // Create intersection DO
        const intersectionId = `poi-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const intersectionDOId = this.env.INTERSECTION.idFromName(intersectionId);
        const intersectionDO = this.env.INTERSECTION.get(intersectionDOId);

        // Collect all players involved
        const players = new Set([
          newRoute.playerA, newRoute.playerB,
          existingRoute.playerA, existingRoute.playerB
        ]);

        const poiState: IntersectionState = {
          id: intersectionId,
          coordinates: intersection,
          routes: [newRoute.id, existingRoute.id],
          custody: Array.from(players),
          investments: {},
          controller: null,
          totalInvested: 0,
          lastActivity: Date.now(),
          createdAt: Date.now(),
        };

        await intersectionDO.fetch(new Request('http://internal/create', {
          method: 'POST',
          body: JSON.stringify(poiState),
          headers: { 'Content-Type': 'application/json' },
        }));

        // Notify all involved players
        for (const player of players) {
          const playerId = this.env.PLAYER.idFromName(player);
          const playerDO = this.env.PLAYER.get(playerId);
          // Broadcast intersection created to connected players
          await playerDO.fetch(new Request('http://internal/intersection-created', {
            method: 'POST',
            body: JSON.stringify(poiState),
            headers: { 'Content-Type': 'application/json' },
          }));
        }
      }
    }
  }

  private async handleInvestPoi(ws: WebSocket, poiId: string, amount: number): Promise<void> {
    if (!this.player) {
      this.send(ws, { type: 'error', message: 'Not authenticated' });
      return;
    }

    if (amount <= 0) {
      this.send(ws, { type: 'error', message: 'Investment amount must be positive' });
      return;
    }

    if (this.player.nits < amount) {
      this.send(ws, { type: 'error', message: 'Insufficient nits' });
      return;
    }

    // Deduct nits
    this.player.nits -= amount;

    // Track investment
    if (!this.player.poiInvestments[poiId]) {
      this.player.poiInvestments[poiId] = 0;
    }
    this.player.poiInvestments[poiId] += amount;

    // Add heat for investing
    this.player.heat = Math.min(HEAT_MAX, this.player.heat + HEAT_POI_INVEST);

    await this.state.storage.put('player', this.player);

    // Send investment to POI
    const poiDOId = this.env.INTERSECTION.idFromName(poiId);
    const poiDO = this.env.INTERSECTION.get(poiDOId);

    const response = await poiDO.fetch(new Request('http://internal/invest', {
      method: 'POST',
      body: JSON.stringify({ player: this.player.username, amount }),
      headers: { 'Content-Type': 'application/json' },
    }));

    if (response.ok) {
      const poiState = await response.json() as IntersectionState;
      this.broadcast({ type: 'poi_update', poi: poiState });
      this.broadcast({ type: 'heat_update', heat: this.player.heat });
    }
  }

  private async handleUpgradeRoute(ws: WebSocket, routeId: string): Promise<void> {
    if (!this.player) {
      this.send(ws, { type: 'error', message: 'Not authenticated' });
      return;
    }

    const upgradeCost = 50;
    const capacityIncrease = 5;

    if (this.player.nits < upgradeCost) {
      this.send(ws, { type: 'error', message: `Insufficient nits (need ${upgradeCost})` });
      return;
    }

    // Check if player owns this route
    if (!this.player.routes.includes(routeId)) {
      this.send(ws, { type: 'error', message: 'Not your route' });
      return;
    }

    // Deduct nits and add heat
    this.player.nits -= upgradeCost;
    this.player.heat = Math.min(HEAT_MAX, this.player.heat + HEAT_ROUTE_UPGRADE);
    await this.state.storage.put('player', this.player);

    // Upgrade the route
    const routeDOId = this.env.ROUTE.idFromName(routeId);
    const routeDO = this.env.ROUTE.get(routeDOId);

    await routeDO.fetch(new Request('http://internal/upgrade-capacity', {
      method: 'POST',
      body: JSON.stringify({ amount: capacityIncrease }),
      headers: { 'Content-Type': 'application/json' },
    }));

    this.broadcast({ type: 'state', player: this.player });
  }

  private async handlePlaceOrder(ws: WebSocket, side: 'bid' | 'ask', price: number, amount: number): Promise<void> {
    if (!this.player) {
      this.send(ws, { type: 'error', message: 'Not authenticated' });
      return;
    }

    if (side === 'ask' && this.player.nits < amount) {
      this.send(ws, { type: 'error', message: 'Insufficient nits' });
      return;
    }

    // Reserve nits for ask orders
    if (side === 'ask') {
      this.player.nits -= amount;
      await this.state.storage.put('player', this.player);
    }

    const marketId = this.env.MARKET.idFromName('global');
    const marketDO = this.env.MARKET.get(marketId);

    const orderId = `${this.player.username}-${Date.now()}`;

    await marketDO.fetch(new Request('http://internal/place-order', {
      method: 'POST',
      body: JSON.stringify({
        id: orderId,
        player: this.player.username,
        side,
        price,
        amount,
        createdAt: Date.now(),
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    // Add heat for trading
    this.player.heat = Math.min(HEAT_MAX, this.player.heat + HEAT_TRADE);
    await this.state.storage.put('player', this.player);
    this.broadcast({ type: 'heat_update', heat: this.player.heat });
  }

  private async handleCancelOrder(ws: WebSocket, orderId: string): Promise<void> {
    if (!this.player) {
      this.send(ws, { type: 'error', message: 'Not authenticated' });
      return;
    }

    const marketId = this.env.MARKET.idFromName('global');
    const marketDO = this.env.MARKET.get(marketId);

    await marketDO.fetch(new Request('http://internal/cancel-order', {
      method: 'POST',
      body: JSON.stringify({ orderId, player: this.player.username }),
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  private async handleUpdateNits(delta: number, reason: string): Promise<Response> {
    if (!this.player) {
      this.player = await this.state.storage.get<PlayerState>('player') ?? null;
    }

    if (this.player) {
      this.player.nits += delta;
      if (this.player.nits < 0) this.player.nits = 0;
      await this.state.storage.put('player', this.player);
      this.broadcast({ type: 'state', player: this.player });
    }

    return new Response('OK');
  }

  private async handleAddHeat(amount: number, reason: string): Promise<Response> {
    if (!this.player) {
      this.player = await this.state.storage.get<PlayerState>('player') ?? null;
    }

    if (this.player) {
      this.player.heat = Math.min(HEAT_MAX, Math.max(HEAT_MIN, this.player.heat + amount));
      await this.state.storage.put('player', this.player);
      this.broadcast({ type: 'heat_update', heat: this.player.heat });
    }

    return new Response('OK');
  }

  private async handlePoiControlChanged(poiId: string, isController: boolean): Promise<Response> {
    if (!this.controlledPois) {
      this.controlledPois = await this.state.storage.get<string[]>('controlledPois') ?? [];
    }

    if (isController && !this.controlledPois.includes(poiId)) {
      this.controlledPois.push(poiId);
      // Add heat for winning control
      if (this.player) {
        this.player.heat = Math.min(HEAT_MAX, this.player.heat + HEAT_POI_WIN);
        await this.state.storage.put('player', this.player);
        this.broadcast({ type: 'heat_update', heat: this.player.heat });
      }
    } else if (!isController) {
      this.controlledPois = this.controlledPois.filter(id => id !== poiId);
    }

    await this.state.storage.put('controlledPois', this.controlledPois);
    return new Response('OK');
  }

  private async handleTollReceived(amount: number, fromPoi: string): Promise<Response> {
    if (!this.player) {
      this.player = await this.state.storage.get<PlayerState>('player') ?? null;
    }

    if (this.player) {
      this.player.nits += amount;
      await this.state.storage.put('player', this.player);
      this.broadcast({ type: 'toll_received', amount, fromPoi });
      this.broadcast({ type: 'state', player: this.player });
    }

    return new Response('OK');
  }

  private async getVisibilityInfo(): Promise<Response> {
    if (!this.player) {
      this.player = await this.state.storage.get<PlayerState>('player') ?? null;
    }

    if (!this.player) {
      return new Response('Player not found', { status: 404 });
    }

    const info: VisiblePlayer = {
      username: this.player.username,
      coordinates: this.player.coordinates,
      heat: this.player.heat,
    };

    // Only reveal nits if heat is very high
    if (this.player.heat > 75) {
      info.nits = this.player.nits;
    }

    return Response.json(info);
  }

  async alarm(): Promise<void> {
    if (!this.player) {
      this.player = await this.state.storage.get<PlayerState>('player') ?? null;
    }
    if (!this.player) return;

    // Load controlled POIs
    if (!this.controlledPois) {
      this.controlledPois = await this.state.storage.get<string[]>('controlledPois') ?? [];
    }

    // Calculate production with POI bonuses
    const poiBonus = this.controlledPois.length * POI_PRODUCTION_BONUS;
    const totalProduction = this.player.productionRate + poiBonus;

    this.player.nits += totalProduction;

    // Decay heat
    this.player.heat = Math.max(HEAT_MIN, this.player.heat - HEAT_DECAY_PER_TICK);

    await this.state.storage.put('player', this.player);

    this.broadcast({ type: 'tick', nits: this.player.nits, heat: this.player.heat });

    await this.state.storage.setAlarm(Date.now() + TICK_INTERVAL);
  }

  private async getState(): Promise<Response> {
    const player = await this.state.storage.get<PlayerState>('player');
    if (!player) {
      return new Response('Player not found', { status: 404 });
    }
    return Response.json(player);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      this.sessions.delete(ws);
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const ws of this.sessions) {
      this.send(ws, msg);
    }
  }
}
