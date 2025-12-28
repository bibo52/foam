# FOAM Game Design Document

## Overview

FOAM (Friends On A Map / Fighting Over A Map) is a terminal-based multiplayer economic strategy game. Players manage nodes in a shared geographic network, competing for control of intersections (POIs) through resource investment and strategic positioning.

## Core Design Principles

### Economic Tension (Game Design Lens)
Every action should have opportunity cost. Resources spent on one goal can't be spent elsewhere. This creates meaningful decisions.

### Visibility vs Power Tradeoff
Aggressive actions make you visible to more players. Power comes with exposure. This prevents runaway leaders and creates natural balancing.

### Geographic Reality
Real-world positions create natural alliances and rivalries. Distance matters. Local conflicts emerge organically.

---

## Resource System

### Primary Resource: NITS
- **Production**: HOME nodes passively generate nits (base rate: 1/tick, tick = 10 seconds)
- **Uses**:
  - Invest in POIs to gain/maintain control
  - Upgrade route capacity
  - Trade on market
  - Power attacks/defense during contests
- **Accumulation**: No hard cap, but high nit counts increase your visibility (heat)

### Secondary Mechanic: HEAT (0-100)
Heat represents your activity level / threat profile. It's not a resource you spend, but a consequence of actions.

**Heat increases from:**
- Investing in POIs (+5 per investment)
- Winning a POI contest (+10)
- Trading on market (+2 per trade)
- Attacking another player's POI (+15)

**Heat decreases:**
- Passive decay: -1 per tick (10 seconds)
- Minimum heat: 0

**Heat effects:**
- 0-25: Low profile. Only directly connected players can see you.
- 26-50: Moderate. Players 2 hops away can see you.
- 51-75: Hot. Players 3 hops away can see you.
- 76-100: Burning. Visible to entire network. Your POI investments are revealed.

---

## POI (Point of Interest) Mechanics

### What POIs Are
POIs spawn at geographic intersections where routes cross. They represent contested territory.

### Control Pool
Each POI has an investment pool. Players invest nits to claim stake:
```
POI State:
  - investments: { player: amount }
  - controller: player with highest investment
  - lastContest: timestamp
```

### Control Benefits
The controller of a POI receives:
1. **Toll Income**: 10% of all nits flowing through routes that pass through this POI
2. **Vision**: Can see all players connected to this POI (regardless of heat)
3. **Production Bonus**: +0.5 nits/tick added to HOME production

### Contesting POIs
Any player connected to a POI (via routes) can invest nits to contest:
1. Investment is permanent (nits are "locked in")
2. Controller changes if another player's total investment exceeds current controller
3. Contesting raises your heat significantly
4. All invested players can see the investment breakdown (transparency at the POI level)

### POI Decay
If no activity at a POI for 5 minutes:
- All investments decay by 10%
- This prevents permanent lockout and encourages ongoing engagement

---

## Route System

### Capacity
Routes have capacity (default: 10). Capacity affects:
- Maximum nit flow per tick between connected nodes
- Investment "reach" - how quickly you can reinforce a distant POI

### Upgrading Routes
Players can spend nits to upgrade route capacity:
- Cost: 50 nits per +5 capacity
- Both players connected by route benefit
- Upgrade raises heat by +3

### Route Flow
When a POI is controlled, all routes passing through it pay toll:
- 10% of any nit transfer along that route goes to POI controller
- This creates chokepoints and strategic value for certain POIs

---

## Market Dynamics

### Purpose
The market exists for time-shifting resources:
- "I need nits NOW to contest a POI" → buy at premium
- "I'm over-exposed with high heat, need to liquidate" → sell at discount

### Order Book
Standard limit order book with bids/asks.

### Price Discovery
Price emerges from supply/demand:
- Many players contesting POIs → high demand → prices rise
- Quiet period → low demand → prices fall
- Sudden attacks create price spikes as defenders scramble

### Market Maker Bots
AI bots provide baseline liquidity:
- Place orders around a moving average
- Ensure there's always someone to trade with
- Dampen extreme volatility

---

## AI Bot System

### NPC Nodes
Bots act as NPC players in the LA area, creating a living world.

### Bot Behaviors
1. **Passive**: Just produces nits, occasionally trades
2. **Territorial**: Aggressively contests nearby POIs
3. **Trader**: Focuses on market arbitrage
4. **Expansionist**: Constantly requests new routes

### Bot Configuration
```typescript
interface BotConfig {
  username: string;
  coordinates: Coordinates;
  behavior: 'passive' | 'territorial' | 'trader' | 'expansionist';
  aggression: number; // 0-1, affects contest frequency
  riskTolerance: number; // 0-1, affects heat management
}
```

### LA Area Bots (Initial Set)
- `dtla` - Downtown LA, territorial
- `ktown` - Koreatown, trader
- `silvlk` - Silver Lake, passive
- `echopk` - Echo Park, expansionist
- `hlywod` - Hollywood, territorial
- `venice` - Venice Beach, passive
- `culver` - Culver City, trader
- `bvrlyh` - Beverly Hills, territorial (high aggression)

---

## Fog of War

### Visibility Rules
You can see:
1. Your HOME node (always)
2. Players directly connected via routes (always)
3. POIs on your routes (always)
4. Additional players based on THEIR heat level:
   - Their heat 26-50: you see them if 2 hops away
   - Their heat 51-75: you see them if 3 hops away
   - Their heat 76-100: you see them always

### Information Asymmetry
- You know a POI exists but may not see all investors
- High heat reveals your investments to everyone
- Low heat keeps you hidden but limits information gathering

---

## Game Loop

### Micro Loop (seconds)
1. Receive nit tick
2. Check for incoming route requests
3. Monitor POI status
4. React to contests

### Meso Loop (minutes)
1. Decide investment strategy
2. Expand network via new routes
3. Contest strategic POIs
4. Manage heat level

### Macro Loop (session)
1. Build network position
2. Control key chokepoints
3. Accumulate wealth
4. Become regional power (or stay nimble and hidden)

---

## Technical Implementation Notes

### Server (Cloudflare Workers + Durable Objects)
- `PlayerDO`: HOME node, nits, heat, production, routes
- `RouteDO`: Capacity, endpoints, flow tracking
- `IntersectionDO`: Investment pool, controller, decay timer
- `MarketDO`: Order book, price history
- `BotDO`: NPC behavior logic, periodic actions

### Client Updates Needed
- Heat display (thermometer or color intensity)
- POI investment view
- Fog of war overlay on network
- Market price chart
- Heat warnings

### Message Types (New)
```typescript
// Server → Client
| { type: 'heat_update'; heat: number }
| { type: 'poi_update'; poi: POIState }
| { type: 'poi_contest'; poiId: string; attacker: string; amount: number }
| { type: 'toll_received'; amount: number; fromRoute: string }
| { type: 'visibility_change'; visiblePlayers: string[] }

// Client → Server
| { type: 'invest_poi'; poiId: string; amount: number }
| { type: 'upgrade_route'; routeId: string }
```

---

## Balance Considerations

### Early Game
- Players have few routes, limited reach
- POIs are uncontested, easy to claim
- Heat is low across the board

### Mid Game
- Networks start overlapping
- POI contests become frequent
- Heat management becomes critical
- Market becomes active

### Late Game
- Powerful players have high heat (visible)
- Smaller players can snipe underdefended POIs
- Coalitions form against dominant players
- Economic warfare via market manipulation

### Anti-Snowball Mechanics
1. Heat makes powerful players visible and vulnerable
2. POI investment decay prevents permanent lockout
3. Fog of war lets new players operate undetected
4. Market allows rapid resource reallocation

---

## References

### Game Design Lenses (Art of Game Design - Jesse Schell)
- **Lens of Economy**: Nits flow creates meaningful transactions
- **Lens of Competition**: POI contests are direct rivalry
- **Lens of Cooperation**: Route establishment requires consent
- **Lens of Risk/Reward**: Heat tradeoff for power
- **Lens of the Toy**: The geographic map is fun to explore
- **Lens of Visible Progress**: Nit count, POI control, network size

### Economic Principles
- **Scarcity**: Limited nit production creates value
- **Opportunity Cost**: Every nit spent is a nit not saved
- **Liquidity Premium**: Market enables fast resource conversion at cost
- **Network Effects**: More routes = more value = more targets

---

## Implementation Phases

### Phase 1: Core Mechanics
- [ ] Add heat to PlayerDO and types
- [ ] Implement heat increase/decay logic
- [ ] Add POI investment pool to IntersectionDO
- [ ] Implement POI control transfer
- [ ] Add toll collection on route flow

### Phase 2: Market Integration
- [ ] Fix market fills to actually transfer nits
- [ ] Add heat increase on trades
- [ ] Implement price history

### Phase 3: Visibility
- [ ] Implement fog of war based on heat
- [ ] Add visibility change messages
- [ ] Update client to filter visible players

### Phase 4: Bots
- [ ] Create BotDO durable object
- [ ] Implement bot behaviors
- [ ] Spawn LA area bots
- [ ] Add market maker logic

### Phase 5: Client Updates
- [ ] Heat display
- [ ] POI investment UI
- [ ] Contest notifications
- [ ] Toll income display

### Phase 6: Polish
- [ ] Balance tuning
- [ ] Performance testing
- [ ] Deploy to production

---

## Deployment & Testing

### Initialize Bots
After deploying, initialize the LA bots by hitting:
```bash
curl -X POST https://your-worker.workers.dev/admin/init-bots
```

### Check Bot Status
```bash
curl https://your-worker.workers.dev/admin/bot/dtla
```

### API Endpoints
- `GET /` - Health check
- `GET /ws/:username` - WebSocket connection
- `GET /player/:username` - Player state
- `GET /poi/:poiId` - POI state
- `GET /market` - Market order book
- `GET /market/price` - Current market price
- `POST /admin/init-bots` - Initialize LA bots
- `GET /admin/bot/:name` - Bot status

### Client Commands
- Dashboard: `1` key
- Routes: `2` key, `r` to request, `a` to accept, `u` to upgrade
- POIs: `3` key, `j/k` to navigate, `i` to invest
- Market: `4` key, `b` to bid, `s` to sell
