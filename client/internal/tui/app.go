package tui

import (
	"fmt"
	"math"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/philip/foam/internal/api"
)

// View modes
type viewMode int

const (
	viewDashboard viewMode = iota
	viewRoutes
	viewPOIs
	viewMarket
)

// Connection states
type connState int

const (
	stateConnecting connState = iota
	stateConnected
	stateDisconnected
)

// Messages
type serverMsg api.ServerMessage
type errMsg error

// connectMsg signals successful connection
type connectMsg struct{}

// App is the main TUI model
type App struct {
	// Connection
	client    *api.Client
	connState connState
	serverURL string
	username  string

	// Player state
	player *api.PlayerState

	// Game state
	routes           []api.RouteState
	pendingRequests  []struct{ from, routeId string }
	intersections    []api.IntersectionState
	marketBids       []api.MarketOrder
	marketAsks       []api.MarketOrder
	controlledPois   []string // POI IDs we control
	tollsReceived    int      // Total tolls received this session

	// UI state
	viewMode    viewMode
	spinner     spinner.Model
	input       textinput.Model
	inputMode   string // "", "route", "bid", "ask", "invest"
	selectedPoi int    // For POI view navigation
	width       int
	height      int
	err         error
	statusMsg   string
}

// NewApp creates a new App instance
func NewApp(serverURL, username string) *App {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(ColorAccent)

	ti := textinput.New()
	ti.Placeholder = "Enter command..."
	ti.CharLimit = 32

	return &App{
		serverURL: serverURL,
		username:  username,
		connState: stateConnecting,
		spinner:   s,
		input:     ti,
		viewMode:  viewDashboard,
	}
}

// Init initializes the app
func (a *App) Init() tea.Cmd {
	return tea.Batch(
		a.spinner.Tick,
		a.connect(),
	)
}

// connect attempts to connect to the server
func (a *App) connect() tea.Cmd {
	return func() tea.Msg {
		a.client = api.NewClient(a.serverURL, a.username)
		if err := a.client.Connect(); err != nil {
			return errMsg(err)
		}
		return connectMsg{}
	}
}

// listenForMessages returns a command that listens for server messages
func (a *App) listenForMessages() tea.Cmd {
	return func() tea.Msg {
		select {
		case msg := <-a.client.Messages:
			return serverMsg(msg)
		case err := <-a.client.Errors:
			return errMsg(err)
		case <-a.client.Done:
			return nil
		}
	}
}

// Update handles messages
func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return a.handleKeyPress(msg)

	case tea.WindowSizeMsg:
		a.width = msg.Width
		a.height = msg.Height

	case spinner.TickMsg:
		var cmd tea.Cmd
		a.spinner, cmd = a.spinner.Update(msg)
		return a, cmd

	case connectMsg:
		return a, a.listenForMessages()

	case errMsg:
		a.err = msg
		a.connState = stateDisconnected
		return a, nil

	case serverMsg:
		return a.handleServerMessage(api.ServerMessage(msg))
	}

	// Update text input
	if a.inputMode != "" {
		var cmd tea.Cmd
		a.input, cmd = a.input.Update(msg)
		return a, cmd
	}

	return a, nil
}

func (a *App) handleKeyPress(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	// Handle input mode
	if a.inputMode != "" {
		switch key {
		case "esc":
			a.inputMode = ""
			a.input.Blur()
			a.input.SetValue("")
		case "enter":
			value := a.input.Value()
			a.input.SetValue("")
			a.input.Blur()
			cmd := a.handleInputSubmit(a.inputMode, value)
			a.inputMode = ""
			return a, cmd
		}
		var cmd tea.Cmd
		a.input, cmd = a.input.Update(msg)
		return a, cmd
	}

	// Normal mode
	switch key {
	case "q", "ctrl+c":
		if a.client != nil {
			a.client.Close()
		}
		return a, tea.Quit

	case "1":
		a.viewMode = viewDashboard
	case "2":
		a.viewMode = viewRoutes
	case "3":
		a.viewMode = viewPOIs
	case "4":
		a.viewMode = viewMarket

	case "r":
		if a.viewMode == viewRoutes || a.viewMode == viewDashboard {
			a.inputMode = "route"
			a.input.Placeholder = "Enter username to connect..."
			a.input.Focus()
		}

	case "a":
		// Accept first pending route request
		if len(a.pendingRequests) > 0 {
			req := a.pendingRequests[0]
			a.pendingRequests = a.pendingRequests[1:]
			return a, func() tea.Msg {
				a.client.AcceptRoute(req.routeId)
				return nil
			}
		}

	case "b":
		if a.viewMode == viewMarket {
			a.inputMode = "bid"
			a.input.Placeholder = "Enter price amount (e.g., 1.0 50)..."
			a.input.Focus()
		}

	case "s":
		if a.viewMode == viewMarket {
			a.inputMode = "ask"
			a.input.Placeholder = "Enter price amount (e.g., 1.0 50)..."
			a.input.Focus()
		}

	case "i":
		if a.viewMode == viewPOIs && len(a.intersections) > 0 {
			a.inputMode = "invest"
			a.input.Placeholder = "Enter amount to invest..."
			a.input.Focus()
		}

	case "j", "down":
		if a.viewMode == viewPOIs && len(a.intersections) > 0 {
			a.selectedPoi = (a.selectedPoi + 1) % len(a.intersections)
		}

	case "k", "up":
		if a.viewMode == viewPOIs && len(a.intersections) > 0 {
			a.selectedPoi = (a.selectedPoi - 1 + len(a.intersections)) % len(a.intersections)
		}

	case "u":
		// Upgrade selected route
		if a.viewMode == viewRoutes && len(a.routes) > 0 {
			route := a.routes[0] // TODO: add route selection
			return a, func() tea.Msg {
				a.client.UpgradeRoute(route.Id)
				return nil
			}
		}
	}

	return a, nil
}

func (a *App) handleInputSubmit(mode, value string) tea.Cmd {
	switch mode {
	case "route":
		if value != "" {
			a.statusMsg = fmt.Sprintf("Requesting route to %s...", value)
			return func() tea.Msg {
				a.client.RequestRoute(value)
				return nil
			}
		}
	case "bid", "ask":
		var price float64
		var amount int
		_, err := fmt.Sscanf(value, "%f %d", &price, &amount)
		if err == nil && price > 0 && amount > 0 {
			side := mode
			a.statusMsg = fmt.Sprintf("Placing %s order: %d nits @ %.2f", side, amount, price)
			return func() tea.Msg {
				a.client.PlaceOrder(side, price, amount)
				return nil
			}
		}
	case "invest":
		var amount int
		_, err := fmt.Sscanf(value, "%d", &amount)
		if err == nil && amount > 0 && len(a.intersections) > 0 {
			poi := a.intersections[a.selectedPoi]
			a.statusMsg = fmt.Sprintf("Investing %d nits in POI...", amount)
			return func() tea.Msg {
				a.client.InvestPoi(poi.Id, amount)
				return nil
			}
		}
	}
	return nil
}

// handleServerMessage processes messages from the server
func (a *App) handleServerMessage(msg api.ServerMessage) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case "connected":
		a.connState = stateConnected
		return a, a.listenForMessages()

	case "state":
		if msg.Player != nil {
			a.player = msg.Player
		}
		return a, a.listenForMessages()

	case "tick":
		if a.player != nil {
			a.player.Nits = msg.Nits
			a.player.Heat = msg.Heat
		}
		return a, a.listenForMessages()

	case "heat_update":
		if a.player != nil {
			a.player.Heat = msg.Heat
		}
		return a, a.listenForMessages()

	case "error":
		a.statusMsg = "Error: " + msg.Message
		return a, a.listenForMessages()

	case "route_request":
		a.pendingRequests = append(a.pendingRequests, struct{ from, routeId string }{msg.From, msg.RouteId})
		a.statusMsg = fmt.Sprintf("Route request from %s!", msg.From)
		return a, a.listenForMessages()

	case "route_accepted":
		if msg.Route != nil {
			a.routes = append(a.routes, *msg.Route)
			a.statusMsg = fmt.Sprintf("Route established: %s ↔ %s", msg.Route.PlayerA, msg.Route.PlayerB)
		}
		return a, a.listenForMessages()

	case "routes":
		a.routes = msg.Routes
		return a, a.listenForMessages()

	case "intersection_created":
		if msg.Intersection != nil {
			a.intersections = append(a.intersections, *msg.Intersection)
			a.statusMsg = "New POI created!"
		}
		return a, a.listenForMessages()

	case "poi_update":
		if msg.Poi != nil {
			// Update existing POI or add new one
			found := false
			for i, poi := range a.intersections {
				if poi.Id == msg.Poi.Id {
					a.intersections[i] = *msg.Poi
					found = true
					break
				}
			}
			if !found {
				a.intersections = append(a.intersections, *msg.Poi)
			}

			// Check if we control this POI
			if a.player != nil && msg.Poi.Controller == a.player.Username {
				if !contains(a.controlledPois, msg.Poi.Id) {
					a.controlledPois = append(a.controlledPois, msg.Poi.Id)
					a.statusMsg = "You now control a POI!"
				}
			} else {
				a.controlledPois = remove(a.controlledPois, msg.Poi.Id)
			}
		}
		return a, a.listenForMessages()

	case "poi_contest":
		a.statusMsg = fmt.Sprintf("POI contested by %s!", msg.Attacker)
		return a, a.listenForMessages()

	case "toll_received":
		a.tollsReceived += msg.Amount
		a.statusMsg = fmt.Sprintf("Received %d nits in tolls!", msg.Amount)
		return a, a.listenForMessages()

	case "market_update":
		a.marketBids = msg.Bids
		a.marketAsks = msg.Asks
		return a, a.listenForMessages()
	}

	return a, a.listenForMessages()
}

// View renders the UI
func (a *App) View() string {
	var content string

	switch a.connState {
	case stateConnecting:
		content = a.renderConnecting()
	case stateConnected:
		content = a.renderConnected()
	case stateDisconnected:
		content = a.renderDisconnected()
	}

	return content
}

func (a *App) renderConnecting() string {
	return ContainerStyle.Render(
		fmt.Sprintf("%s Connecting to foam...", a.spinner.View()),
	)
}

func (a *App) renderDisconnected() string {
	errStr := ""
	if a.err != nil {
		errStr = fmt.Sprintf("\n  %s", a.err)
	}
	return ContainerStyle.Render(
		DisconnectedStyle.Render("○ disconnected") + errStr + "\n\n" +
			HelpStyle.Render("q: quit"),
	)
}

func (a *App) renderConnected() string {
	var b strings.Builder

	// Header with tabs
	b.WriteString(a.renderHeader())
	b.WriteString("\n")

	// Main content based on view
	switch a.viewMode {
	case viewDashboard:
		b.WriteString(a.renderDashboard())
	case viewRoutes:
		b.WriteString(a.renderRoutesView())
	case viewPOIs:
		b.WriteString(a.renderPOIsView())
	case viewMarket:
		b.WriteString(a.renderMarketView())
	}

	// Status line
	if a.statusMsg != "" {
		b.WriteString("\n")
		b.WriteString(StatusStyle.Render(a.statusMsg))
	}

	// Input line
	if a.inputMode != "" {
		b.WriteString("\n")
		b.WriteString(a.input.View())
	}

	// Help
	b.WriteString("\n\n")
	b.WriteString(a.renderHelp())

	return ContainerStyle.Render(b.String())
}

func (a *App) renderHeader() string {
	tabs := []string{"[1]Dashboard", "[2]Routes", "[3]POIs", "[4]Market"}
	active := int(a.viewMode)

	var rendered []string
	for i, tab := range tabs {
		if i == active {
			rendered = append(rendered, TabActiveStyle.Render(tab))
		} else {
			rendered = append(rendered, TabStyle.Render(tab))
		}
	}

	title := HeaderStyle.Render("foam")
	tabBar := strings.Join(rendered, " ")

	return lipgloss.JoinHorizontal(lipgloss.Top, title, "  ", tabBar)
}

func (a *App) renderDashboard() string {
	var b strings.Builder

	if a.player == nil {
		return "Loading..."
	}

	// Player info box
	nitColor := NitBrightness(a.player.Nits)
	nitStyle := lipgloss.NewStyle().Bold(true).Foreground(nitColor)
	heatColor := HeatColor(a.player.Heat)
	heatStyle := lipgloss.NewStyle().Foreground(heatColor)

	location := fmt.Sprintf("%s, %s", a.player.City, a.player.Region)
	if a.player.City == "Unknown" {
		location = formatCoords(a.player.Coordinates.Lat, a.player.Coordinates.Lng)
	}

	// Calculate production bonus
	poiBonus := float64(len(a.controlledPois)) * 0.5
	totalProd := float64(a.player.ProductionRate) + poiBonus

	playerBox := BoxStyle.Render(
		lipgloss.JoinVertical(lipgloss.Left,
			LabelStyle.Render("HOME NODE"),
			"",
			fmt.Sprintf("  %s %s", ConnectedStyle.Render("●"), a.player.Username),
			fmt.Sprintf("  %s", nitStyle.Render(fmt.Sprintf("%d nits", a.player.Nits))),
			fmt.Sprintf("  +%.1f/tick", totalProd),
			"",
			fmt.Sprintf("  %s %s", heatStyle.Render(HeatBar(a.player.Heat)), heatStyle.Render(fmt.Sprintf("%d%%", a.player.Heat))),
			"",
			fmt.Sprintf("  %s", DimStyle.Render(location)),
		),
	)

	// Routes summary
	routesSummary := fmt.Sprintf("%d routes", len(a.routes))
	if len(a.pendingRequests) > 0 {
		routesSummary += fmt.Sprintf(" (%d pending)", len(a.pendingRequests))
	}

	routesBox := BoxStyle.Render(
		lipgloss.JoinVertical(lipgloss.Left,
			LabelStyle.Render("ROUTES"),
			"",
			fmt.Sprintf("  %s", routesSummary),
		),
	)

	// POIs summary
	poiStatus := fmt.Sprintf("%d POIs", len(a.intersections))
	if len(a.controlledPois) > 0 {
		poiStatus += fmt.Sprintf(" (%d controlled)", len(a.controlledPois))
	}

	poisBox := BoxStyle.Render(
		lipgloss.JoinVertical(lipgloss.Left,
			LabelStyle.Render("POIs"),
			"",
			fmt.Sprintf("  %s", poiStatus),
			fmt.Sprintf("  %s", DimStyle.Render(fmt.Sprintf("Tolls: %d", a.tollsReceived))),
		),
	)

	b.WriteString(lipgloss.JoinHorizontal(lipgloss.Top, playerBox, "  ", routesBox, "  ", poisBox))

	return b.String()
}

func (a *App) renderRoutesView() string {
	var b strings.Builder

	b.WriteString(LabelStyle.Render("ACTIVE ROUTES"))
	b.WriteString("\n\n")

	if len(a.routes) == 0 {
		b.WriteString(DimStyle.Render("  No routes established"))
		b.WriteString("\n")
		b.WriteString(DimStyle.Render("  Press 'r' to request a route"))
	} else {
		for _, route := range a.routes {
			status := ConnectedStyle.Render("●")
			if route.Status != "active" {
				status = WarningStyle.Render("○")
			}
			b.WriteString(fmt.Sprintf("  %s %s ↔ %s (cap: %d)\n",
				status, route.PlayerA, route.PlayerB, route.Capacity))
		}
	}

	if len(a.pendingRequests) > 0 {
		b.WriteString("\n")
		b.WriteString(LabelStyle.Render("PENDING REQUESTS"))
		b.WriteString("\n\n")
		for _, req := range a.pendingRequests {
			b.WriteString(fmt.Sprintf("  %s from %s [a]ccept\n",
				WarningStyle.Render("?"), req.from))
		}
	}

	return b.String()
}

func (a *App) renderPOIsView() string {
	var b strings.Builder

	b.WriteString(LabelStyle.Render("POINTS OF INTEREST"))
	b.WriteString("\n\n")

	if len(a.intersections) == 0 {
		b.WriteString(DimStyle.Render("  No POIs discovered"))
		b.WriteString("\n")
		b.WriteString(DimStyle.Render("  POIs appear when routes cross"))
	} else {
		for i, poi := range a.intersections {
			// Selection indicator
			selector := "  "
			if i == a.selectedPoi {
				selector = "> "
			}

			// Controller status
			var statusStyle lipgloss.Style
			controllerText := "unclaimed"
			if poi.Controller != "" {
				if a.player != nil && poi.Controller == a.player.Username {
					statusStyle = PoiControlledStyle
					controllerText = "YOU"
				} else {
					statusStyle = PoiContestedStyle
					controllerText = poi.Controller
				}
			} else {
				statusStyle = PoiUnclaimedStyle
			}

			// Investment info
			myInvestment := 0
			if a.player != nil {
				if inv, ok := poi.Investments[a.player.Username]; ok {
					myInvestment = inv
				}
			}

			coords := formatCoords(poi.Coordinates.Lat, poi.Coordinates.Lng)
			b.WriteString(fmt.Sprintf("%s%s %s (%s)\n",
				selector,
				statusStyle.Render("◆"),
				coords,
				statusStyle.Render(controllerText)))

			if i == a.selectedPoi {
				b.WriteString(fmt.Sprintf("    Total: %d nits | Your stake: %d\n", poi.TotalInvested, myInvestment))
				if len(poi.Investments) > 0 {
					b.WriteString("    Stakes: ")
					stakes := []string{}
					for player, amount := range poi.Investments {
						stakes = append(stakes, fmt.Sprintf("%s:%d", player, amount))
					}
					b.WriteString(strings.Join(stakes, ", "))
					b.WriteString("\n")
				}
			}
		}
	}

	return b.String()
}

func (a *App) renderMarketView() string {
	var b strings.Builder

	b.WriteString(LabelStyle.Render("MARKET"))
	b.WriteString("\n\n")

	// Bids (buy orders)
	b.WriteString("  BIDS (buy)\n")
	if len(a.marketBids) == 0 {
		b.WriteString(DimStyle.Render("    No bids\n"))
	} else {
		for _, bid := range a.marketBids {
			b.WriteString(fmt.Sprintf("    %.2f × %d (%s)\n", bid.Price, bid.Amount, bid.Player))
		}
	}

	b.WriteString("\n")

	// Asks (sell orders)
	b.WriteString("  ASKS (sell)\n")
	if len(a.marketAsks) == 0 {
		b.WriteString(DimStyle.Render("    No asks\n"))
	} else {
		for _, ask := range a.marketAsks {
			b.WriteString(fmt.Sprintf("    %.2f × %d (%s)\n", ask.Price, ask.Amount, ask.Player))
		}
	}

	return b.String()
}

func (a *App) renderHelp() string {
	var help string
	switch a.viewMode {
	case viewDashboard:
		help = "1-4: views | r: request route | q: quit"
	case viewRoutes:
		help = "1-4: views | r: request route | a: accept | u: upgrade | q: quit"
	case viewPOIs:
		help = "1-4: views | j/k: navigate | i: invest | q: quit"
	case viewMarket:
		help = "1-4: views | b: bid | s: sell | q: quit"
	}
	return HelpStyle.Render(help)
}

func formatCoords(lat, lng float64) string {
	latDir := "N"
	if lat < 0 {
		latDir = "S"
	}
	lngDir := "E"
	if lng < 0 {
		lngDir = "W"
	}
	return fmt.Sprintf("%.2f°%s, %.2f°%s", math.Abs(lat), latDir, math.Abs(lng), lngDir)
}

// Helper functions
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

func remove(slice []string, item string) []string {
	result := []string{}
	for _, s := range slice {
		if s != item {
			result = append(result, s)
		}
	}
	return result
}
