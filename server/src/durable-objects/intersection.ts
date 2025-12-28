import { IntersectionState } from '../types';

export class IntersectionDO implements DurableObject {
  private state: DurableObjectState;
  private intersection: IntersectionState | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
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
      return new Response('OK');
    }

    if (url.pathname === '/state' && request.method === 'GET') {
      if (!this.intersection) {
        return new Response('Intersection not found', { status: 404 });
      }
      return Response.json(this.intersection);
    }

    // Contest custody - allows a player to attempt to take control
    if (url.pathname === '/contest' && request.method === 'POST') {
      if (!this.intersection) {
        return new Response('Intersection not found', { status: 404 });
      }

      const { player, investment } = await request.json() as { player: string; investment: number };

      // Simple custody mechanic: investing more gives you higher chance
      // For now, just add to custody list if not already there
      if (!this.intersection.custody.includes(player)) {
        this.intersection.custody.push(player);
        await this.state.storage.put('intersection', this.intersection);
      }

      return Response.json(this.intersection);
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

    return new Response('Not found', { status: 404 });
  }
}
