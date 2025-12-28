import { MarketOrder, Env } from '../types';

interface MarketState {
  bids: MarketOrder[]; // sorted by price descending (highest first)
  asks: MarketOrder[]; // sorted by price ascending (lowest first)
}

export class MarketDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private market: MarketState = { bids: [], asks: [] };

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

    return new Response('Not found', { status: 404 });
  }

  private async placeOrder(order: MarketOrder): Promise<Response> {
    const fills: { orderId: string; amount: number; price: number }[] = [];
    let remainingAmount = order.amount;

    if (order.side === 'bid') {
      // Match against asks (lowest first)
      while (remainingAmount > 0 && this.market.asks.length > 0) {
        const bestAsk = this.market.asks[0];
        if (bestAsk.price > order.price) break; // No match

        const fillAmount = Math.min(remainingAmount, bestAsk.amount);
        fills.push({ orderId: bestAsk.id, amount: fillAmount, price: bestAsk.price });

        remainingAmount -= fillAmount;
        bestAsk.amount -= fillAmount;

        if (bestAsk.amount === 0) {
          this.market.asks.shift();
        }

        // Notify seller of fill
        await this.notifyFill(bestAsk.player, bestAsk.id, fillAmount, bestAsk.price, 'sold');
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
        fills.push({ orderId: bestBid.id, amount: fillAmount, price: bestBid.price });

        remainingAmount -= fillAmount;
        bestBid.amount -= fillAmount;

        if (bestBid.amount === 0) {
          this.market.bids.shift();
        }

        // Notify buyer of fill
        await this.notifyFill(bestBid.player, bestBid.id, fillAmount, bestBid.price, 'bought');
      }

      // If there's remaining amount, add to order book
      if (remainingAmount > 0) {
        order.amount = remainingAmount;
        this.market.asks.push(order);
        this.market.asks.sort((a, b) => a.price - b.price); // Lowest first
      }

      // Notify seller of fills
      for (const fill of fills) {
        await this.notifyFill(order.player, order.id, fill.amount, fill.price, 'sold');
      }
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

    // Remove from asks
    const askIndex = this.market.asks.findIndex(o => o.id === orderId && o.player === player);
    if (askIndex !== -1) {
      this.market.asks.splice(askIndex, 1);
      await this.state.storage.put('market', this.market);
      return new Response('OK');
    }

    return new Response('Order not found', { status: 404 });
  }

  private async notifyFill(player: string, orderId: string, amount: number, price: number, side: 'bought' | 'sold'): Promise<void> {
    // For now, we'll just log. In a real implementation, we'd notify the player's DO
    // which would broadcast to their WebSocket sessions
    console.log(`Fill: ${player} ${side} ${amount} nits at ${price}`);

    // Update player's nit balance
    const playerId = this.env.PLAYER.idFromName(player);
    const playerDO = this.env.PLAYER.get(playerId);

    // Would need an endpoint to update nits
    // await playerDO.fetch(new Request('http://internal/update-nits', { ... }));
  }
}
