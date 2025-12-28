import { Env } from './types';
import { initializeLABots } from './durable-objects/bot';

export { PlayerDO } from './durable-objects/player';
export { RouteDO } from './durable-objects/route';
export { IntersectionDO } from './durable-objects/intersection';
export { MarketDO } from './durable-objects/market';
export { BotDO } from './durable-objects/bot';

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

    // Initialize LA bots
    if (url.pathname === '/admin/init-bots' && request.method === 'POST') {
      try {
        await initializeLABots(env);
        return new Response('Bots initialized', { headers: corsHeaders });
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Unknown error';
        return new Response(`Error: ${error}`, { status: 500, headers: corsHeaders });
      }
    }

    // Get bot status
    if (url.pathname.startsWith('/admin/bot/')) {
      const botName = url.pathname.split('/')[3];
      if (!botName) {
        return new Response('Bot name required', { status: 400, headers: corsHeaders });
      }

      const botId = env.BOT.idFromName(botName);
      const botDO = env.BOT.get(botId);

      const statusResp = await botDO.fetch(new Request('http://internal/status'));
      const status = await statusResp.json();

      return Response.json(status, { headers: corsHeaders });
    }

    // Market state
    if (url.pathname === '/market') {
      const marketId = env.MARKET.idFromName('global');
      const marketDO = env.MARKET.get(marketId);
      const stateResp = await marketDO.fetch(new Request('http://internal/state'));
      const state = await stateResp.json();
      return Response.json(state, { headers: corsHeaders });
    }

    // Market price
    if (url.pathname === '/market/price') {
      const marketId = env.MARKET.idFromName('global');
      const marketDO = env.MARKET.get(marketId);
      const priceResp = await marketDO.fetch(new Request('http://internal/price'));
      const price = await priceResp.json();
      return Response.json(price, { headers: corsHeaders });
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

    // POI state: /poi/:poiId
    if (url.pathname.startsWith('/poi/')) {
      const poiId = url.pathname.split('/')[2];
      if (!poiId) {
        return new Response('POI ID required', { status: 400, headers: corsHeaders });
      }

      const poiDOId = env.INTERSECTION.idFromName(poiId);
      const poiDO = env.INTERSECTION.get(poiDOId);

      const stateResp = await poiDO.fetch(new Request('http://internal/state'));
      if (!stateResp.ok) {
        return new Response('POI not found', { status: 404, headers: corsHeaders });
      }

      const state = await stateResp.json();
      return Response.json(state, { headers: corsHeaders });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
