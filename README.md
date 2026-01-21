# AutoDustBoot Plugin

> **IMPORTANT DISCLAIMER:** This plugin is part of my personal ncSender project. If you choose to use it, you do so entirely at your own risk. I am not responsible for any damage, malfunction, or personal injury that may result from the use or misuse of this plugin. Use it with caution and at your own discretion.

Automatically manages dust boot retraction and expansion during CNC operations. This plugin intercepts G-code commands and injects retract/expand sequences at appropriate times to prevent the dust boot from interfering with tool changes, homing, and rapid positioning moves.

## Features

- **Automatic Retraction on Tool Change** - Retracts the dust boot before M6 or $TLS tool change commands
- **Smart Expansion After Tool Change** - Automatically expands the dust boot after the first XY movement following a tool change
- **Homing Support** - Optional retraction before homing ($H) commands
- **Rapid Move Protection** - Optional retraction during manual G0 rapid moves from the terminal or macros
- **Customizable G-code Sequences** - Configure your own retract and expand commands with full G-code support
- **Silent Mode** - Option to hide injected commands from the terminal for cleaner output

## Configuration

Access settings via **Plugins → AutoDustBoot** in the toolbar menu.

| Setting | Description | Default |
|---------|-------------|---------|
| **Retract Sequence** | G-code sequence to retract the dust boot | `M8` `G4 P0.1` `M9` |
| **Expand Sequence** | G-code sequence to expand the dust boot | `M8` |
| **Retract on Home** | Automatically retract when homing ($H) | Enabled |
| **Retract on Rapid Move (G0)** | Retract during manual rapid moves | Enabled |
| **Show Added GCode in Terminal** | Display injected commands in terminal | Disabled |

## How It Works

### Tool Change Flow (M6 / $TLS)

1. When a tool change command is detected in a job, the plugin injects the **Retract Sequence** before the command
2. The plugin tracks the tool change state and looks for the first XY movement
3. After the first XY movement (positioning to cut location), the **Expand Sequence** is injected
4. If your G-code file contains an expand command (e.g., M8), it will be commented out to prevent duplication

### Homing ($H)

When `Retract on Home` is enabled, the **Retract Sequence** is injected before any $H homing command.

### Manual Rapid Moves (G0)

When `Retract on Rapid Move` is enabled and a G0 command is sent from the terminal or a macro (not from a running job), the **Retract Sequence** is injected before the rapid move.

## Typical Setup

For a pneumatic dust boot controlled by M8 (activate) and M9 (deactivate):

- **Retract Sequence**: `M8` followed by `G4 P0.1` (dwell) followed by `M9`
- **Expand Sequence**: `M8`

The retract sequence activates the pneumatic cylinder (M8), waits briefly for it to actuate (G4 P0.1), then deactivates (M9) leaving the boot in the retracted position. The expand sequence simply pulses M8 to return the boot to the expanded position.

## Installation

Install this plugin in ncSender through the **Plugins** interface.

## Development

This plugin is part of the ncSender ecosystem: https://github.com/siganberg/ncSender

## License

See main ncSender repository for license information.
