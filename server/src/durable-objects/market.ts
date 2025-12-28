import { MarketOrder, Env } from '../types';

interface MarketState {
  bids: MarketOrder[]; // sorted by price descending (highest first)
  asks: MarketOrder[]; // sorted by price ascending (lowest first)
  priceHistory: { timestamp: number; price: number }[];
  lastPrice: number;
}

export class MarketDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private market: MarketState = { bids: [], asks: [], priceHistory: [], lastPrice: 1.0 };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Load market state
    const stored = await this.state.storage.get<MarketState>('market');
    if (stored) {
      this.market = stored;
    }

    if (url.pathname === '/state' && request.method === 'GET') {
      return Response.json(this.market);
    }

    if (url.pathname === '/place-order' && request.method === 'POST') {
      const order = await request.json() as MarketOrder;
      return this.placeOrder(order);
    }

    if (url.pathname === '/cancel-order' && request.method === 'POST') {
      const { orderId, player } = await request.json() as { orderId: string; player: string };
      return this.cancelOrder(orderId, player);
    }

    if (url.pathname === '/price' && request.method === 'GET') {
      return Response.json({ price: this.market.lastPrice });
    }

    if (url.pathname === '/price-history' && request.method === 'GET') {
      return Response.json(this.market.priceHistory.slice(-100)); // Last 100 prices
    }

    return new Response('Not found', { status: 404 });
  }

  private async placeOrder(order: MarketOrder): Promise<Response> {
    const fills: { orderId: string; amount: number; price: number; counterparty: string }[] = [];
    let remainingAmount = order.amount;

    if (order.side === 'bid') {
      // Match against asks (lowest first)
      while (remainingAmount > 0 && this.market.asks.length > 0) {
        const bestAsk = this.market.asks[0];
        if (bestAsk.price > order.price) break; // No match

        const fillAmount = Math.min(remainingAmount, bestAsk.amount);
        const fillPrice = bestAsk.price;
        fills.push({ orderId: bestAsk.id, amount: fillAmount, price: fillPrice, counterparty: bestAsk.player });

        remainingAmount -= fillAmount;
        bestAsk.amount -= fillAmount;

        if (bestAsk.amount === 0) {
          this.market.asks.shift();
        }

        // Update price history
        this.market.lastPrice = fillPrice;
        this.market.priceHistory.push({ timestamp: Date.now(), price: fillPrice });

        // Actually transfer nits
        // Buyer (order.player) receives nits
        // Seller (bestAsk.player) already escrowed their nits when placing ask
        await this.transferNits(order.player, fillAmount, 'bought');
        await this.notifyFill(bestAsk.player, bestAsk.id, fillAmount, fillPrice, 'sold');
      }

      // If there's remaining amount, add to order book
      if (remainingAmount > 0) {
        order.amount = remainingAmount;
        this.market.bids.push(order);
        this.market.bids.sort((a, b) => b.price - a.price); // Highest first
      }

      // Notify buyer of fills
      for (const fill of fills) {
        await this.notifyFill(order.player, order.id, fill.amount, fill.price, 'bought');
      }
    } else {
      // Match against bids (highest first)
      while (remainingAmount > 0 && this.market.bids.length > 0) {
        const bestBid = this.market.bids[0];
        if (bestBid.price < order.price) break; // No match

        const fillAmount = Math.min(remainingAmount, bestBid.amount);
        const fillPrice = bestBid.price;
        fills.push({ orderId: bestBid.id, amount: fillAmount, price: fillPrice, counterparty: bestBid.player });

        remainingAmount -= fillAmount;
        bestBid.amount -= fillAmount;

        if (bestBid.amount === 0) {
          this.market.bids.shift();
        }

        // Update price history
        this.market.lastPrice = fillPrice;
        this.market.priceHistory.push({ timestamp: Date.now(), price: fillPrice });

        // Actually transfer nits
        // Seller (order.player) already escrowed their nits when placing ask
        // Buyer (bestBid.player) receives nits
        await this.transferNits(bestBid.player, fillAmount, 'bought');
        await this.notifyFill(bestBid.player, bestBid.id, fillAmount, fillPrice, 'bought');
      }

      // If there's remaining amount, add to order book (nits already escrowed)
      if (remainingAmount > 0) {
        order.amount = remainingAmount;
        this.market.asks.push(order);
        this.market.asks.sort((a, b) => a.price - b.price); // Lowest first
      } else {
        // All filled - seller keeps their escrowed nits as payment
        // (they don't get nits back, they get "money" which in this game is just the exchange)
      }

      // Notify seller of fills
      for (const fill of fills) {
        await this.notifyFill(order.player, order.id, fill.amount, fill.price, 'sold');
      }
    }

    // Trim price history to last 1000 entries
    if (this.market.priceHistory.length > 1000) {
      this.market.priceHistory = this.market.priceHistory.slice(-1000);
    }

    await this.state.storage.put('market', this.market);

    return Response.json({ fills, remainingAmount });
  }

  private async cancelOrder(orderId: string, player: string): Promise<Response> {
    // Remove from bids
    const bidIndex = this.market.bids.findIndex(o => o.id === orderId && o.player === player);
    if (bidIndex !== -1) {
      this.market.bids.splice(bidIndex, 1);
      await this.state.storage.put('market', this.market);
      return new Response('OK');
    }

    // Remove from asks - return escrowed nits
    const askIndex = this.market.asks.findIndex(o => o.id === orderId && o.player === player);
    if (askIndex !== -1) {
      const ask = this.market.asks[askIndex];
      this.market.asks.splice(askIndex, 1);
      await this.state.storage.put('market', this.market);

      // Return escrowed nits to seller
      await this.transferNits(player, ask.amount, 'order cancelled');

      return new Response('OK');
    }

    return new Response('Order not found', { status: 404 });
  }

  private async transferNits(player: string, amount: number, reason: string): Promise<void> {
    const playerId = this.env.PLAYER.idFromName(player);
    const playerDO = this.env.PLAYER.get(playerId);

    await playerDO.fetch(new Request('http://internal/update-nits', {
      method: 'POST',
      body: JSON.stringify({ delta: amount, reason }),
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  private async notifyFill(player: string, orderId: string, amount: number, price: number, side: 'bought' | 'sold'): Promise<void> {
    console.log(`Fill: ${player} ${side} ${amount} nits at ${price}`);

    // Add heat for trading
    const playerId = this.env.PLAYER.idFromName(player);
    const playerDO = this.env.PLAYER.get(playerId);

    await playerDO.fetch(new Request('http://internal/add-heat', {
      method: 'POST',
      body: JSON.stringify({ amount: 2, reason: `market ${side}` }),
      headers: { 'Content-Type': 'application/json' },
    }));
  }
}
