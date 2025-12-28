import { IntersectionState, Env } from '../types';

// POI constants
const TOLL_RATE = 0.10; // 10% of flow
const DECAY_INTERVAL = 5 * 60 * 1000; // 5 minutes
const DECAY_RATE = 0.10; // 10% decay

export class IntersectionDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private intersection: IntersectionState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Load intersection state
    if (!this.intersection) {
      this.intersection = await this.state.storage.get<IntersectionState>('intersection') ?? null;
    }

    if (url.pathname === '/create' && request.method === 'POST') {
      const intersection = await request.json() as IntersectionState;
      this.intersection = intersection;
      await this.state.storage.put('intersection', intersection);
      // Set up decay alarm
      await this.state.storage.setAlarm(Date.now() + DECAY_INTERVAL);
      return new Response('OK');
    }

    if (url.pathname === '/state' && request.method === 'GET') {
      if (!this.intersection) {
        return new Response('Intersection not found', { status: 404 });
      }
      return Response.json(this.intersection);
    }

    // Invest in this POI
    if (url.pathname === '/invest' && request.method === 'POST') {
      if (!this.intersection) {
        return new Response('Intersection not found', { status: 404 });
      }

      const { player, amount } = await request.json() as { player: string; amount: number };

      // Add investment
      if (!this.intersection.investments) {
        this.intersection.investments = {};
      }
      if (!this.intersection.investments[player]) {
        this.intersection.investments[player] = 0;
      }
      this.intersection.investments[player] += amount;
      this.intersection.totalInvested = Object.values(this.intersection.investments).reduce((a, b) => a + b, 0);
      this.intersection.lastActivity = Date.now();

      // Determine new controller (highest investor)
      const previousController = this.intersection.controller;
      let highestAmount = 0;
      let newController: string | null = null;

      for (const [p, amt] of Object.entries(this.intersection.investments)) {
        if (amt > highestAmount) {
          highestAmount = amt;
          newController = p;
        }
      }

      this.intersection.controller = newController;

      // Notify players if controller changed
      if (previousController !== newController) {
        // Notify previous controller they lost control
        if (previousController) {
          const prevPlayerId = this.env.PLAYER.idFromName(previousController);
          const prevPlayerDO = this.env.PLAYER.get(prevPlayerId);
          await prevPlayerDO.fetch(new Request('http://internal/poi-control-changed', {
            method: 'POST',
            body: JSON.stringify({ poiId: this.intersection.id, isController: false }),
            headers: { 'Content-Type': 'application/json' },
          }));
        }

        // Notify new controller they gained control
        if (newController) {
          const newPlayerId = this.env.PLAYER.idFromName(newController);
          const newPlayerDO = this.env.PLAYER.get(newPlayerId);
          await newPlayerDO.fetch(new Request('http://internal/poi-control-changed', {
            method: 'POST',
            body: JSON.stringify({ poiId: this.intersection.id, isController: true }),
            headers: { 'Content-Type': 'application/json' },
          }));
        }
      }

      // Add investor to custody list if not already there
      if (!this.intersection.custody.includes(player)) {
        this.intersection.custody.push(player);
      }

      await this.state.storage.put('intersection', this.intersection);
      return Response.json(this.intersection);
    }

    // Collect toll (called when nits flow through routes crossing this POI)
    if (url.pathname === '/collect-toll' && request.method === 'POST') {
      if (!this.intersection || !this.intersection.controller) {
        return new Response('No controller', { status: 200 });
      }

      const { flowAmount, routeId } = await request.json() as { flowAmount: number; routeId: string };

      // Check if this route passes through this POI
      if (!this.intersection.routes.includes(routeId)) {
        return new Response('Route not through POI', { status: 200 });
      }

      const tollAmount = Math.floor(flowAmount * TOLL_RATE);
      if (tollAmount <= 0) {
        return new Response('Toll too small', { status: 200 });
      }

      // Send toll to controller
      const controllerId = this.env.PLAYER.idFromName(this.intersection.controller);
      const controllerDO = this.env.PLAYER.get(controllerId);
      await controllerDO.fetch(new Request('http://internal/toll-received', {
        method: 'POST',
        body: JSON.stringify({ amount: tollAmount, fromPoi: this.intersection.id }),
        headers: { 'Content-Type': 'application/json' },
      }));

      return Response.json({ tollAmount, controller: this.intersection.controller });
    }

    // Legacy contest endpoint - redirects to invest
    if (url.pathname === '/contest' && request.method === 'POST') {
      const { player, investment } = await request.json() as { player: string; investment: number };
      // Forward to invest
      return this.fetch(new Request('http://internal/invest', {
        method: 'POST',
        body: JSON.stringify({ player, amount: investment }),
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Add route to intersection
    if (url.pathname === '/add-route' && request.method === 'POST') {
      if (!this.intersection) {
        return new Response('Intersection not found', { status: 404 });
      }

      const { routeId } = await request.json() as { routeId: string };

      if (!this.intersection.routes.includes(routeId)) {
        this.intersection.routes.push(routeId);
        await this.state.storage.put('intersection', this.intersection);
      }

      return Response.json(this.intersection);
    }

    // Get investment breakdown (visible if high heat)
    if (url.pathname === '/investments' && request.method === 'GET') {
      if (!this.intersection) {
        return new Response('Intersection not found', { status: 404 });
      }

      return Response.json({
        investments: this.intersection.investments,
        controller: this.intersection.controller,
        totalInvested: this.intersection.totalInvested,
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    if (!this.intersection) {
      this.intersection = await this.state.storage.get<IntersectionState>('intersection') ?? null;
    }

    if (!this.intersection) return;

    // Check if no activity in decay interval
    const timeSinceActivity = Date.now() - this.intersection.lastActivity;
    if (timeSinceActivity >= DECAY_INTERVAL) {
      // Decay all investments by 10%
      let hasInvestments = false;
      for (const player of Object.keys(this.intersection.investments)) {
        const currentAmount = this.intersection.investments[player];
        const newAmount = Math.floor(currentAmount * (1 - DECAY_RATE));
        if (newAmount > 0) {
          this.intersection.investments[player] = newAmount;
          hasInvestments = true;
        } else {
          delete this.intersection.investments[player];
        }
      }

      // Recalculate total and controller
      this.intersection.totalInvested = Object.values(this.intersection.investments).reduce((a, b) => a + b, 0);

      let highestAmount = 0;
      let newController: string | null = null;
      for (const [p, amt] of Object.entries(this.intersection.investments)) {
        if (amt > highestAmount) {
          highestAmount = amt;
          newController = p;
        }
      }

      const previousController = this.intersection.controller;
      this.intersection.controller = newController;

      // Notify if controller changed due to decay
      if (previousController !== newController) {
        if (previousController) {
          const prevPlayerId = this.env.PLAYER.idFromName(previousController);
          const prevPlayerDO = this.env.PLAYER.get(prevPlayerId);
          await prevPlayerDO.fetch(new Request('http://internal/poi-control-changed', {
            method: 'POST',
            body: JSON.stringify({ poiId: this.intersection.id, isController: false }),
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (newController) {
          const newPlayerId = this.env.PLAYER.idFromName(newController);
          const newPlayerDO = this.env.PLAYER.get(newPlayerId);
          await newPlayerDO.fetch(new Request('http://internal/poi-control-changed', {
            method: 'POST',
            body: JSON.stringify({ poiId: this.intersection.id, isController: true }),
            headers: { 'Content-Type': 'application/json' },
          }));
        }
      }

      await this.state.storage.put('intersection', this.intersection);
    }

    // Set next alarm
    await this.state.storage.setAlarm(Date.now() + DECAY_INTERVAL);
  }
}
