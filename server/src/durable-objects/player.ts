import { PlayerState, ServerMessage, ClientMessage, RouteState, Env } from '../types';
import { getLocationFromRequest, getRegionFromRequest, randomizeWithinNeighborhood } from '../lib/geo';

export class PlayerDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Set<WebSocket> = new Set();
  private player: PlayerState | null = null;
  private pendingRouteRequests: Map<string, { from: string; routeId: string }> = new Map();
  private lastRequest: Request | null = null;

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

    return new Response('Not found', { status: 404 });
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

    // Ensure routes array exists (backwards compatibility)
    if (this.player && !this.player.routes) {
      this.player.routes = [];
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
      };
      await this.state.storage.put('player', this.player);
      await this.state.storage.setAlarm(Date.now() + 10000);
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

        await intersectionDO.fetch(new Request('http://internal/create', {
          method: 'POST',
          body: JSON.stringify({
            id: intersectionId,
            coordinates: intersection,
            routes: [newRoute.id, existingRoute.id],
            custody: Array.from(players),
            createdAt: Date.now(),
          }),
          headers: { 'Content-Type': 'application/json' },
        }));

        // Notify all involved players
        for (const player of players) {
          const playerId = this.env.PLAYER.idFromName(player);
          const playerDO = this.env.PLAYER.get(playerId);
          // Would need a notification endpoint for this
        }
      }
    }
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

  async alarm(): Promise<void> {
    if (!this.player) return;

    this.player.nits += this.player.productionRate;
    await this.state.storage.put('player', this.player);

    this.broadcast({ type: 'tick', nits: this.player.nits });

    await this.state.storage.setAlarm(Date.now() + 10000);
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
