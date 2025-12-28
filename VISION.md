# foam
**F**riends **O**n **A** **M**ap / **F**ighting **O**ver **A** **M**ap

A terminal-based multiplayer economic game.

## Vision
God-mode multiplayer terminal game. You manage a node in a shared economic graph—no avatar, no walking around. Calm command center baseline with anxious trading floor spikes. Routes connect players, intersections create contested territory.

## Core Concepts

### Nodes
- **HOME node**: Your base. Produces nits. Can never be lost. Has a real-world geographic position.
- **Intersection nodes (POIs)**: Created when routes cross. Contested between all connected players. Custody can change.

### Geography
- HOME nodes are placed on a real-world map
- Players get a randomized position within their city/neighborhood (privacy-preserving)
- Routes between players follow geographic paths
- Intersections occur where paths would actually cross in the real world
- Distance may affect route cost/capacity

### Fog of War
- The full graph exists, but players only see:
  - Their HOME node
  - Nodes they're directly connected to
  - POIs at their intersections
- Expanding your network reveals more of the map
- Information about distant nodes/players is valuable

### Routes
- Connect two players (mutual consent to establish)
- Co-owned by both endpoints
- Have capacity, can be upgraded
- Carry nit flow between nodes

### Nits
- The fundamental resource (single resource type for MVP)
- Produced at HOME nodes
- Flows through routes
- Traded on market
- **Visual language**: Nit is also a unit of luminance—abundance = brightness in the UI. Wealthy nodes glow, starving routes dim. The interface is a luminance map of the economy.

### Intersections
```
    Player A
        │
        │ route
        │
   ─────●───── Player B ←──── Player C
        │       route            route
       POI
  (contested A/B/C)
```
When routes cross, a POI spawns. All players whose routes touch it share custody. Custody can shift based on... (TBD: investment? combat? bidding?).

## Tech Stack

### Server: Cloudflare Workers + Durable Objects (TypeScript)
- Worker entrypoint handles WebSocket connections
- Durable Objects for state:
  - `PlayerDO`: HOME node, inventory, production
  - `RouteDO`: Capacity, health, co-ownership
  - `IntersectionDO`: POI state, custody, contestation
  - `MarketDO`: Order book, price history

### Client: Go + bubbletea + lipgloss
- Elm architecture for complex state
- lipgloss for btop-level visual polish
- WebSocket connection to server
- Runs well on Raspberry Pi

### Auth
- Simple username (max 7 chars, alphanumeric, case-insensitive)
- Token-based session
- No password for MVP? Or simple password.

## MVP Scope: Full Vertical Slice

### Actions
1. **Produce**: HOME node generates nits over time
2. **Route**: Request route to another player → they accept → route created
3. **Trade**: Buy/sell nits on global market
4. **Conflict**: Contest POIs where your routes intersect others

### Core Loop
```
Produce nits → Route to partners/markets → Trade for profit → Upgrade capacity
     ↑                                                              │
     └──────────── Defend/contest POIs ←────────────────────────────┘
```

## Implementation Phases

### Phase 1: Foundation ✅
- [x] Create project structure (server/ and client/ directories)
- [x] Set up Cloudflare Workers project with wrangler
- [x] Basic Durable Object scaffolding (PlayerDO stub)
- [x] WebSocket connection handling
- [x] Go client scaffolding with bubbletea
- [x] Client connects to server, displays "connected"

### Phase 2: Player State & Geography ✅
- [x] PlayerDO: store username, nit balance, production rate, coordinates
- [x] Location assignment: IP geolocation → randomize within neighborhood
- [x] Production tick (Durable Object alarm, runs every N seconds)
- [x] Client displays: username, nit balance, production rate, approximate location
- [x] Simple auth: claim username, get token

### Phase 3: Routes & Intersections ✅
- [x] RouteDO: two endpoints, capacity, status, geographic path (line segment)
- [x] Route request flow: Player A requests → Player B accepts
- [x] Geographic intersection detection: when new route crosses existing routes
- [x] IntersectionDO created at crossing points (POIs)
- [x] Store route references in PlayerDO
- [x] Client: view routes, request new route, accept/reject requests
- [x] Client: fog of war - only show visible portion of graph

### Phase 4: Market ✅
- [x] MarketDO: order book (bids/asks)
- [x] Place limit orders
- [x] Order matching and fills
- [x] Client: market view, place orders, see fills

### Phase 5: POI Mechanics & Polish ✅
- [x] POI custody mechanics (basic implementation)
- [x] Dense dashboard layout (lipgloss styling)
- [x] Real-time updates (nits ticking, market prices)
- [x] Notification system (status messages)
- [ ] Performance testing on Pi (user can test)

## File Structure
```
~/Documents/Code/foam/
├── server/                    # Cloudflare Workers (TypeScript)
│   ├── src/
│   │   ├── index.ts           # Worker entrypoint, WebSocket handling
│   │   ├── durable-objects/
│   │   │   ├── player.ts      # HOME node state
│   │   │   ├── route.ts       # Route state
│   │   │   ├── intersection.ts
│   │   │   └── market.ts
│   │   ├── lib/
│   │   │   ├── geo.ts         # Geographic utils, line intersection
│   │   │   ├── graph.ts       # Topology/intersection detection
│   │   │   └── protocol.ts    # Message types
│   │   └── types.ts
│   ├── wrangler.toml
│   └── package.json
│
├── client/                    # Go + bubbletea
│   ├── cmd/foam/main.go       # CLI entrypoint
│   ├── internal/
│   │   ├── tui/
│   │   │   ├── app.go         # Root model
│   │   │   ├── dashboard.go
│   │   │   ├── map.go         # ASCII map view (fog of war)
│   │   │   ├── routes.go
│   │   │   ├── market.go
│   │   │   └── styles.go
│   │   ├── api/client.go      # WebSocket client
│   │   └── state/state.go
│   ├── go.mod
│   └── go.sum
│
└── README.md
```

## Open Design Questions (can defer)
- How does custody at POIs shift? Bidding? Investment? Time-based decay?
- What do POIs *do*? Tax throughput? Boost production? Strategic value only?
- Multiple resource types later?
- SSB/Nostr integration for social graph?
