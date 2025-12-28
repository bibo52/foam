import { Env } from './types';

export { PlayerDO } from './durable-objects/player';
export { RouteDO } from './durable-objects/route';
export { IntersectionDO } from './durable-objects/intersection';
export { MarketDO } from './durable-objects/market';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers for dev
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/') {
      return new Response('foam server running', {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      });
    }

    // WebSocket connection: /ws/:username
    if (url.pathname.startsWith('/ws/')) {
      const username = url.pathname.split('/')[2];
      if (!username || !/^[a-zA-Z0-9]{1,7}$/.test(username)) {
        return new Response('Invalid username', { status: 400 });
      }

      // Get or create player DO for this username
      const id = env.PLAYER.idFromName(username.toLowerCase());
      const player = env.PLAYER.get(id);

      // Forward the WebSocket request to the player DO
      return player.fetch(request);
    }

    // Player state: /player/:username
    if (url.pathname.startsWith('/player/')) {
      const username = url.pathname.split('/')[2];
      if (!username) {
        return new Response('Username required', { status: 400 });
      }

      const id = env.PLAYER.idFromName(username.toLowerCase());
      const player = env.PLAYER.get(id);

      const stateRequest = new Request(`${url.origin}/state`, {
        method: 'GET',
      });

      return player.fetch(stateRequest);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
