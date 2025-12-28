import { BotConfig, PlayerState, IntersectionState, Env } from '../types';

// LA area bot configurations
const LA_BOTS: BotConfig[] = [
  { username: 'dtla', coordinates: { lat: 34.0522, lng: -118.2437 }, behavior: 'territorial', aggression: 0.7, riskTolerance: 0.5 },
  { username: 'ktown', coordinates: { lat: 34.0577, lng: -118.3005 }, behavior: 'trader', aggression: 0.3, riskTolerance: 0.7 },
  { username: 'silvlk', coordinates: { lat: 34.0869, lng: -118.2702 }, behavior: 'passive', aggression: 0.2, riskTolerance: 0.3 },
  { username: 'echopk', coordinates: { lat: 34.0782, lng: -118.2606 }, behavior: 'expansionist', aggression: 0.5, riskTolerance: 0.6 },
  { username: 'hlywod', coordinates: { lat: 34.0928, lng: -118.3287 }, behavior: 'territorial', aggression: 0.6, riskTolerance: 0.4 },
  { username: 'venice', coordinates: { lat: 33.9850, lng: -118.4695 }, behavior: 'passive', aggression: 0.1, riskTolerance: 0.2 },
  { username: 'culver', coordinates: { lat: 34.0211, lng: -118.3965 }, behavior: 'trader', aggression: 0.4, riskTolerance: 0.8 },
  { username: 'bvrlyh', coordinates: { lat: 34.0736, lng: -118.4004 }, behavior: 'territorial', aggression: 0.9, riskTolerance: 0.3 },
];

// Bot tick interval (30 seconds - slower than players)
const BOT_TICK_INTERVAL = 30000;

export class BotDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private config: BotConfig | null = null;
  private initialized: boolean = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/initialize' && request.method === 'POST') {
      const config = await request.json() as BotConfig;
      return this.initialize(config);
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      return this.getStatus();
    }

    if (url.pathname === '/tick' && request.method === 'POST') {
      await this.performAction();
      return new Response('OK');
    }

    return new Response('Not found', { status: 404 });
  }

  private async initialize(config: BotConfig): Promise<Response> {
    this.config = config;
    await this.state.storage.put('config', config);

    // Create the bot's player DO
    const playerId = this.env.PLAYER.idFromName(config.username);
    const playerDO = this.env.PLAYER.get(playerId);

    // Initialize player with bot coordinates
    // We'll create a fake request to set up the player
    const initRequest = new Request('http://internal/bot-init', {
      method: 'POST',
      body: JSON.stringify({
        username: config.username,
        coordinates: config.coordinates,
        isBot: true,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    // For now, just get/create player state
    const stateResp = await playerDO.fetch(new Request('http://internal/state'));

    // If player doesn't exist, we need to create it
    // The player DO will be created on first WebSocket connect
    // For bots, we'll create it directly
    if (!stateResp.ok) {
      // Create bot player directly
      await this.createBotPlayer(config);
    }

    this.initialized = true;
    await this.state.storage.put('initialized', true);

    // Start the bot's action loop
    await this.state.storage.setAlarm(Date.now() + BOT_TICK_INTERVAL);

    return Response.json({ status: 'initialized', config });
  }

  private async createBotPlayer(config: BotConfig): Promise<void> {
    // Create a minimal player state for the bot
    const playerState: PlayerState = {
      username: config.username,
      nits: 100,
      productionRate: 1,
      coordinates: config.coordinates,
      city: 'Los Angeles',
      region: 'CA',
      country: 'US',
      createdAt: Date.now(),
      routes: [],
      heat: 0,
      poiInvestments: {},
    };

    // Store directly in the player's storage
    // This is a bit of a hack - normally we'd use the player DO's methods
    // But for bots we need to initialize without a WebSocket
    const playerId = this.env.PLAYER.idFromName(config.username);
    const playerDO = this.env.PLAYER.get(playerId);

    // Use a special endpoint for bot initialization
    await playerDO.fetch(new Request('http://internal/bot-create', {
      method: 'POST',
      body: JSON.stringify(playerState),
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  private async getStatus(): Promise<Response> {
    const config = await this.state.storage.get<BotConfig>('config');
    const initialized = await this.state.storage.get<boolean>('initialized') ?? false;

    if (!config) {
      return Response.json({ status: 'not initialized' });
    }

    // Get bot's player state
    const playerId = this.env.PLAYER.idFromName(config.username);
    const playerDO = this.env.PLAYER.get(playerId);
    const stateResp = await playerDO.fetch(new Request('http://internal/state'));

    let playerState = null;
    if (stateResp.ok) {
      playerState = await stateResp.json();
    }

    return Response.json({
      status: initialized ? 'active' : 'initializing',
      config,
      playerState,
    });
  }

  async alarm(): Promise<void> {
    await this.performAction();
    // Schedule next action
    await this.state.storage.setAlarm(Date.now() + BOT_TICK_INTERVAL);
  }

  private async performAction(): Promise<void> {
    if (!this.config) {
      this.config = await this.state.storage.get<BotConfig>('config') ?? null;
    }
    if (!this.config) return;

    // Get bot's current state
    const playerId = this.env.PLAYER.idFromName(this.config.username);
    const playerDO = this.env.PLAYER.get(playerId);
    const stateResp = await playerDO.fetch(new Request('http://internal/state'));

    if (!stateResp.ok) return;

    const playerState = await stateResp.json() as PlayerState;

    // Decide action based on behavior
    switch (this.config.behavior) {
      case 'passive':
        await this.passiveAction(playerState);
        break;
      case 'territorial':
        await this.territorialAction(playerState);
        break;
      case 'trader':
        await this.traderAction(playerState);
        break;
      case 'expansionist':
        await this.expansionistAction(playerState);
        break;
    }
  }

  private async passiveAction(state: PlayerState): Promise<void> {
    // Passive bots just accumulate nits and occasionally trade
    if (!this.config) return;

    // 10% chance to place a small market order
    if (Math.random() < 0.1 && state.nits > 20) {
      await this.placeMarketOrder(state, 'ask', 1.0, Math.floor(state.nits * 0.1));
    }
  }

  private async territorialAction(state: PlayerState): Promise<void> {
    if (!this.config) return;

    // Territorial bots invest heavily in POIs they're connected to
    const investChance = this.config.aggression;

    if (Math.random() < investChance && state.nits > 50) {
      // Find POIs we can invest in (from our poiInvestments or nearby)
      const poiIds = Object.keys(state.poiInvestments);

      if (poiIds.length > 0) {
        const targetPoi = poiIds[Math.floor(Math.random() * poiIds.length)];
        const investAmount = Math.floor(state.nits * 0.3 * this.config.aggression);

        if (investAmount > 0) {
          await this.investInPoi(state.username, targetPoi, investAmount);
        }
      }
    }

    // Also try to expand network if heat is low
    if (state.heat < 30 && Math.random() < 0.2) {
      await this.requestRandomRoute(state);
    }
  }

  private async traderAction(state: PlayerState): Promise<void> {
    if (!this.config) return;

    // Trader bots actively use the market
    const tradeChance = 0.5;

    if (Math.random() < tradeChance) {
      // Get current market price
      const marketId = this.env.MARKET.idFromName('global');
      const marketDO = this.env.MARKET.get(marketId);
      const priceResp = await marketDO.fetch(new Request('http://internal/price'));

      if (priceResp.ok) {
        const { price } = await priceResp.json() as { price: number };

        // Random strategy: sometimes bid, sometimes ask
        if (Math.random() < 0.5 && state.nits > 30) {
          // Sell some nits at or above market price
          const askPrice = price * (1 + Math.random() * 0.1); // 0-10% above
          const amount = Math.floor(state.nits * 0.2);
          await this.placeMarketOrder(state, 'ask', askPrice, amount);
        } else {
          // Try to buy nits below market price
          const bidPrice = price * (0.9 + Math.random() * 0.1); // 0-10% below
          const amount = Math.floor(10 + Math.random() * 20);
          await this.placeMarketOrder(state, 'bid', bidPrice, amount);
        }
      }
    }
  }

  private async expansionistAction(state: PlayerState): Promise<void> {
    if (!this.config) return;

    // Expansionist bots constantly try to make new connections
    const expandChance = 0.4;

    if (Math.random() < expandChance) {
      await this.requestRandomRoute(state);
    }

    // Also invest moderately in POIs
    if (state.nits > 40 && Math.random() < 0.3) {
      const poiIds = Object.keys(state.poiInvestments);
      if (poiIds.length > 0) {
        const targetPoi = poiIds[Math.floor(Math.random() * poiIds.length)];
        await this.investInPoi(state.username, targetPoi, Math.floor(state.nits * 0.15));
      }
    }
  }

  private async placeMarketOrder(state: PlayerState, side: 'bid' | 'ask', price: number, amount: number): Promise<void> {
    if (amount <= 0) return;
    if (side === 'ask' && state.nits < amount) return;

    const marketId = this.env.MARKET.idFromName('global');
    const marketDO = this.env.MARKET.get(marketId);

    await marketDO.fetch(new Request('http://internal/place-order', {
      method: 'POST',
      body: JSON.stringify({
        id: `${state.username}-${Date.now()}`,
        player: state.username,
        side,
        price,
        amount,
        createdAt: Date.now(),
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    // If ask, deduct nits from bot's balance
    if (side === 'ask') {
      const playerId = this.env.PLAYER.idFromName(state.username);
      const playerDO = this.env.PLAYER.get(playerId);
      await playerDO.fetch(new Request('http://internal/update-nits', {
        method: 'POST',
        body: JSON.stringify({ delta: -amount, reason: 'market order' }),
        headers: { 'Content-Type': 'application/json' },
      }));
    }
  }

  private async investInPoi(username: string, poiId: string, amount: number): Promise<void> {
    if (amount <= 0) return;

    const playerId = this.env.PLAYER.idFromName(username);
    const playerDO = this.env.PLAYER.get(playerId);

    // Deduct nits first
    await playerDO.fetch(new Request('http://internal/update-nits', {
      method: 'POST',
      body: JSON.stringify({ delta: -amount, reason: 'poi investment' }),
      headers: { 'Content-Type': 'application/json' },
    }));

    // Invest in POI
    const poiDOId = this.env.INTERSECTION.idFromName(poiId);
    const poiDO = this.env.INTERSECTION.get(poiDOId);

    await poiDO.fetch(new Request('http://internal/invest', {
      method: 'POST',
      body: JSON.stringify({ player: username, amount }),
      headers: { 'Content-Type': 'application/json' },
    }));

    // Add heat
    await playerDO.fetch(new Request('http://internal/add-heat', {
      method: 'POST',
      body: JSON.stringify({ amount: 5, reason: 'poi investment' }),
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  private async requestRandomRoute(state: PlayerState): Promise<void> {
    if (!this.config) return;

    // Pick a random other bot to connect to
    const otherBots = LA_BOTS.filter(b => b.username !== this.config!.username);

    if (otherBots.length === 0) return;

    const target = otherBots[Math.floor(Math.random() * otherBots.length)];

    // Check if we already have a route to this bot
    const hasRoute = state.routes.some(r => r.includes(target.username));
    if (hasRoute) return;

    // Request route
    const playerId = this.env.PLAYER.idFromName(state.username);
    const playerDO = this.env.PLAYER.get(playerId);

    // Use internal route request mechanism
    const targetId = this.env.PLAYER.idFromName(target.username);
    const targetDO = this.env.PLAYER.get(targetId);

    const routeId = `${state.username}-${target.username}-${Date.now()}`;

    await targetDO.fetch(new Request('http://internal/route-request', {
      method: 'POST',
      body: JSON.stringify({ from: state.username, routeId }),
      headers: { 'Content-Type': 'application/json' },
    }));

    // Bots auto-accept route requests (handled in alarm or we can simulate)
  }
}

// Helper function to initialize all LA bots
export async function initializeLABots(env: Env): Promise<void> {
  for (const botConfig of LA_BOTS) {
    const botId = env.BOT.idFromName(botConfig.username);
    const botDO = env.BOT.get(botId);

    await botDO.fetch(new Request('http://internal/initialize', {
      method: 'POST',
      body: JSON.stringify(botConfig),
      headers: { 'Content-Type': 'application/json' },
    }));
  }
}
