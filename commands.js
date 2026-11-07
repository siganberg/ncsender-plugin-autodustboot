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
// $ADB_GOTO <mm>: move the boot to an exact height, in mm below its retracted
// (home) position. Wireless only: the wired hookup can just toggle M-codes.
const GOTO_MARKER_RE = /^\$ADB_GOTO\s*Z?\s*([+-]?\d*\.?\d+)\s*(?:\(.*\))?$/i;
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

// Hosts that understand `(DONGLE_WAIT:…)` hold the stream until the boot
// REPORTS it reached the target instead of dwelling the fixed seconds above:
// no wait at all when it is already there (e.g. retract with the boot up),
// and a slow move is waited out rather than guessed. The firmware stops within
// 3 steps of the target; the timeout only matters if the boot never answers.
const ADB_WAIT_TOLERANCE_STEPS = 50;
const ADB_WAIT_TIMEOUT_SECONDS = 5;

function hostSupportsWait() {
  try {
    return typeof pluginContext !== 'undefined' && !!pluginContext && !!pluginContext.dongle
      && pluginContext.dongle.supportsWait === true;
  } catch (_) {
    return false;
  }
}

function waitCommand(targetPos) {
  return '(DONGLE_WAIT:' + ADB_DEVICE_NAME + ':pos=' + targetPos + ':'
    + ADB_WAIT_TOLERANCE_STEPS + ':' + ADB_WAIT_TIMEOUT_SECONDS + ')';
}

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

// Home offset lives on the device (NVS). The dialog pushes it when it changes,
// but a boot swapped in, flashed, or changed by hand can disagree with the
// saved setting — so before moving the boot, compare the `hoff=` it reports
// with the setting and re-send $HOMEOFFSET when they differ. Older firmware
// reports no hoff and is left alone. Throttled: one attempt per 10 s.
const ADB_COUNTS_PER_MM = 505.7;
var lastHomeOffsetSyncMs = 0;

function readDeviceHomeOffsetCounts() {
  try {
    if (typeof pluginContext === 'undefined' || !pluginContext || !pluginContext.dongle
        || typeof pluginContext.dongle.getDevices !== 'function') return null;
    var devices = pluginContext.dongle.getDevices();
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i];
      if (d && d.name === ADB_DEVICE_NAME && d.connected !== false && typeof d.lastMessage === 'string') {
        var m = d.lastMessage.match(/(?:^|\s)hoff=(\d+)(?:\s|$)/);
        if (m) return parseInt(m[1], 10);
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

function syncHomeOffset(settings, nowMs) {
  if (!settings || settings.mode !== 'wireless') return;
  var wantMm = Number(settings.homeOffsetMm) || 0;
  var haveCounts = readDeviceHomeOffsetCounts();
  if (haveCounts === null) return;
  if (Math.abs(haveCounts / ADB_COUNTS_PER_MM - wantMm) < 0.1) return;
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (now - lastHomeOffsetSyncMs < 10000) return;
  lastHomeOffsetSyncMs = now;
  wirelessSend('$HOMEOFFSET:' + wantMm);
}

// === Plunge follow (wireless only) ===
// While the boot is extended, every time work Z drops another interval below
// zero the boot is raised by that interval, so it stays at about the same
// height above the work surface. It returns to the saved expand position once
// Z is back near zero, and the count starts over.
const Z_WORD_PATTERN = /(?:^|[^A-Z])Z([-+]?(?:\d+\.?\d*|\.\d+))/;
const Z_REFERENCE_CODE_PATTERN = /(?:^|[^A-Z])G0*(?:53|92|10|28|30|38|43|49|5[4-9])(?:\.\d+)?(?![0-9])/;
const G92_PATTERN = /(?:^|[^A-Z])G0*92(?![0-9.])/;

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

// Last-observed context.laserMode. While the laser is the active head the
// dust boot must stay put: every automatic trigger below is skipped, and
// onAfterJobEnd (which has no context of its own) reads this to decide
// whether the wireless job-end retract should fire.
let laserModeActive = false;

// Plunge-follow state. followArmed is true only while the boot is extended
// (set when an expand is emitted, cleared by every retract path and job end).
// followRetractMm is how far follow has raised the boot above its expand
// position. trackedZ is the work Z in mm, parsed from the job stream.
let followArmed = false;
let followRetractMm = 0;
let trackedZ = 0;
let trackedZKnown = false;
let absMode = true;
let inchMode = false;

function armFollow() {
  followArmed = true;
  followRetractMm = 0;
}

function disarmFollow() {
  followArmed = false;
  followRetractMm = 0;
}

function resetFollowState() {
  disarmFollow();
  trackedZKnown = false;
  absMode = true;
  inchMode = false;
}

// === Settings Sanitization ===

const buildInitialConfig = function(raw) {
  if (!raw) raw = {};
  var cfg = {
    mode: raw.mode === 'wireless' ? 'wireless' : 'wired',
    retractCommand: raw.retractCommand || 'M8\nG4 P0.1\nM9\nG4 P1.5',
    expandCommand: raw.expandCommand || 'M8',
    retractOnHome: raw.retractOnHome !== undefined ? raw.retractOnHome : true,
    retractOnRapidMove: raw.retractOnRapidMove !== undefined ? raw.retractOnRapidMove : true,
    showAddedGCode: raw.showAddedGCode !== undefined ? raw.showAddedGCode : false,
    // Physical extension distance (mm) reported by the device firmware.
    // Config UI uses it to clamp the mm readout and slider bounds; the
    // plugin's runtime doesn't send it anywhere. Default matches shipped
    // firmware (92 mm).
    maxTravelMm: (function() {
      var v = Number(raw.maxTravelMm);
      return (isFinite(v) && v >= 10) ? v : 92;
    })(),
    // How far below the top stop the retracted (0) position sits after homing.
    // Lives on the device (NVS, $HOMEOFFSET:<mm>); kept here for the dialog.
    homeOffsetMm: (function() {
      var v = Number(raw.homeOffsetMm);
      return (isFinite(v) && v >= 0) ? Math.min(v, 50) : 0;
    })(),
    // Safe zones (wireless only, beta): machine-coordinate rectangles where
    // the boot rides at safe height instead of expanded, e.g. over clamps or
    // extrusions at the edges. See the Safe zones section below.
    zonesEnabled: raw.zonesEnabled === true,
    zones: sanitizeZones(raw.zones),
    // Safe height as the boot position, mm below retracted (what the dialog
    // shows). Unset: safeLiftMm above the expanded position.
    safePosMm: raw.safePosMm === null || raw.safePosMm === undefined || raw.safePosMm === '' ? null : clampNum(raw.safePosMm, 0, 500, null),
    safeLiftMm: clampNum(raw.safeLiftMm, 1, 90, 28),
    zoneClearanceMm: clampNum(raw.zoneClearanceMm, 0, 50, 5),
    liftEarlySec: clampNum(raw.liftEarlySec, 0, 3, 0.3),
    stayUpBetween: raw.stayUpBetween !== undefined ? raw.stayUpBetween === true : true,
    pauseIfLate: raw.pauseIfLate !== undefined ? raw.pauseIfLate === true : true,
    // Wireless only. Every time work Z drops another this-many mm below zero
    // the boot is raised by the same amount; 0 turns the feature off.
    plungeFollowIntervalMm: (function() {
      var v = parseFloat(raw.plungeFollowIntervalMm);
      return (isFinite(v) && v > 0) ? Math.min(v, 92) : 0;
    })()
  };
  zoneSettings = cfg;
  return cfg;
};

// === Plunge follow ===

function trackPlungeFollow(commands, context, settings) {
  var interval = settings.plungeFollowIntervalMm;
  var wpos = context.machineState && context.machineState.wpos;
  var returnZ = -interval / 2;
  var meta = settings.showAddedGCode ? {} : { silent: true };

  function injected(text) {
    return { command: text, displayCommand: null, meta: meta };
  }
  function gotoCommand(counts) {
    return injected('(DONGLE:' + ADB_DEVICE_NAME + ':goto:' + counts + ')');
  }

  for (var i = 0; i < commands.length; i++) {
    var cmd = commands[i];
    if (!cmd.isOriginal) continue;
    var text = stripNPrefix(cmd.command.trim()).replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase().trim();
    if (!text || text.charAt(0) === '$') continue;

    if (/(?:^|[^A-Z])G0*90(?![0-9.])/.test(text)) absMode = true;
    if (/(?:^|[^A-Z])G0*91(?![0-9.])/.test(text)) absMode = false;
    if (/(?:^|[^A-Z])G0*20(?![0-9.])/.test(text)) inchMode = true;
    if (/(?:^|[^A-Z])G0*21(?![0-9.])/.test(text)) inchMode = false;

    var unit = inchMode ? 25.4 : 1;
    var zMatch = text.match(Z_WORD_PATTERN);

    if (Z_REFERENCE_CODE_PATTERN.test(text)) {
      if (G92_PATTERN.test(text) && zMatch) {
        trackedZ = parseFloat(zMatch[1]) * unit;
        trackedZKnown = true;
      } else {
        trackedZKnown = false;
      }
      continue;
    }
    if (!zMatch) continue;

    var value = parseFloat(zMatch[1]) * unit;
    var newZ;
    if (absMode) {
      newZ = value;
    } else {
      if (!trackedZKnown && wpos && Number.isFinite(wpos.z)) {
        trackedZ = wpos.z;
        trackedZKnown = true;
      }
      if (!trackedZKnown) continue;
      newZ = trackedZ + value;
    }
    trackedZ = newZ;
    trackedZKnown = true;

    if (!followArmed) continue;
    var expandPos = readSavedExpandPosition();
    if (expandPos === null) continue;

    var need = newZ < 0 ? Math.min(Math.floor(-newZ / interval) * interval, settings.maxTravelMm) : 0;
    if (need > followRetractMm) {
      // Boot goes up: fire-and-forget, no G4, so the cut is never held. The
      // sentinel fires a few moves early at worst, which only raises the boot sooner.
      var target = Math.max(expandPos - Math.round(need * ADB_COUNTS_PER_MM), 0);
      commands.splice(i, 0, gotoCommand(target));
      i++;
      followRetractMm = need;
    } else if (followRetractMm > 0 && newZ >= returnZ) {
      // Boot comes back down once Z is back near zero (half an interval of
      // hysteresis), and only after the lift has physically finished.
      commands.splice(i + 1, 0, injected('G4 P0'), gotoCommand(expandPos));
      i += 2;
      followRetractMm = 0;
    }
  }
}


// === Safe zones (wireless, beta) ===
// Some areas of the bed have something sticking up — clamps, extrusions at
// the edges — that the expanded boot would hit while the bit itself clears
// it. In those zones the boot rides at a safe height (expanded minus
// safeLiftMm) and drops back once the spindle has left, without pausing the
// job: the lift goes straight to the boot over the dongle, timed ahead.
//
// Timing: the host gives the loaded program with each line's estimated
// seconds (from $110–$122 and $11) and, about 10 times a second, the line
// executing now, the machine position and the work offset. From the spindle
// the plugin walks the program forward, finds when the toolpath first
// enters a zone (plus clearance) and sends the lift once that is within the
// boot's move time + liftEarlySec + a latency allowance. Estimates are
// scaled down (ZONE_TIME_SAFETY) so a machine faster than the estimate still
// gets the boot up in time. Safety net: when the spindle is about to enter
// and the boot can't be up yet, a feed hold, resumed when it is.
//
// Zones are spindle-centre areas: where the spindle centre must not be with
// the boot expanded. Drawing them by jogging the spindle to the corners
// (boot edge just over the obstacle) gives exactly that.

var zoneSettings = null;
const ZONE_TICK_MS = 100;
const ZONE_TIME_SAFETY = 0.85;   // predicted times × this: lift a little early rather than late
const ZONE_LATENCY_SEC = 0.25;   // status age + tick + radio
const BOOT_MM_PER_SEC = 60;      // conservative; the boot moves ~80 mm/s
const BOOT_START_SEC = 0.15;
const ZONE_HORIZON_SEC = 12;
const ZONE_MAX_LINES_AHEAD = 4000;

function clampNum(v, lo, hi, dflt) {
  var n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

var MAX_ZONES = 3;

function sanitizeZones(raw) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  for (var i = 0; i < raw.length && out.length < MAX_ZONES; i++) {
    var z = raw[i] || {};
    var x1 = Number(z.x1), x2 = Number(z.x2), y1 = Number(z.y1), y2 = Number(z.y2);
    if (![x1, x2, y1, y2].every(isFinite)) continue;
    out.push({
      name: typeof z.name === 'string' && z.name.trim() ? z.name.trim().slice(0, 40) : 'Zone ' + (out.length + 1),
      x1: Math.min(x1, x2), x2: Math.max(x1, x2),
      y1: Math.min(y1, y2), y2: Math.max(y1, y2),
      enabled: z.enabled !== false
    });
  }
  return out;
}

function bootMoveSec(mm) { return BOOT_START_SEC + Math.abs(mm) / BOOT_MM_PER_SEC; }

// Active zones grown by the clearance.
function activeRects(settings) {
  var c = settings.zoneClearanceMm || 0;
  var out = [];
  (settings.zones || []).forEach(function(z) {
    if (z.enabled === false) return;
    out.push({ x1: z.x1 - c, x2: z.x2 + c, y1: z.y1 - c, y2: z.y2 + c, name: z.name });
  });
  return out;
}

function insideAny(rects, x, y) {
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i];
    if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2) return true;
  }
  return false;
}

// Liang–Barsky: the fraction [0,1] along (x0,y0)→(x1,y1) where it first is
// inside the rectangle, or -1 when it never is.
function segmentEntry(x0, y0, x1, y1, r) {
  var dx = x1 - x0, dy = y1 - y0;
  var t0 = 0, t1 = 1;
  var p = [-dx, dx, -dy, dy];
  var q = [x0 - r.x1, r.x2 - x0, y0 - r.y1, r.y2 - y0];
  for (var i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return -1;
    } else {
      var t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return -1; if (t > t0) t0 = t; }
      else { if (t < t0) return -1; if (t < t1) t1 = t; }
    }
  }
  return t0;
}

// The program as XY polylines per line, in work coordinates (or machine
// coordinates for G53 lines, flagged mc). Lines without XY motion, or whose
// start isn't known (after G28/G30/G53/G92), are null.
function parseProgramPaths(text) {
  var lines = String(text || '').split('\n');
  var out = new Array(lines.length);
  var abs = true, inch = false, motion = null;
  var x = NaN, y = NaN;
  var wordRe = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
  for (var i = 0; i < lines.length; i++) {
    out[i] = null;
    var raw = lines[i].toUpperCase().replace(/\([^)]*\)/g, '').replace(/;.*$/, '');
    if (!raw.trim()) continue;
    var w = {}, gs = [], m;
    wordRe.lastIndex = 0;
    while ((m = wordRe.exec(raw)) !== null) {
      var v = parseFloat(m[2]);
      if (m[1] === 'G') gs.push(Math.round(v * 10) / 10); else if (!(m[1] in w)) w[m[1]] = v;
    }
    var lineMotion = null, g53 = false, lost = false;
    for (var g = 0; g < gs.length; g++) {
      var c = gs[g];
      if (c === 90) abs = true; else if (c === 91) abs = false;
      else if (c === 20) inch = true; else if (c === 21) inch = false;
      else if (c >= 0 && c <= 3 && c === Math.floor(c)) { motion = c; lineMotion = c; }
      else if (c === 53) g53 = true;
      else if (c === 28 || c === 30 || c === 92 || c === 28.1 || c === 30.1) lost = true;
    }
    var hasX = 'X' in w, hasY = 'Y' in w;
    if (lost) { x = NaN; y = NaN; continue; }
    var mot = lineMotion !== null ? lineMotion : motion;
    if (mot === null || (!hasX && !hasY && !('I' in w) && !('J' in w))) continue;
    var k = inch ? 25.4 : 1;
    if (g53) {
      // Machine coordinates, this line only; work position unknown after.
      var mx = hasX ? w.X * k : NaN, my = hasY ? w.Y * k : NaN;
      if (isFinite(mx) && isFinite(my)) out[i] = { pts: [mx, my], mc: true, rapid: mot === 0 };
      x = NaN; y = NaN;
      continue;
    }
    var nx = hasX ? (abs ? w.X * k : x + w.X * k) : x;
    var ny = hasY ? (abs ? w.Y * k : y + w.Y * k) : y;
    if (isFinite(x) && isFinite(y) && isFinite(nx) && isFinite(ny)) {
      var pts = [x, y];
      if ((mot === 2 || mot === 3) && ('I' in w || 'J' in w || 'R' in w)) {
        arcPoints(pts, x, y, nx, ny, w, k, mot === 2);
      }
      pts.push(nx, ny);
      out[i] = { pts: pts, mc: false, rapid: mot === 0 };
    }
    x = nx; y = ny;
  }
  return out;
}

// Intermediate points of an XY arc, every ≤ 10°, between start and end.
function arcPoints(pts, x0, y0, x1, y1, w, k, cw) {
  var cx, cy;
  if ('I' in w || 'J' in w) {
    cx = x0 + (w.I || 0) * k; cy = y0 + (w.J || 0) * k;
  } else {
    var r = w.R * k, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    var dx = x1 - x0, dy = y1 - y0, d = Math.sqrt(dx * dx + dy * dy);
    if (!(d > 0) || Math.abs(r) < d / 2) return;
    var h = Math.sqrt(r * r - d * d / 4) * ((cw ? 1 : -1) * (r > 0 ? 1 : -1));
    cx = mx - h * dy / d; cy = my + h * dx / d;
  }
  var a0 = Math.atan2(y0 - cy, x0 - cx), a1 = Math.atan2(y1 - cy, x1 - cx);
  var rad = Math.sqrt((x0 - cx) * (x0 - cx) + (y0 - cy) * (y0 - cy));
  var sweep = a1 - a0;
  if (cw) { if (sweep >= 0) sweep -= 2 * Math.PI; } else { if (sweep <= 0) sweep += 2 * Math.PI; }
  var n = Math.min(72, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  for (var s = 1; s < n; s++) {
    var a = a0 + sweep * s / n;
    pts.push(cx + rad * Math.cos(a), cy + rad * Math.sin(a));
  }
}

function polyLength(p) {
  var len = 0;
  for (var i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return len;
}

// Seconds until the spindle first enters a rect, walking the program from
// the executing line; Infinity when it doesn't within the horizon.
//   paths/lineSec: parseProgramPaths + host estimates (index = line - 1)
//   line: executing line (1-based); pos: machine XY now; wco: work offset
//   rates: { feed, rapid } overrides as fractions (1 = 100 %)
function secondsToZone(paths, lineSec, line, pos, wco, rects, rates) {
  if (!rects.length) return Infinity;
  if (insideAny(rects, pos.x, pos.y)) return 0;
  var t = 0;
  var start = Math.max(0, line - 1);
  for (var i = start; i < paths.length && i < start + ZONE_MAX_LINES_AHEAD; i++) {
    var p = paths[i];
    var sec = (lineSec && lineSec[i]) || 0;
    if (!p) { t += sec / Math.max(0.1, rates.feed); if (t > ZONE_HORIZON_SEC) break; continue; }
    var ox = p.mc ? 0 : wco.x, oy = p.mc ? 0 : wco.y;
    var pts = [];
    for (var j = 0; j < p.pts.length; j += 2) pts.push(p.pts[j] + ox, p.pts[j + 1] + oy);
    var scale = sec * ZONE_TIME_SAFETY / Math.max(0.1, p.rapid ? rates.rapid : rates.feed);
    var total = polyLength(pts);
    if (i === start) {
      // Only what's left of the line being cut: from the spindle on.
      var cut = remainingFrom(pts, pos.x, pos.y);
      scale = total > 0 ? scale * polyLength(cut) / total : 0;
      total = polyLength(cut);
      pts = cut;
    }
    if (pts.length < 4) { t += scale; continue; }
    var acc = 0;
    for (var s = 2; s < pts.length; s += 2) {
      var x0 = pts[s - 2], y0 = pts[s - 1], x1 = pts[s], y1 = pts[s + 1];
      var segLen = Math.hypot(x1 - x0, y1 - y0);
      for (var r = 0; r < rects.length; r++) {
        var e = segmentEntry(x0, y0, x1, y1, rects[r]);
        if (e >= 0) return t + (total > 0 ? scale * (acc + e * segLen) / total : 0);
      }
      acc += segLen;
    }
    t += scale;
    if (t > ZONE_HORIZON_SEC) break;
  }
  return Infinity;
}

// The polyline from the point nearest (x, y) to its end.
function remainingFrom(pts, x, y) {
  var best = 0, bestD = Infinity, bestT = 0;
  for (var s = 2; s < pts.length; s += 2) {
    var x0 = pts[s - 2], y0 = pts[s - 1], dx = pts[s] - x0, dy = pts[s + 1] - y0;
    var l2 = dx * dx + dy * dy;
    var u = l2 > 0 ? Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
    var px = x0 + u * dx, py = y0 + u * dy;
    var d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < bestD) { bestD = d; best = s; bestT = u; }
  }
  if (best === 0) return pts.slice();
  var out = [pts[best - 2] + bestT * (pts[best] - pts[best - 2]), pts[best - 1] + bestT * (pts[best + 1] - pts[best - 1])];
  return out.concat(pts.slice(best));
}

// What the boot should do now: 'up', 'down' or null (leave it).
//   state: 'up' | 'down'; entrySec: secondsToZone; inZone: spindle inside
function decideZone(state, entrySec, inZone, settings, upSinceSec) {
  var liftSec = bootMoveSec(settings.safeLiftMm) + settings.liftEarlySec + ZONE_LATENCY_SEC;
  if (state !== 'up') return (inZone || entrySec <= liftSec) ? 'up' : null;
  if (inZone) return null;
  // Don't bounce: give a lift a moment before dropping again, and stay up
  // when the next entry comes back before a drop and lift would be done.
  if (upSinceSec < 0.3) return null;
  var keepUp = liftSec + bootMoveSec(settings.safeLiftMm) + (settings.stayUpBetween ? 2 : 0);
  return entrySec > keepUp ? 'down' : null;
}

// --- Runtime (host timer) ---
var zone = {
  state: 'idle',        // idle | down | up
  stamp: null,          // program the paths belong to
  paths: null,
  lineSec: null,
  unitsInch: false,
  upAt: 0,              // ms the last lift is expected to be done
  changedAt: 0,
  held: false,
  heldAt: 0,
  pending: null         // 'up' when an expand was sent as a safe-height lift
};

function zoneReset() {
  if (zone.held) resumeFromZoneHold();
  zone.state = 'idle';
  zone.pending = null;
}

function zonesActive(settings) {
  return !!settings && settings.mode === 'wireless' && settings.zonesEnabled === true
    && activeRects(settings).length > 0;
}

function hostHas(fn) {
  return typeof pluginContext !== 'undefined' && !!pluginContext && typeof pluginContext[fn] === 'function';
}

function readBootStatus() {
  try {
    var devices = pluginContext.dongle.getDevices();
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i];
      if (d && d.name === ADB_DEVICE_NAME && typeof d.lastMessage === 'string') {
        var pm = d.lastMessage.match(/(?:^|\s)pos=(-?\d+)(?:\s|$)/);
        var em = d.lastMessage.match(/(?:^|\s)expand=(-?\d+)(?:\s|$)/);
        return {
          pos: pm ? parseInt(pm[1], 10) : null,
          expand: em ? parseInt(em[1], 10) : null,
          connected: d.connected !== false
        };
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

function safePosition(settings, expand) {
  if (settings.safePosMm !== null && settings.safePosMm !== undefined && isFinite(settings.safePosMm)) {
    return Math.max(0, Math.min(expand, Math.round(settings.safePosMm * ADB_COUNTS_PER_MM)));
  }
  return Math.max(0, Math.round(expand - settings.safeLiftMm * ADB_COUNTS_PER_MM));
}

// The settings with safeLiftMm as the real lift for this boot, for timing.
function withLift(settings, expand) {
  var out = {};
  for (var k in settings) out[k] = settings[k];
  out.safeLiftMm = Math.max(0, (expand - safePosition(settings, expand)) / ADB_COUNTS_PER_MM);
  return out;
}

// Load the paths for the program the job runs. Done at job start, where the
// stream waits on the start retract anyway, and again if the program changes.
function prepareZones(settings) {
  if (!zonesActive(settings) || !hostHas('getProgram')) return false;
  try {
    var program = pluginContext.getProgram();
    if (!program) { zone.paths = null; return false; }
    if (zone.stamp !== program.stamp || !zone.paths) {
      zone.paths = parseProgramPaths(program.text);
      zone.lineSec = program.lineSec;
      zone.stamp = program.stamp;
    }
    var s13 = hostHas('getFirmwareSetting') ? pluginContext.getFirmwareSetting('13') : null;
    // $13 bit 0: positions reported in inches.
    zone.unitsInch = typeof s13 === 'number' && (s13 & 1) === 1;
    return true;
  } catch (e) {
    zone.paths = null;
    return false;
  }
}

function machineXY(st) {
  var k = zone.unitsInch ? 25.4 : 1;
  return {
    pos: { x: st.mpos.x * k, y: st.mpos.y * k },
    wco: { x: st.wco.x * k, y: st.wco.y * k }
  };
}

function holdForZone() {
  if (zone.held || !hostHas('sendCommand')) return;
  pluginContext.sendCommand('!', '! (AutoDustBoot: waiting for the boot to reach safe height)');
  zone.held = true;
  zone.heldAt = Date.now();
}

function resumeFromZoneHold() {
  if (!zone.held) return;
  zone.held = false;
  if (hostHas('sendCommand')) pluginContext.sendCommand('~', '~ (AutoDustBoot: boot at safe height)');
}

function zoneTick() {
  var settings = zoneSettings;
  if (!zonesActive(settings) || !hostHas('getServerState')) { if (zone.state !== 'idle') zoneReset(); return; }
  var st = pluginContext.getServerState();
  // A feed hold (ours or the operator's) shows as a paused job.
  var job = st ? st.jobStatus : null;
  if ((job !== 'running' && job !== 'paused') || awaitingExpand || laserModeActive || !st.mpos) {
    if (zone.state !== 'idle') zoneReset();
    return;
  }
  // Paused by the operator: leave everything as it is until they resume.
  if (job === 'paused' && !zone.held) return;

  var boot = readBootStatus();
  if (!boot || !boot.connected || boot.expand === null || boot.expand <= 0) return;
  var safe = safePosition(settings, boot.expand);
  settings = withLift(settings, boot.expand);
  var tol = ADB_WAIT_TOLERANCE_STEPS;
  var now = Date.now();

  if (zone.state === 'idle') {
    // Take over once the stream's expand (or its safe-height version) is done.
    if (boot.pos === null) return;
    if (Math.abs(boot.pos - boot.expand) <= tol) zone.state = 'down';
    else if (Math.abs(boot.pos - safe) <= tol) { zone.state = 'up'; zone.upAt = now; zone.changedAt = now; }
    else return;
    if (!zone.paths) prepareZones(settings);
  }
  if (!zone.paths) return;

  var rects = activeRects(settings);
  var m = machineXY(st);
  var inZone = insideAny(rects, m.pos.x, m.pos.y);
  var rates = { feed: (st.feedOverride || 100) / 100, rapid: (st.rapidOverride || 100) / 100 };
  var entry = secondsToZone(zone.paths, zone.lineSec, st.line || 0, m.pos, m.wco, rects, rates);

  var action = decideZone(zone.state, entry, inZone, settings, (now - zone.changedAt) / 1000);
  if (action === 'up') {
    wirelessSend('goto:' + safe);
    zone.state = 'up';
    zone.changedAt = now;
    var fromMm = boot.pos === null ? settings.safeLiftMm : Math.abs(boot.pos - safe) / ADB_COUNTS_PER_MM;
    zone.upAt = now + bootMoveSec(fromMm) * 1000;
  } else if (action === 'down') {
    wirelessSend('goto:' + boot.expand);
    zone.state = 'down';
    zone.changedAt = now;
  }

  // Safety net: about to enter and the boot can't be up yet.
  if (zone.state === 'up') {
    var reachedSafe = boot.pos !== null && boot.pos <= safe + tol;
    var done = reachedSafe || now >= zone.upAt;
    if (!done && settings.pauseIfLate && (inZone || entry < 0.2) && st.machineStatus === 'Run') holdForZone();
    if (zone.held && (reachedSafe || now >= zone.upAt + 300)) resumeFromZoneHold();
  }
}

// Expand target for a G0 XY that lands in a zone: safe height instead.
function expandTargetFor(gtext, settings, expand) {
  if (!zonesActive(settings) || !hostHas('getServerState')) return expand;
  try {
    var w = {}, m, re = /([XY])\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi;
    var up = gtext.toUpperCase();
    if (/G0*91(?![0-9])|G0*53(?![0-9])/.test(up)) return expand;
    while ((m = re.exec(up)) !== null) w[m[1]] = parseFloat(m[2]);
    var st = pluginContext.getServerState();
    if (!st || !st.wco) return expand;
    var mm = machineXY(st);
    var k = /G0*20(?![0-9])/.test(up) ? 25.4 : 1;
    var x = 'X' in w ? w.X * k + mm.wco.x : mm.pos.x;
    var y = 'Y' in w ? w.Y * k + mm.wco.y : mm.pos.y;
    if (insideAny(activeRects(settings), x, y)) return safePosition(settings, expand);
  } catch (_) { /* expand as usual */ }
  return expand;
}

if (typeof pluginContext !== 'undefined' && pluginContext && typeof pluginContext.setInterval === 'function') {
  pluginContext.setInterval(function() {
    try { zoneTick(); } catch (_) { /* never break the host timer */ }
  }, ZONE_TICK_MS);
}

// === Command Processing ===

function onBeforeCommand(commands, context, settings) {
  syncHomeOffset(settings);
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
  //   3. (DONGLE_WAIT:autodustboot:pos=<target>:…) — host holds the stream
  //      until the boot reports the target (instant if already there). Older
  //      hosts without supportsWait get G4 P1.5 — a fixed dwell — instead.
  // Without the G4 P0 barrier, the sentinel would fire mid-cut because
  // grblHAL ok's queued lines the moment they enter the planner buffer,
  // not when they physically execute.
  function emitWirelessDongleSequence(targetPos) {
    var meta = showAddedGCode ? {} : { silent: true };
    var syncBarrier = { command: 'G4 P0', displayCommand: null, meta: meta };
    var sentinel    = { command: '(DONGLE:' + ADB_DEVICE_NAME + ':goto:' + targetPos + ')',
                        displayCommand: null, meta: meta };
    // The wait must be its own command: the host matches the whole line.
    var settle      = hostSupportsWait()
      ? { command: waitCommand(targetPos), displayCommand: null, meta: meta }
      : createCommandSequence(dwellCommand());
    return [syncBarrier, sentinel, settle];
  }
  function emitRetract() {
    if (settings.mode === 'wireless') {
      return emitWirelessDongleSequence(0);
    }
    if (!retractCommand) return [];
    var s = syncedSequence(retractCommand);
    return [s[0], s[1]];
  }
  function emitExpand(gtext) {
    if (settings.mode === 'wireless') {
      var savedPos = readSavedExpandPosition();
      if (savedPos === null) return [];   // no saved target — skip rather than guess
      // Landing in a safe zone: go to the safe height, not all the way down.
      return emitWirelessDongleSequence(gtext ? expandTargetFor(gtext, settings, savedPos) : savedPos);
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
      disarmFollow();
      return commands;
    }
    if (startsWithMarker(mtext, EXPAND_MARKER)) {
      var eEmit = emitExpand();
      if (eEmit.length > 0) commands.splice.apply(commands, [mi, 1].concat(eEmit));
      else commands.splice(mi, 1);
      awaitingExpand = false;
      armFollow();
      return commands;
    }
    if (/^\$ADB_GOTO/i.test(mtext)) {
      var gm = mtext.match(GOTO_MARKER_RE);
      var why = null;
      if (settings.mode !== 'wireless') why = 'needs the wireless dust boot';
      else if (!gm) why = 'usage: $ADB_GOTO <mm below the retracted position>';
      if (why) {
        // Nothing to move: leave a visible note instead of sending a bad line.
        commands.splice(mi, 1, { command: '(' + mtext.replace(/[()]/g, '') + ' - ' + why + ')',
          displayCommand: mtext + '  (' + why + ')', isOriginal: false, meta: {} });
        return commands;
      }
      var mm = Math.min(Math.max(parseFloat(gm[1]), 0), settings.maxTravelMm);
      commands.splice.apply(commands, [mi, 1].concat(
        emitWirelessDongleSequence(Math.round(mm * ADB_COUNTS_PER_MM))));
      // An explicit height overrides the automation until its next retract.
      awaitingExpand = false;
      disarmFollow();
      return commands;
    }
  }

  // === Laser mode: stand down ===
  // With the laser doing the cutting there is no chip stream and the boot
  // would only get in the way of the beam — so no job-start retract, no
  // M6 retract, no expand on the first G0 XY, no retract-on-home or
  // retract-on-rapid. Manual $ADB_ markers above still work because the
  // operator asked for them explicitly. Keep the job-running edge tracked
  // so a spindle job started later still sees a clean false→true.
  laserModeActive = !!(context && context.laserMode === true);
  if (laserModeActive) {
    if (typeof context.jobRunning === 'boolean') wasJobRunning = context.jobRunning;
    return commands;
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
  var retractedHere = false;
  if (jobRunningNow && !wasJobRunning) {
    zoneReset();
    prepareZones(settings);
  }
  if (jobRunningNow && !wasJobRunning && !awaitingExpand) {
    var jobStartRetract = emitRetract();
    if (jobStartRetract.length > 0) {
      commands.splice.apply(commands, [0, 0].concat(jobStartRetract));
      awaitingExpand = true;
      disarmFollow();
      retractedHere = true;
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
  // Every tool change retracts, whatever the arm says: the arm can be stale
  // (a job aborted without a job-end, the boot expanded by hand from the
  // Outputs button), and a boot left down at the first M6 hits the rack.
  // A retract is harmless when the boot is already up (wireless: the wait
  // returns at once). Only skipped when this same batch just retracted.
  if (toolChangeIndex !== -1 && !retractedHere) {
    var m6Retract = emitRetract();
    if (m6Retract.length > 0) {
      commands.splice.apply(commands, [toolChangeIndex, 0].concat(m6Retract));
      if (jobRunningNow) awaitingExpand = true;
      disarmFollow();
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
      var xyExpand = emitExpand(gtext);
      if (xyExpand.length > 0) {
        commands.splice.apply(commands, [gi + 1, 0].concat(xyExpand));
        awaitingExpand = false;
        armFollow();
      }
      break;
    }
  }

  // === Plunge follow ===
  // Runs before the home / rapid handlers below, which return early.
  if (settings.mode === 'wireless' && settings.plungeFollowIntervalMm > 0) {
    if (jobRunningNow) {
      trackPlungeFollow(commands, context, settings);
    } else {
      trackedZKnown = false;
    }
  }

  // Handle $H home command (fires for both wired and wireless — wireless
  // mode used to short-circuit here, which broke Retract-on-Home whenever
  // the operator ran a manual $H outside a job).
  var homeIndex = commands.findIndex(function(cmd) {
    return cmd.isOriginal && cmd.command.trim().toUpperCase().startsWith('$H');
  });

  if (homeIndex !== -1 && retractOnHome) {
    var homeRetract = emitRetract();
    if (homeRetract.length > 0) {
      commands.splice.apply(commands, [homeIndex, 0].concat(homeRetract));
      disarmFollow();
    }
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
      var g0Retract = emitRetract();
      if (g0Retract.length > 0) {
        commands.splice.apply(commands, [g0Index, 0].concat(g0Retract));
        disarmFollow();
      }
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
    // Laser job: the boot was never deployed, leave it alone.
    if (settings && settings.mode === 'wireless' && !laserModeActive) {
      wirelessSend('goto:0');
    }
    // Wired install: the job's own postscript (M9 or the configured
    // Program-End event g-code) typically triggers the physical retract
    // because the ADB signal pin is wired to Flood. Plugin doesn't have
    // a way to inject a command outside a job without a new host hook.
  } catch (_) { /* swallow — never block job-end teardown */ }

  zoneReset();
  isToolChanging = false;
  awaitingExpand = false;
  wasJobRunning = false;
  laserModeActive = false;
  resetFollowState();
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

export { onBeforeCommand, buildInitialConfig, onAfterJobEnd, injectDustBootMarkers, onGcodeProgramLoad,
  parseProgramPaths, segmentEntry, secondsToZone, decideZone, activeRects, insideAny, sanitizeZones, zoneTick, zone };
