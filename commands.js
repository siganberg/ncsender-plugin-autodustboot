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

// The AutoDustBoot firmware only accepts `goto:N` / `home` / `save` /
// `stop` — NOT `retract` / `expand`. These helpers translate our intent
// to the firmware protocol. Retract = go to position 0. Expand = go to
// the last known "expand" (saved) position — read from the device's
// most-recent status frame via pluginContext.dongle.getDevices() (which
// carries `lastMessage` like "status pos=-3 expand=46524 state=home").
function wirelessRetract() {
  wirelessSend('goto:0');
}

function wirelessExpand() {
  var savedPos = readSavedExpandPosition();
  if (savedPos !== null) {
    wirelessSend('goto:' + savedPos);
  }
  // If we don't know the saved position (device never reported one), skip
  // the send rather than guess. Operator can pair / save an expand target
  // via the plugin's config panel; without one, expand can't fire safely.
}

function readSavedExpandPosition() {
  try {
    if (typeof pluginContext === 'undefined' || !pluginContext || !pluginContext.dongle
        || typeof pluginContext.dongle.getDevices !== 'function') {
      return null;
    }
    var devices = pluginContext.dongle.getDevices();
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i];
      if (d && d.name === ADB_DEVICE_NAME && typeof d.lastMessage === 'string') {
        var m = d.lastMessage.match(/(?:^|\s)expand=(-?\d+)(?:\s|$)/);
        if (m) return parseInt(m[1], 10);
      }
    }
  } catch (_) { /* swallow — fall through to null */ }
  return null;
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
// Machine-coord positioning moves (G53) and predefined-position moves
// (G28 / G30) go to a machine-fixed location — a park spot, the tool
// changer station, a probe safe corner. They are NOT the "return to
// the workpiece" move that expands the dust boot; deploying there
// would put the boot at the wrong physical location. The plugin arms
// on M6 and waits for the FIRST workspace-coord X/Y motion before
// firing expand — machine-coord moves in the tool-change tail should
// pass through untouched.
const MACHINE_MOVE_PATTERN = /(?:^|[^A-Z])G0*(?:53|28|30)(?![0-9])/i;

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
  if (MACHINE_MOVE_PATTERN.test(stripped)) return false;
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

// True whenever retract has fired without a matching expand — i.e., the
// dust boot is (or should be) up out of the way. Consumed by the first
// G0-with-XY of a job/preamble line we see. Set by every retract path
// (job start, M6 detection, RETRACT marker); cleared on expand or job end.
// Prevents double-retract when several triggers land back-to-back (e.g.
// start-from-line preamble that also contains an M6).
let awaitingExpand = false;

// Last-observed context.jobRunning value. Used to detect the false→true
// transition (job start / start-from-line preamble start) so we can inject
// retract exactly once per job run. Set on every onBeforeCommand call.
let wasJobRunning = false;

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

  // Retract emission (wired vs wireless) — shared by every path that needs
  // to physically raise the boot. Returns an ARRAY of command objects the
  // caller splices into the batch. Wired: sync barrier + user M-codes.
  // Wireless: ESP-NOW "retract" packet + G4 dwell so the boot has time to
  // move before the next line ships.
  // Wireless emission uses the `(DONGLE:name:payload)` host-intercept
  // sentinel so ESP-NOW fires at CNC-serial-write time, AFTER grblHAL has
  // ack'd every queued command ahead of it. Sequence:
  //   1. G4 P0 — grblHAL planner-sync; only ok'd once physical moves finish.
  //   2. (DONGLE:autodustboot:goto:0) — host intercepts, sends ESP-NOW.
  //   3. G4 P1.5 — dwell so the boot has time to physically move before
  //      the next command runs.
  // Without the G4 P0 barrier, the sentinel would fire mid-cut because
  // grblHAL ok's queued lines the moment they enter the planner buffer,
  // not when they physically execute.
  function emitWirelessDongleSequence(payload) {
    var syncBarrier = { command: 'G4 P0', displayCommand: null, meta: showAddedGCode ? {} : { silent: true } };
    var sentinel    = { command: '(DONGLE:' + ADB_DEVICE_NAME + ':' + payload + ')',
                        displayCommand: null, meta: showAddedGCode ? {} : { silent: true } };
    var dwell       = createCommandSequence(dwellCommand());
    return [syncBarrier, sentinel, dwell];
  }
  function emitRetract() {
    if (settings.mode === 'wireless') {
      return emitWirelessDongleSequence('goto:0');
    }
    if (!retractCommand) return [];
    var s = syncedSequence(retractCommand);
    return [s[0], s[1]];
  }
  function emitExpand() {
    if (settings.mode === 'wireless') {
      var savedPos = readSavedExpandPosition();
      if (savedPos === null) return [];   // no saved target — skip rather than guess
      return emitWirelessDongleSequence('goto:' + savedPos);
    }
    if (!expandCommand) return [];
    var s = syncedSequence(expandCommand);
    return [s[0], s[1]];
  }

  // === Marker interception (manual terminal usage) ===
  // $ADB_RETRACT / $ADB_EXPAND typed at the terminal (or embedded in a
  // macro / gcode file by the operator) get substituted here into the
  // configured wired M-codes OR a wireless ESP-NOW packet + dwell. This
  // path also updates awaitingExpand so runtime automation stays coherent
  // with whatever the operator did manually.
  for (var mi = 0; mi < commands.length; mi++) {
    var mcmd = commands[mi];
    if (!mcmd.isOriginal) continue;
    var mtext = stripNPrefix(mcmd.command.trim());

    if (startsWithMarker(mtext, RETRACT_MARKER)) {
      var rEmit = emitRetract();
      if (rEmit.length > 0) commands.splice.apply(commands, [mi, 1].concat(rEmit));
      else commands.splice(mi, 1);
      awaitingExpand = true;
      return commands;
    }
    if (startsWithMarker(mtext, EXPAND_MARKER)) {
      var eEmit = emitExpand();
      if (eEmit.length > 0) commands.splice.apply(commands, [mi, 1].concat(eEmit));
      else commands.splice(mi, 1);
      awaitingExpand = false;
      return commands;
    }
  }

  var hasExpandRetract = (settings.mode === 'wireless') || (expandCommand && retractCommand);
  if (!hasExpandRetract) {
    // No wireless, no configured commands — nothing to inject.
    return commands;
  }

  // === Job-start detection ===
  // context.jobRunning is true during both the resume preamble and normal
  // job execution (set by JobManager before either fires). The false→true
  // transition is exactly one moment per job run — inject retract now so
  // the boot is up before anything moves. Skip if we already retracted
  // (awaitingExpand=true means an earlier trigger fired and expand hasn't
  // consumed it yet — no need to double-retract).
  //
  // Fallback for older hosts that don't provide context.jobRunning: treat
  // sourceId==='resume' as "we're in the preamble" and any N-prefixed
  // original command as "we're in the job stream". Same transition
  // semantics from those signals. Lets this plugin work on hosts predating
  // the jobRunning context field.
  var jobRunningNow;
  if (typeof context.jobRunning === 'boolean') {
    jobRunningNow = context.jobRunning;
  } else {
    var inferJob = context.sourceId === 'resume';
    if (!inferJob) {
      for (var pi = 0; pi < commands.length; pi++) {
        if (commands[pi].isOriginal && looksLikeJobLine(commands[pi].command.trim())) {
          inferJob = true;
          break;
        }
      }
    }
    jobRunningNow = inferJob;
  }
  if (jobRunningNow && !wasJobRunning && !awaitingExpand) {
    var jobStartRetract = emitRetract();
    if (jobStartRetract.length > 0) {
      commands.splice.apply(commands, [0, 0].concat(jobStartRetract));
      awaitingExpand = true;
    }
  }
  wasJobRunning = jobRunningNow;

  // === M6 detection (any context) ===
  // Fires retract before any M6 with a tool number — job line, preamble,
  // client-typed, macro. Only if we're not already in the awaiting-expand
  // state (which means retract already ran and expand hasn't consumed it).
  //
  // awaitingExpand is armed ONLY when a job is running. Auto-expand is a
  // "return-to-workpiece" cue and only makes sense while a program is
  // executing — during manual M6 the operator is in control and should
  // decide when the boot deploys. Firing expand on a manual jog after a
  // manual M6 was the bug that motivated this gate. Retract still fires
  // unconditionally because a raised boot during tool change is a safety
  // improvement regardless of context.
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
  if (toolChangeIndex !== -1 && !awaitingExpand) {
    var m6Retract = emitRetract();
    if (m6Retract.length > 0) {
      commands.splice.apply(commands, [toolChangeIndex, 0].concat(m6Retract));
      if (jobRunningNow) awaitingExpand = true;
    }
  }

  // === First G0 XY consumes the arm ===
  // Only fires on isOriginal=true commands so plugin-expanded tool-change
  // routines (e.g. pneumaticatc's rack moves — those are isOriginal=false)
  // don't accidentally trigger expand at the rack. Preamble return-to-XY
  // and normal job-file G0 XY are both isOriginal=true.
  if (awaitingExpand) {
    for (var gi = 0; gi < commands.length; gi++) {
      var gcmd = commands[gi];
      if (!gcmd.isOriginal) continue;
      var gtext = stripNPrefix(gcmd.command.trim());
      if (startsWithMarker(gtext, RETRACT_MARKER) || startsWithMarker(gtext, EXPAND_MARKER)) continue;
      if (!isG0XYLine(gtext)) continue;
      var xyExpand = emitExpand();
      if (xyExpand.length > 0) {
        commands.splice.apply(commands, [gi + 1, 0].concat(xyExpand));
        awaitingExpand = false;
      }
      break;
    }
  }

  // Wireless mode has no legacy client/macro-only retract-on-home/G0 to
  // consider — the runtime detection above already covered everything.
  if (settings.mode === 'wireless') {
    return commands;
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

// Called by the host after every job ends (complete / stop / error).
// Retract the dust boot so the machine is left in a known safe state —
// the operator won't get a boot sticking out during post-job cleanup /
// jog. For wireless installs this MUST fire from here because a bare
// wireless setup has no CNC-side signal wired to Flood to piggyback on.
// The CNC is idle by this point (last g-code already ack'd), so ESP-NOW
// can fire directly without a G4 P0 sync barrier.
function onAfterJobEnd(settings) {
  try {
    // Wireless install has no CNC-side wire to piggyback on — plugin
    // must explicitly retract so the boot is up for post-job jog /
    // cleanup. CNC is idle here (last g-code already ack'd), so ESP-NOW
    // can fire directly without the G4 P0 sync sentinel used mid-job.
    if (settings && settings.mode === 'wireless') {
      wirelessSend('goto:0');
    }
    // Wired install: the job's own postscript (M9 or the configured
    // Program-End event g-code) typically triggers the physical retract
    // because the ADB signal pin is wired to Flood. Plugin doesn't have
    // a way to inject a command outside a job without a new host hook.
  } catch (_) { /* swallow — never block job-end teardown */ }

  isToolChanging = false;
  awaitingExpand = false;
  wasJobRunning = false;
}

// Top-level hook the host calls at program-load time. We used to inject
// $ADB_RETRACT / $ADB_EXPAND markers here so runtime substitution had
// anchors — but start-from-line skips file lines before startLine, which
// left the currently-loaded tool's expand marker unreached and expand
// never fired. Everything is runtime-driven now (see onBeforeCommand's
// job-start + M6 detection), so this hook returns the content unchanged.
// injectDustBootMarkers is still exported for backward compat / tests.
function onGcodeProgramLoad(content, _context, _settings) {
  return content;
}

export { onBeforeCommand, buildInitialConfig, onAfterJobEnd, injectDustBootMarkers, onGcodeProgramLoad };
