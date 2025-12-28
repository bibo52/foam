package tui

import (
	"github.com/charmbracelet/lipgloss"
)

// Colors - nit-themed (luminance-based)
var (
	// Base colors
	ColorDim     = lipgloss.Color("#555555")
	ColorNormal  = lipgloss.Color("#888888")
	ColorBright  = lipgloss.Color("#CCCCCC")
	ColorGlow    = lipgloss.Color("#FFFFFF")

	// Accent colors
	ColorAccent  = lipgloss.Color("#FFD700") // Gold for nits
	ColorSuccess = lipgloss.Color("#00FF88")
	ColorWarning = lipgloss.Color("#FFAA00")
	ColorDanger  = lipgloss.Color("#FF4444")
)

// Styles
var (
	// Container styles
	ContainerStyle = lipgloss.NewStyle().
			Padding(1, 2).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(ColorDim)

	// Box style for dashboard panels
	BoxStyle = lipgloss.NewStyle().
			Padding(1, 2).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(ColorDim).
			Width(24)

	// Header style
	HeaderStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(ColorAccent).
			MarginBottom(1)

	// Label style for section headers
	LabelStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(ColorBright)

	// Tab styles
	TabStyle = lipgloss.NewStyle().
			Foreground(ColorDim)

	TabActiveStyle = lipgloss.NewStyle().
			Foreground(ColorAccent).
			Bold(true)

	// Status line
	StatusStyle = lipgloss.NewStyle().
			Foreground(ColorNormal).
			Italic(true)

	// Dim text
	DimStyle = lipgloss.NewStyle().
			Foreground(ColorDim)

	// Nit count - brightness indicates wealth
	NitStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(ColorAccent)

	// Connected indicator
	ConnectedStyle = lipgloss.NewStyle().
			Foreground(ColorSuccess)

	DisconnectedStyle = lipgloss.NewStyle().
			Foreground(ColorDanger)

	// Warning style
	WarningStyle = lipgloss.NewStyle().
			Foreground(ColorWarning)

	// Help text
	HelpStyle = lipgloss.NewStyle().
			Foreground(ColorDim)
)

// NitBrightness returns a color based on nit count (more nits = brighter)
func NitBrightness(nits int) lipgloss.Color {
	switch {
	case nits < 50:
		return ColorDim
	case nits < 200:
		return ColorNormal
	case nits < 500:
		return ColorBright
	default:
		return ColorGlow
	}
}
