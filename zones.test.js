// Safe zones tests. Run with:  node --test zones.test.js
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A fake host: the boot, the machine and the loaded program.
const host = {
  sent: [],
  commands: [],
  boot: 'status pos=40000 expand=40000 state=idle homed=1',
  state: null,
  program: null,
};
globalThis.pluginContext = {
  dongle: {
    send: (name, payload) => host.sent.push(payload),
    getDevices: () => [{ name: 'autodustboot', connected: true, lastSeenMs: 1, lastMessage: host.boot }],
  },
  getServerState: () => host.state,
  getProgram: () => host.program,
  getFirmwareSetting: () => 0,
  sendCommand: (cmd) => host.commands.push(cmd),
};

const {
  buildInitialConfig, onBeforeCommand, onAfterJobEnd,
  parseProgramPaths, segmentEntry, secondsToZone, decideZone, activeRects, sanitizeZones, zoneTick, zone,
} = await import('./commands.js');

// Right rail at X 280–300 (machine), the whole Y range.
const RAIL = { name: 'Right rail', x1: 280, x2: 300, y1: 0, y2: 500 };
const settings = () => buildInitialConfig({
  mode: 'wireless', zonesEnabled: true, zones: [RAIL],
  safeLiftMm: 20, zoneClearanceMm: 5, liftEarlySec: 0.3, stayUpBetween: true, pauseIfLate: true,
});

describe('geometry', () => {
  const r = { x1: 10, x2: 20, y1: 10, y2: 20 };
  test('a segment through the rect enters at its edge', () => {
    assert.equal(segmentEntry(0, 15, 30, 15, r), 10 / 30);
  });
  test('a segment that misses returns -1', () => {
    assert.equal(segmentEntry(0, 0, 30, 0, r), -1);
  });
  test('a segment starting inside enters at 0', () => {
    assert.equal(segmentEntry(15, 15, 40, 15, r), 0);
  });
  test('zones grow by the clearance, disabled ones drop out', () => {
    const rects = activeRects({ zoneClearanceMm: 5, zones: [RAIL, { ...RAIL, enabled: false }] });
    assert.equal(rects.length, 1);
    assert.deepEqual([rects[0].x1, rects[0].x2], [275, 305]);
  });
  test('zones are sorted, capped at 3, and need four numbers', () => {
    const z = sanitizeZones([{ x1: 5, x2: 1, y1: 9, y2: 2 }, { x1: 'a' }, ...Array(12).fill(RAIL)]);
    assert.equal(z.length, 3);
    assert.deepEqual([z[0].x1, z[0].x2, z[0].y1, z[0].y2], [1, 5, 2, 9]);
  });
});

describe('program paths', () => {
  test('absolute, relative and inch moves', () => {
    const p = parseProgramPaths('G21 G90\nG0 X10 Y0\nG1 X20\nG91 G1 Y5\nG90 G20 G1 X1');
    assert.equal(p[0], null);
    assert.equal(p[1], null);                       // start unknown
    assert.deepEqual(p[2].pts, [10, 0, 20, 0]);
    assert.deepEqual(p[3].pts, [20, 0, 20, 5]);
    assert.deepEqual(p[4].pts, [20, 5, 25.4, 5]);
  });
  test('arcs become points around the curve', () => {
    const p = parseProgramPaths('G0 X0 Y0\nG2 X20 Y0 I10 J0');
    const pts = p[1].pts;
    assert.ok(pts.length > 8);
    const ys = pts.filter((_, i) => i % 2 === 1);
    assert.ok(Math.max(...ys) > 9.9);               // clockwise from the left goes over the top
  });
  test('G53 lines are machine coordinates; G28 loses the position', () => {
    const p = parseProgramPaths('G0 X0 Y0\nG53 G0 X100 Y100\nG1 X5\nG0 X0 Y0\nG28\nG1 X5');
    assert.equal(p[1].mc, true);
    assert.equal(p[2], null);
    assert.equal(p[5], null);
  });
});

describe('timing', () => {
  // Work zero at machine X 0: a pass from X 0 to X 300 at 20 mm/s (15 s).
  const paths = parseProgramPaths('G0 X0 Y100\nG1 X300 F1200\nG1 Y110\nG1 X0');
  const lineSec = [0, 15, 0.5, 15];
  const rects = activeRects({ zoneClearanceMm: 5, zones: [RAIL] });
  const rates = { feed: 1, rapid: 1 };
  const wco = { x: 0, y: 0 };

  test('time to the zone on the line being cut', () => {
    // At X 200: 75 mm to the clearance edge at 275 → 3.75 s × 0.85 safety.
    const t = secondsToZone(paths, lineSec, 2, { x: 200, y: 100 }, wco, rects, rates);
    assert.ok(Math.abs(t - 3.75 * 0.85) < 0.01, String(t));
  });
  test('feed override shortens it', () => {
    const t = secondsToZone(paths, lineSec, 2, { x: 200, y: 100 }, wco, rects, { feed: 2, rapid: 1 });
    assert.ok(Math.abs(t - 3.75 * 0.85 / 2) < 0.01, String(t));
  });
  test('inside the zone is 0', () => {
    assert.equal(secondsToZone(paths, lineSec, 2, { x: 290, y: 100 }, wco, rects, rates), 0);
  });
  test('the work offset moves the toolpath', () => {
    // Work zero at machine X 100: the zone edge is 25 mm from the spindle.
    const t = secondsToZone(paths, lineSec, 2, { x: 250, y: 100 }, { x: 100, y: 0 }, rects, rates);
    assert.ok(Math.abs(t - 1.25 * 0.85) < 0.01, String(t));
  });
  test('looking past the current line', () => {
    // Line 4 runs back to X 0 → the zone is behind: never.
    assert.equal(secondsToZone(paths, lineSec, 4, { x: 270, y: 110 }, wco, rects, rates), Infinity);
  });
});

describe('decisions', () => {
  const s = settings();
  // Lift needs 0.15 + 20/60 + 0.3 + 0.25 ≈ 1.03 s.
  test('lift when the zone is within the lift time', () => {
    assert.equal(decideZone('down', 1.0, false, s, 5), 'up');
    assert.equal(decideZone('down', 1.2, false, s, 5), null);
  });
  test('stay up inside, and between quick passes', () => {
    assert.equal(decideZone('up', 0, true, s, 5), null);
    assert.equal(decideZone('up', 3, false, s, 5), null);
    assert.equal(decideZone('up', 4, false, s, 5), 'down');
  });
  test('without stay-up it drops sooner', () => {
    const t = { ...s, stayUpBetween: false };
    assert.equal(decideZone('up', 2, false, t, 5), 'down');
  });
  test('no drop right after a lift', () => {
    assert.equal(decideZone('up', Infinity, false, s, 0.1), null);
  });
});

describe('runtime', () => {
  const PROGRAM = 'G0 X0 Y100\nG1 X300 F1200\nG1 Y110\nG1 X0';
  const SAFE = 40000 - Math.round(20 * 505.7);

  beforeEach(() => {
    onAfterJobEnd(null);
    host.sent = [];
    host.commands = [];
    host.boot = 'status pos=40000 expand=40000 state=idle homed=1';
    host.program = { text: PROGRAM, lineSec: [0, 15, 0.5, 15], stamp: '1' };
    host.state = {
      jobStatus: 'running', machineStatus: 'Run', line: 2,
      mpos: { x: 100, y: 100, z: 0 }, wco: { x: 0, y: 0, z: 0 },
      feedOverride: 100, rapidOverride: 100,
    };
    // A running job, boot expanded by the stream.
    onBeforeCommand([{ command: 'N1 G0 X0 Y100', isOriginal: true }], { jobRunning: true }, settings());
  });

  const at = (x) => { host.state.mpos.x = x; zoneTick(); };

  test('lifts ahead of the zone and drops after it', () => {
    at(100);
    assert.deepEqual(host.sent.filter(p => p.startsWith('goto')), []);
    at(260);                                         // 15 mm × 0.85 / 20 mm/s ≈ 0.64 s away
    assert.ok(host.sent.includes('goto:' + SAFE), host.sent.join());
    host.boot = `status pos=${SAFE} expand=40000 state=idle`;
    host.state.line = 4; host.state.mpos.y = 110;
    zone.changedAt = 0;                              // as if the lift was a while ago
    at(200);                                         // heading away, out of the zone
    assert.equal(host.sent.at(-1), 'goto:40000');
  });

  test('holds the feed when the boot is late, resumes when it is up', () => {
    at(274);                                         // 1 mm from the clearance edge
    assert.ok(host.sent.includes('goto:' + SAFE));
    assert.deepEqual(host.commands, ['!']);
    host.state.jobStatus = 'paused';                 // the hold pauses the job
    host.state.machineStatus = 'Hold';
    zoneTick();
    assert.deepEqual(host.commands, ['!']);          // still waiting on the boot
    host.boot = `status pos=${SAFE} expand=40000 state=idle`;
    zoneTick();
    assert.deepEqual(host.commands, ['!', '~']);
  });

  test('an operator pause is left alone', () => {
    host.state.jobStatus = 'paused';
    at(274);
    assert.deepEqual(host.sent.filter(p => p.startsWith('goto')), []);
    assert.deepEqual(host.commands, []);
  });

  test('stands down while the boot is retracted for a tool change', () => {
    onBeforeCommand([{ command: 'N9 M6 T2', isOriginal: true }], { jobRunning: true }, settings());
    host.sent = [];
    at(270);
    assert.deepEqual(host.sent.filter(p => p.startsWith('goto')), []);
  });

  test('an expand that lands in a zone goes to safe height', () => {
    onBeforeCommand([{ command: 'N9 M6 T2', isOriginal: true }], { jobRunning: true }, settings());
    const out = onBeforeCommand([{ command: 'N10 G0 X290 Y100', isOriginal: true }], { jobRunning: true }, settings());
    assert.ok(out.some(c => c.command === `(DONGLE:autodustboot:goto:${SAFE})`), out.map(c => c.command).join(' | '));
  });

  test('the safe height can be a boot position (mm below retracted)', () => {
    buildInitialConfig({ mode: 'wireless', zonesEnabled: true, zones: [RAIL], safePosMm: 50 });
    at(260);
    assert.ok(host.sent.includes('goto:' + Math.round(50 * 505.7)), host.sent.join());
    buildInitialConfig({ mode: 'wireless', zonesEnabled: true, zones: [RAIL], safeLiftMm: 20 });
  });

  test('nothing happens with zones off', () => {
    buildInitialConfig({ mode: 'wireless', zonesEnabled: false, zones: [RAIL] });
    at(274);
    assert.deepEqual(host.sent.filter(p => p.startsWith('goto')), []);
    buildInitialConfig({ mode: 'wireless', zonesEnabled: true, zones: [RAIL], safeLiftMm: 20 });
  });
});
