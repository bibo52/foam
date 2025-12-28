import { RouteState } from '../types';

export class RouteDO implements DurableObject {
  private state: DurableObjectState;
  private route: RouteState | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Load route state
    if (!this.route) {
      this.route = await this.state.storage.get<RouteState>('route') ?? null;
    }

    if (url.pathname === '/create' && request.method === 'POST') {
      const route = await request.json() as RouteState;
      this.route = route;
      await this.state.storage.put('route', route);
      return new Response('OK');
    }

    if (url.pathname === '/state' && request.method === 'GET') {
      if (!this.route) {
        return new Response('Route not found', { status: 404 });
      }
      return Response.json(this.route);
    }

    if (url.pathname === '/update-status' && request.method === 'POST') {
      if (!this.route) {
        return new Response('Route not found', { status: 404 });
      }
      const { status } = await request.json() as { status: 'pending' | 'active' | 'inactive' };
      this.route.status = status;
      await this.state.storage.put('route', this.route);
      return new Response('OK');
    }

    if (url.pathname === '/upgrade-capacity' && request.method === 'POST') {
      if (!this.route) {
        return new Response('Route not found', { status: 404 });
      }
      const { amount } = await request.json() as { amount: number };
      this.route.capacity += amount;
      await this.state.storage.put('route', this.route);
      return Response.json({ capacity: this.route.capacity });
    }

    return new Response('Not found', { status: 404 });
  }
}
