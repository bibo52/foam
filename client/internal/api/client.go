package api

import (
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

// ServerMessage types from the server
type ServerMessage struct {
	Type         string            `json:"type"`
	Username     string            `json:"username,omitempty"`
	Player       *PlayerState      `json:"player,omitempty"`
	Nits         int               `json:"nits,omitempty"`
	Message      string            `json:"message,omitempty"`
	From         string            `json:"from,omitempty"`
	RouteId      string            `json:"routeId,omitempty"`
	Route        *RouteState       `json:"route,omitempty"`
	Routes       []RouteState      `json:"routes,omitempty"`
	Intersection *IntersectionState `json:"intersection,omitempty"`
	Bids         []MarketOrder     `json:"bids,omitempty"`
	Asks         []MarketOrder     `json:"asks,omitempty"`
	OrderId      string            `json:"orderId,omitempty"`
	Amount       int               `json:"amount,omitempty"`
	Price        float64           `json:"price,omitempty"`
}

// PlayerState from the server
type PlayerState struct {
	Username       string      `json:"username"`
	Nits           int         `json:"nits"`
	ProductionRate int         `json:"productionRate"`
	Coordinates    Coordinates `json:"coordinates"`
	City           string      `json:"city"`
	Region         string      `json:"region"`
	Country        string      `json:"country"`
	CreatedAt      int64       `json:"createdAt"`
	Routes         []string    `json:"routes"`
}

// Coordinates for geographic position
type Coordinates struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// RouteState from the server
type RouteState struct {
	Id        string      `json:"id"`
	PlayerA   string      `json:"playerA"`
	PlayerB   string      `json:"playerB"`
	CoordsA   Coordinates `json:"coordsA"`
	CoordsB   Coordinates `json:"coordsB"`
	Capacity  int         `json:"capacity"`
	Status    string      `json:"status"`
	CreatedAt int64       `json:"createdAt"`
}

// IntersectionState from the server
type IntersectionState struct {
	Id          string      `json:"id"`
	Coordinates Coordinates `json:"coordinates"`
	Routes      []string    `json:"routes"`
	Custody     []string    `json:"custody"`
	CreatedAt   int64       `json:"createdAt"`
}

// MarketOrder from the server
type MarketOrder struct {
	Id        string  `json:"id"`
	Player    string  `json:"player"`
	Side      string  `json:"side"`
	Price     float64 `json:"price"`
	Amount    int     `json:"amount"`
	CreatedAt int64   `json:"createdAt"`
}

// ClientMessage to send to server
type ClientMessage struct {
	Type     string  `json:"type"`
	Username string  `json:"username,omitempty"`
	To       string  `json:"to,omitempty"`
	RouteId  string  `json:"routeId,omitempty"`
	Side     string  `json:"side,omitempty"`
	Price    float64 `json:"price,omitempty"`
	Amount   int     `json:"amount,omitempty"`
	OrderId  string  `json:"orderId,omitempty"`
}

// Client handles WebSocket communication with the foam server
type Client struct {
	conn     *websocket.Conn
	URL      string
	Username string
	Messages chan ServerMessage
	Errors   chan error
	Done     chan struct{}
}

// NewClient creates a new API client
func NewClient(baseURL, username string) *Client {
	return &Client{
		URL:      baseURL,
		Username: username,
		Messages: make(chan ServerMessage, 10),
		Errors:   make(chan error, 1),
		Done:     make(chan struct{}),
	}
}

// Connect establishes WebSocket connection to the server
func (c *Client) Connect() error {
	u, err := url.Parse(c.URL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	u.Path = fmt.Sprintf("%s/%s", u.Path, c.Username)

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}

	c.conn = conn

	go c.readPump()

	return c.Send(ClientMessage{
		Type:     "auth",
		Username: c.Username,
	})
}

// Send sends a message to the server
func (c *Client) Send(msg ClientMessage) error {
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	return c.conn.WriteMessage(websocket.TextMessage, data)
}

// RequestRoute sends a route request to another player
func (c *Client) RequestRoute(to string) error {
	return c.Send(ClientMessage{
		Type: "request_route",
		To:   to,
	})
}

// AcceptRoute accepts a pending route request
func (c *Client) AcceptRoute(routeId string) error {
	return c.Send(ClientMessage{
		Type:    "accept_route",
		RouteId: routeId,
	})
}

// RejectRoute rejects a pending route request
func (c *Client) RejectRoute(routeId string) error {
	return c.Send(ClientMessage{
		Type:    "reject_route",
		RouteId: routeId,
	})
}

// PlaceOrder places a market order
func (c *Client) PlaceOrder(side string, price float64, amount int) error {
	return c.Send(ClientMessage{
		Type:   "place_order",
		Side:   side,
		Price:  price,
		Amount: amount,
	})
}

// CancelOrder cancels a market order
func (c *Client) CancelOrder(orderId string) error {
	return c.Send(ClientMessage{
		Type:    "cancel_order",
		OrderId: orderId,
	})
}

// Close closes the connection
func (c *Client) Close() error {
	close(c.Done)
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

// readPump reads messages from WebSocket
func (c *Client) readPump() {
	defer func() {
		c.conn.Close()
	}()

	for {
		select {
		case <-c.Done:
			return
		default:
			_, message, err := c.conn.ReadMessage()
			if err != nil {
				select {
				case c.Errors <- err:
				default:
				}
				return
			}

			var msg ServerMessage
			if err := json.Unmarshal(message, &msg); err != nil {
				continue
			}

			select {
			case c.Messages <- msg:
			default:
			}
		}
	}
}
