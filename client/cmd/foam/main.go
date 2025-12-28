package main

import (
	"fmt"
	"os"

	"github.com/philip/foam/internal/tui"
	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	// Default server URL (local dev)
	serverURL := "ws://localhost:8787/ws"

	// Get username from args or prompt
	var username string
	if len(os.Args) > 1 {
		username = os.Args[1]
	} else {
		fmt.Print("Enter username (1-7 alphanumeric): ")
		fmt.Scanln(&username)
	}

	if username == "" {
		fmt.Println("Username required")
		os.Exit(1)
	}

	// Create and run the TUI
	app := tui.NewApp(serverURL, username)
	p := tea.NewProgram(app, tea.WithAltScreen())

	if _, err := p.Run(); err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}
}
