/**
 * AutoDustBoot - Command Processor
 * Pure command processing logic for automatic dust boot retract/expand.
 * Runs on Node.js natively OR on .NET via Jint.
 * No import/require/fetch/ctx — pure input→output.
 */

// === Boot-marker constants ===
// Load-time insertion inserts these into the loaded program at strategic
// points (before each tool change, after the first XY rapid that follows).
// Runtime interception (below, in onBeforeCommand) turns them into either
// the user-configured wired M-codes or the wireless ESP-NOW request.
// They are not sent to the controller in their raw form.
const RETRACT_MARKER = '$ADB_RETRACT';
const EXPAND_MARKER = '$ADB_EXPAND';
const MARKER_ATTRIBUTION = ' (Added by AutoDustBoot Plugin)';

// Name the paired AutoDustBoot device is known by on the dongle. Matches the
// config UI's DEVICE constant and the "@autodustboot …" frames coming off the
// dongle.
const ADB_DEVICE_NAME = 'autodustboot';

// Substitution the wireless path leaves in the g-code stream after firing the
// ESP-NOW send. G4 blocks the controller for the given seconds, giving the
// stepper time to physically retract/expand before the next line goes out.
// Kept as a plain string so the user can eyeball it in the terminal.
const ADB_WIRELESS_DWELL_SECONDS = 1.5;

function markerLine(marker) {
  return marker + MARKER_ATTRIBUTION;
}

function startsWithMarker(text, marker) {
  if (!text || typeof text !== 'string') return false;
  if (text === marker) return true;
  if (text.length <= marker.length) return false;
  if (text.substring(0, marker.length) !== marker) return false;
  const next = text.charAt(marker.length);
  return next === ' ' || next === '\t' || next === '(';
}

// GcodeJobProcessor prefixes every job line with "N<lineNumber> " before it
// reaches the plugin pipeline. Strip that so marker matching works, and use its
// presence as a reliable "this is a job stream" signal — context.sourceId is
// null in job context (Meta isn't set on the inbound processor context).
const N_PREFIX_PATTERN = /^\s*N\d+\s+/i;

function stripNPrefix(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(N_PREFIX_PATTERN, '');
}

function looksLikeJobLine(text) {
  return typeof text === 'string' && N_PREFIX_PATTERN.test(text);
}

// Fire an ESP-NOW payload at the paired AutoDustBoot device via the plugin
// context's dongle bridge. Fire-and-forget: the sync with the g-code stream
// is done via the G4 dwell that follows this call, not via an ack.
// pluginContext is a global that the host injects into the Jint engine at
// plugin load (see JsPluginEngine.BuildPluginContext); guard defensively in
// case a future host runs commands.js standalone (tests, Node smoke script).
function wirelessSend(payload) {
  try {
    if (typeof pluginContext !== 'undefined'
        && pluginContext
        && pluginContext.dongle
        && typeof pluginContext.dongle.send === 'function') {
      pluginContext.dongle.send(ADB_DEVICE_NAME, payload);
    }
  } catch (_) {
    // Swallow: better to skip the dongle send than blow up the job stream.
  }
}

function dwellCommand() {
  return 'G4 P' + ADB_WIRELESS_DWELL_SECONDS;
}

// === M6 Pattern Matching (inlined — ctx.utils unavailable in Jint) ===

const M6_PATTERN = /(?:^|[^A-Z])M0*6(?:\s*T0*(\d+)|(?=[^0-9T])|$)|(?:^|[^A-Z])T0*(\d+)\s*M0*6(?:[^0-9]|$)/i;

function isGcodeComment(command) {
  const trimmed = command.trim();
  const withoutLineNumber = trimmed.replace(/^N\d+\s*/i, '');
  if (withoutLineNumber.startsWith(';')) {
    return true;
  }
  if (withoutLineNumber.startsWith('(') && withoutLineNumber.endsWith(')')) {
    return true;
  }
  return false;
}

function parseM6Command(command) {
  if (!command || typeof command !== 'string') {
    return null;
  }
  if (isGcodeComment(command)) {
    return null;
  }
  const normalizedCommand = command.trim().toUpperCase();
  const match = normalizedCommand.match(M6_PATTERN);
  if (!match) {
    return null;
  }
  const toolNumberStr = match[1] || match[2];
  const toolNumber = toolNumberStr ? parseInt(toolNumberStr, 10) : null;
  return {
    toolNumber: Number.isFinite(toolNumber) ? toolNumber : null,
    matched: true
  };
}

// === Load-time marker insertion ===
// Mirrors the tschanger.html rules:
//   1. Insert $ADB_RETRACT immediately before any M6 or M98 (tool change).
//   2. Insert $ADB_EXPAND after the first G0/G00 rapid move with X or Y
//      that follows the tool change.
// Idempotent: if the file already contains the markers at those positions
// (e.g. re-loaded a previously-injected file), we do not double-insert.

const M98_PATTERN = /(?:^|[^A-Z])M0*98(?![0-9])/i;
const G0_XY_PATTERN = /(?:^|[^A-Z])G0*0(?![0-9]).*?(?:^|[^A-Z])[XY][-+]?\d/i;

function isToolChangeLine(rawLine) {
  if (!rawLine || typeof rawLine !== 'string') return false;
  if (isGcodeComment(rawLine)) return false;
  const parsed = parseM6Command(rawLine);
  if (parsed !== null && parsed.matched) return true;
  const stripped = rawLine.trim().toUpperCase().replace(/^N\d+\s*/, '');
  return M98_PATTERN.test(stripped);
}

function isG0XYLine(rawLine) {
  if (!rawLine || typeof rawLine !== 'string') return false;
  if (isGcodeComment(rawLine)) return false;
  const stripped = rawLine.trim().toUpperCase().replace(/^N\d+\s*/, '');
  return G0_XY_PATTERN.test(stripped);
}

function findLastNonBlank(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t;
  }
  return '';
}

function injectDustBootMarkers(content) {
  if (!content || typeof content !== 'string') {
    return content;
  }

  const lines = content.split(/\r?\n/);
  const output = [];
  let waitingForExpandLocation = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isToolChangeLine(line)) {
      // Guard against double-injection on re-load: skip $ADB_RETRACT if the
      // last non-blank output line already begins with the marker.
      if (!startsWithMarker(findLastNonBlank(output), RETRACT_MARKER)) {
        output.push(markerLine(RETRACT_MARKER));
      }
      output.push(line);
      waitingForExpandLocation = true;
      continue;
    }

    if (waitingForExpandLocation && isG0XYLine(line)) {
      output.push(line);
      // Peek at next non-blank source line; skip inserting if it's already
      // the expand marker (previously injected).
      let next = '';
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t) { next = t; break; }
      }
      if (!startsWithMarker(next, EXPAND_MARKER)) {
        output.push(markerLine(EXPAND_MARKER));
      }
      waitingForExpandLocation = false;
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

// === Module-level state (persists in Jint engine between calls) ===

let isToolChanging = false;

// === Settings Sanitization ===

const buildInitialConfig = function(raw) {
  if (!raw) raw = {};
  return {
    mode: raw.mode === 'wireless' ? 'wireless' : 'wired',
    retractCommand: raw.retractCommand || 'M8\nG4 P0.1\nM9\nG4 P1.5',
    expandCommand: raw.expandCommand || 'M8',
    retractOnHome: raw.retractOnHome !== undefined ? raw.retractOnHome : true,
    retractOnRapidMove: raw.retractOnRapidMove !== undefined ? raw.retractOnRapidMove : true,
    showAddedGCode: raw.showAddedGCode !== undefined ? raw.showAddedGCode : false
  };
};

// === Command Processing ===

function onBeforeCommand(commands, context, settings) {
  const expandCommand = settings.expandCommand;
  const retractCommand = settings.retractCommand;
  const retractOnHome = settings.retractOnHome;
  const retractOnRapidMove = settings.retractOnRapidMove;
  const showAddedGCode = settings.showAddedGCode;

  // Helper to create command sequence
  function createCommandSequence(commandText) {
    var sequence = [];

    if (showAddedGCode) {
      sequence.push('(Start of AutoDustBoot Plugin Sequence)');
    }

    sequence.push(commandText);

    if (showAddedGCode) {
      sequence.push('(End of AutoDustBoot Plugin Sequence)');
    }

    return {
      command: sequence.join('\n'),
      displayCommand: null,
      meta: showAddedGCode ? {} : { silent: true }
    };
  }

  // Two-command replacement for the wired retract/expand markers:
  //   cmd 1 = a standalone "G4 P0" planner-sync barrier (its own command, NOT
  //           folded into the sequence, so grblHAL drains all queued motion —
  //           the machine physically reaches position — before the M-code fires)
  //   cmd 2 = the user-configured retract/expand sequence
  // When "show added g-code" is on, the Start/End comments wrap the whole pair as
  // one encapsulated unit: the Start comment rides with the sync (cmd 1) and the
  // End comment rides with the sequence (cmd 2).
  function syncedSequence(commandText) {
    var first = [];
    if (showAddedGCode) first.push('(Start of AutoDustBoot Plugin Sequence)');
    first.push('G4 P0');

    var second = [];
    second.push(commandText);
    if (showAddedGCode) second.push('(End of AutoDustBoot Plugin Sequence)');

    return [
      { command: first.join('\n'), displayCommand: null, meta: showAddedGCode ? {} : { silent: true } },
      { command: second.join('\n'), displayCommand: null, meta: showAddedGCode ? {} : { silent: true } }
    ];
  }

  // === Runtime marker interception ===
  // Markers were inserted at load time by injectDustBootMarkers().
  //   Wired:    substitute with the user-configured retract/expand M-code sequence.
  //   Wireless: fire an ESP-NOW "retract" / "expand" to the AutoDustBoot device
  //             (the firmware knows the saved expand position), then substitute
  //             the marker with a G4 dwell so the controller blocks long enough
  //             for the boot to physically move before the next line goes out.
  var isJobLine = false;
  for (var mi = 0; mi < commands.length; mi++) {
    var mcmd = commands[mi];
    if (!mcmd.isOriginal) continue;
    var mrawTrimmed = mcmd.command.trim();
    if (looksLikeJobLine(mrawTrimmed)) isJobLine = true;
    var mtext = stripNPrefix(mrawTrimmed);

    if (startsWithMarker(mtext, RETRACT_MARKER)) {
      if (settings.mode === 'wireless') {
        wirelessSend('retract');
        commands.splice(mi, 1, createCommandSequence(dwellCommand()));
      } else if (retractCommand) {
        var rseq = syncedSequence(retractCommand);
        commands.splice(mi, 1, rseq[0], rseq[1]);
      } else {
        commands.splice(mi, 1);
      }
      return commands;
    }
    if (startsWithMarker(mtext, EXPAND_MARKER)) {
      if (settings.mode === 'wireless') {
        wirelessSend('expand');
        commands.splice(mi, 1, createCommandSequence(dwellCommand()));
      } else if (expandCommand) {
        var eseq = syncedSequence(expandCommand);
        commands.splice(mi, 1, eseq[0], eseq[1]);
      } else {
        commands.splice(mi, 1);
      }
      return commands;
    }
  }

  // Wireless mode drives the ESP-NOW stepper directly (manual controls in the dialog);
  // beyond the marker interception above, nothing else applies.
  if (settings.mode === 'wireless') {
    return commands;
  }

  var hasExpandRetract = expandCommand && retractCommand;
  if (!hasExpandRetract) {
    return commands;
  }

  // === Legacy M6 / $TLS / post-M6-XY tracking ===
  // Only runs for non-job contexts (client-typed M6, macros). In job context
  // the load-time marker insertion already handled tool-change retract/expand,
  // so running this again would double-retract every tool change.
  // Detect job via N-prefix (GcodeJobProcessor prefixes every job line with
  // "N<lineNumber> " — context.sourceId is null in job context so it can't be
  // used reliably).
  if (!isJobLine) {
    // Find original M6 or $TLS command
    var m6Index = commands.findIndex(function(cmd) {
      if (!cmd.isOriginal) return false;
      var parsed = parseM6Command(cmd.command);
      return parsed !== null && parsed.matched && parsed.toolNumber !== null;
    });

    var tlsIndex = commands.findIndex(function(cmd) {
      if (!cmd.isOriginal) return false;
      return /^\$tls/i.test(cmd.command.trim());
    });

    var toolChangeIndex = m6Index !== -1 ? m6Index : tlsIndex;

    if (toolChangeIndex !== -1) {
      var isTLS = toolChangeIndex === tlsIndex;
      var commandText = commands[toolChangeIndex].command.trim();

      if (isTLS) {
        var sequence = createCommandSequence(retractCommand);
        commands.splice(toolChangeIndex, 0, sequence);
        return commands;
      } else {
        // M6 command
        var parsed = parseM6Command(commandText);
        var toolNumber = parsed !== null ? parsed.toolNumber : null;

        if (toolNumber !== null && Number.isFinite(toolNumber)) {
          var seq = createCommandSequence(retractCommand);
          commands.splice(toolChangeIndex, 0, seq);
          return commands;
        }
      }
    }
  }

  // Handle $H home command
  var homeIndex = commands.findIndex(function(cmd) {
    return cmd.isOriginal && cmd.command.trim().toUpperCase().startsWith('$H');
  });

  if (homeIndex !== -1 && retractOnHome) {
    var homeSequence = createCommandSequence(retractCommand);
    commands.splice(homeIndex, 0, homeSequence);
    return commands;
  }

  // Handle G0 rapid move (client/macro only)
  if ((context.sourceId === 'client' || context.sourceId === 'macro') && retractOnRapidMove) {
    var g0Index = commands.findIndex(function(cmd) {
      var normalized = cmd.command.toUpperCase().replace(/([GM])0+(\d)/g, '$1$2');
      var hasG0 = /\bG0\b/i.test(normalized);
      return cmd.isOriginal && hasG0;
    });

    if (g0Index !== -1) {
      var g0Sequence = createCommandSequence(retractCommand);
      commands.splice(g0Index, 0, g0Sequence);
      return commands;
    }
  }

  return commands;
}

function onAfterJobEnd() {
  isToolChanging = false;
}

// Top-level hook the host calls at program-load time via
// state.JintEngine.GetValue("onGcodeProgramLoad"). Must exist as a top-level
// name in commands.js — the Node-side ctx.registerEventHandler in index.js
// does NOT wire this path.
function onGcodeProgramLoad(content, _context, _settings) {
  return injectDustBootMarkers(content);
}

export { onBeforeCommand, buildInitialConfig, onAfterJobEnd, injectDustBootMarkers, onGcodeProgramLoad };
