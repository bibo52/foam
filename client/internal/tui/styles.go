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

	// Heat colors (cool to hot)
	ColorCool    = lipgloss.Color("#4488FF") // Blue - low heat
	ColorWarm    = lipgloss.Color("#FFAA00") // Orange - medium heat
	ColorHot     = lipgloss.Color("#FF4444") // Red - high heat
	ColorBurning = lipgloss.Color("#FF00FF") // Magenta - max heat
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

	// POI styles
	PoiControlledStyle = lipgloss.NewStyle().
			Foreground(ColorSuccess).
			Bold(true)

	PoiContestedStyle = lipgloss.NewStyle().
			Foreground(ColorWarning)

	PoiUnclaimedStyle = lipgloss.NewStyle().
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

// HeatColor returns a color based on heat level (0-100)
func HeatColor(heat int) lipgloss.Color {
	switch {
	case heat < 25:
		return ColorCool
	case heat < 50:
		return ColorWarm
	case heat < 75:
		return ColorHot
	default:
		return ColorBurning
	}
}

// HeatBar returns a visual representation of heat level
func HeatBar(heat int) string {
	const barWidth = 10
	filled := heat * barWidth / 100
	if filled > barWidth {
		filled = barWidth
	}

	bar := ""
	for i := 0; i < barWidth; i++ {
		if i < filled {
			bar += "█"
		} else {
			bar += "░"
		}
	}
	return bar
}
