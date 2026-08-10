// AutoDustBoot plugin tests. Run with:  node --test commands.test.js
//
// The plugin no longer injects markers at file-load time. Retract/expand
// is fully driven at runtime by:
//   1. context.jobRunning false→true (job start / start-from-line preamble)
//   2. M6 detection in ANY context
//   3. First G0-with-XY on an isOriginal command consumes the arm
// $ADB_RETRACT / $ADB_EXPAND markers are still supported for manual
// terminal use (wired + wireless), and they update the awaitingExpand
// flag so automation stays coherent with operator actions.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub the host-injected pluginContext BEFORE loading the plugin module —
// wireless emit paths read pluginContext.dongle.getDevices() to find the
// saved expand position, and skip emission when no device is known.
// - Track wirelessSend payloads for tests that verify direct ESP-NOW
//   sends (e.g. onAfterJobEnd wireless retract).
// - Advertise an autodustboot device with expand=1000 so emitExpand has
//   a target to `goto:` against.
globalThis.__adbSentPayloads = [];
globalThis.pluginContext = {
  dongle: {
    send: (name, payload) => { globalThis.__adbSentPayloads.push({ name, payload }); },
    getDevices: () => [{
      name: 'autodustboot',
      connected: true,
      lastSeenMs: 100,
      lastMessage: 'status pos=0 expand=1000 state=home homed=1',
    }],
  },
};

const {
  onBeforeCommand,
  buildInitialConfig,
  onAfterJobEnd,
  injectDustBootMarkers,
} = await import('./commands.js');

const WIRED = buildInitialConfig({
  mode: 'wired',
  retractCommand: 'M8\nG4 P0.1\nM9\nG4 P1',
  expandCommand: 'M8',
});

const WIRELESS = buildInitialConfig({ mode: 'wireless' });

// One command entry per raw line, isOriginal=true — mirrors what the host
// hands the plugin for job / preamble / client input.
function wrap(...lines) {
  return lines.map(l => ({ command: l, isOriginal: true }));
}
// Same but marks lines as plugin-expanded (e.g. tool-change routine moves
// from pneumaticatc). These must NOT trigger expand-on-G0-XY.
function wrapExpanded(...lines) {
  return lines.map(l => ({ command: l, isOriginal: false }));
}

function ctx(o) { return Object.assign({ jobRunning: false, sourceId: null }, o); }

// Every test starts from a clean state.
beforeEach(() => onAfterJobEnd());

describe('job start (context.jobRunning transition false→true)', () => {
  test('preamble start injects retract at head of batch and arms expand', () => {
    const batch = wrap('G21');
    onBeforeCommand(batch, ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    // Retract sequence (M8...M9...G4 P1) must appear BEFORE G21.
    const combined = batch.map(c => c.command).join('\n');
    const rIdx = combined.indexOf('M8\nG4 P0.1\nM9\nG4 P1');
    const g21Idx = combined.indexOf('G21');
    assert.ok(rIdx !== -1 && g21Idx !== -1 && rIdx < g21Idx,
      `retract must precede G21, got:\n${combined}`);
  });

  test('first G0 XY of preamble consumes the arm — expand injected AFTER it', () => {
    onBeforeCommand(wrap('G21'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    // Modal restore commands — no G0 XY, flag stays armed.
    onBeforeCommand(wrap('G17'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    onBeforeCommand(wrap('G54'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    // Return-to-XY — flag consumed.
    const g0 = wrap('G0 X117.909 Y100.431');
    onBeforeCommand(g0, ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    const g0Idx = g0.findIndex(c => /^G0\b/.test(c.command));
    assert.ok(g0Idx !== -1, 'G0 XY must survive');
    const after = g0.slice(g0Idx + 1).map(c => c.command).join('\n');
    assert.ok(after.includes('M8'), `expand should follow G0 XY, got after-G0:\n${after}`);
  });

  test('subsequent G0 XY does NOT re-expand — arm cleared', () => {
    onBeforeCommand(wrap('G21'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    const first = wrap('G0 X10 Y20');
    onBeforeCommand(first, ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    assert.ok(first.length > 1, 'first G0 XY should trigger expand');
    const second = wrap('N100 G0 X30 Y40');
    onBeforeCommand(second, ctx({ jobRunning: true }), WIRED);
    assert.equal(second.length, 1,
      `no re-expand after arm consumed, got ${JSON.stringify(second.map(c => c.command))}`);
  });

  test('jobRunning transition fires exactly ONCE per job — subsequent batches do not re-retract', () => {
    onBeforeCommand(wrap('G21'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    // First G0 XY consumes the arm.
    onBeforeCommand(wrap('G0 X10 Y20'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    // Another modal line while jobRunning stays true — no new retract.
    const modal = wrap('F7000');
    onBeforeCommand(modal, ctx({ jobRunning: true }), WIRED);
    assert.equal(modal.length, 1,
      `mid-job non-M6 modal should not fire retract, got ${JSON.stringify(modal.map(c => c.command))}`);
  });
});

describe('M6 detection (any context)', () => {
  test('preamble M6 injects retract BEFORE it and arms expand', () => {
    // Job-start transition already fired retract, so a preamble M6 in the
    // SAME session should not double-retract — arm is still true.
    onBeforeCommand(wrap('G21'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    const m6 = wrap('M6 T2');
    onBeforeCommand(m6, ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    // Only ONE retract in total should be visible across the two batches —
    // the first at job start; the second (M6) should NOT re-inject.
    assert.equal(m6.length, 1, `M6 should not double-retract, got ${JSON.stringify(m6.map(c => c.command))}`);
  });

  test('mid-job M6 (after expand consumed) fires retract again', () => {
    // Full cycle: preamble start, first G0 XY, then a later M6.
    onBeforeCommand(wrap('G21'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    onBeforeCommand(wrap('G0 X10 Y20'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    // Now boot is extended; next M6 needs to retract before tool change.
    const m6 = wrap('N250 M6 T3');
    onBeforeCommand(m6, ctx({ jobRunning: true }), WIRED);
    const combined = m6.map(c => c.command).join('\n');
    const rIdx = combined.indexOf('M8\nG4 P0.1\nM9\nG4 P1');
    const m6Idx = combined.indexOf('M6 T3');
    assert.ok(rIdx !== -1 && m6Idx !== -1 && rIdx < m6Idx,
      `M6 should re-inject retract after boot is extended, got:\n${combined}`);
    // And expand should fire on the NEXT job-line G0 XY.
    const g0 = wrap('N251 G0 X50 Y60');
    onBeforeCommand(g0, ctx({ jobRunning: true }), WIRED);
    assert.ok(g0.length > 1, 'expand should re-arm on M6 and fire on next G0 XY');
  });

  test('manual M6 (jobRunning=false, client context) still fires retract + arms expand', () => {
    const m6 = wrap('M6 T2');
    onBeforeCommand(m6, ctx({ sourceId: 'client' }), WIRED);
    const combined = m6.map(c => c.command).join('\n');
    assert.ok(combined.indexOf('M8\nG4 P0.1\nM9\nG4 P1') !== -1, 'retract should fire');
    // Follow-up G0 XY fires expand.
    const g0 = wrap('G0 X10 Y20');
    onBeforeCommand(g0, ctx({ sourceId: 'client' }), WIRED);
    assert.ok(g0.length > 1, 'expand should fire on next G0 XY');
  });
});

describe('plugin-expanded tool-change routines (pneumaticatc rack moves)', () => {
  test('isOriginal=false G0 XY does NOT consume the arm — expand waits for real job line', () => {
    // Simulate: M6 arms expand, then a batch of tool-change routine G0 XY
    // moves (all isOriginal=false) comes through. Expand must NOT fire on
    // the rack move — it must wait for the next isOriginal=true G0 XY.
    onBeforeCommand(wrap('N250 M6 T3'), ctx({ jobRunning: true }), WIRED);
    // Tool-change routine — rack, cup, TLS, etc — all plugin-emitted.
    const rackBatch = wrapExpanded('G53 G0 X63.8 Y-863.231', 'G53 G0 X3.8 Y-863.231');
    onBeforeCommand(rackBatch, ctx({ jobRunning: true }), WIRED);
    assert.equal(rackBatch.length, 2,
      `tool-change routine must not trigger expand, got ${JSON.stringify(rackBatch.map(c => c.command))}`);
    // Real job line arrives — NOW expand fires.
    const jobLine = wrap('N251 G0 X50 Y60');
    onBeforeCommand(jobLine, ctx({ jobRunning: true }), WIRED);
    assert.ok(jobLine.length > 1, 'expand should fire on the real job line, not the rack move');
  });
});

describe('marker interception (manual $ADB_RETRACT / $ADB_EXPAND)', () => {
  test('wired: $ADB_RETRACT substitutes retract + sets awaitingExpand', () => {
    const b = wrap('$ADB_RETRACT (Added by AutoDustBoot Plugin)');
    onBeforeCommand(b, ctx({ sourceId: 'client' }), WIRED);
    const combined = b.map(c => c.command).join('\n');
    assert.ok(combined.indexOf('M8\nG4 P0.1\nM9\nG4 P1') !== -1,
      `marker should substitute to configured retract, got:\n${combined}`);
    // Because marker set awaitingExpand=true, next G0 XY fires expand.
    const g0 = wrap('G0 X10 Y20');
    onBeforeCommand(g0, ctx({ sourceId: 'client' }), WIRED);
    assert.ok(g0.length > 1, 'marker should have armed expand');
  });

  test('wired: $ADB_EXPAND substitutes expand + clears awaitingExpand', () => {
    onBeforeCommand(wrap('N100 M6 T2'), ctx({ jobRunning: true }), WIRED);
    // Manual expand marker fires expand explicitly.
    const b = wrap('$ADB_EXPAND (Added by AutoDustBoot Plugin)');
    onBeforeCommand(b, ctx({ jobRunning: true }), WIRED);
    assert.ok(b.some(c => c.command.includes('M8')), 'expand M-code should substitute');
    // Flag now cleared — a subsequent job-context G0 XY doesn't double-expand.
    // (Use N-prefix job context, not sourceId=client, to avoid the legacy
    // retractOnRapidMove path which injects retract before client G0 rapids.)
    const g0 = wrap('N101 G0 X10 Y20');
    onBeforeCommand(g0, ctx({ jobRunning: true }), WIRED);
    assert.equal(g0.length, 1, 'marker cleared arm, no double-expand');
  });

  test('wireless: $ADB_RETRACT emits sync + DONGLE sentinel + dwell (no wired M-codes)', () => {
    const b = wrap('$ADB_RETRACT (Added by AutoDustBoot Plugin)');
    onBeforeCommand(b, ctx({ sourceId: 'client' }), WIRELESS);
    // Wireless path emits: G4 P0 sync barrier + (DONGLE:...) sentinel + G4 dwell.
    const combined = b.map(c => c.command).join('\n');
    assert.ok(combined.includes('G4 P0'), `wireless retract should emit G4 P0 sync barrier, got:\n${combined}`);
    assert.ok(combined.includes('(DONGLE:autodustboot:goto:0)'),
      `wireless retract should emit DONGLE sentinel with goto:0, got:\n${combined}`);
    assert.ok(combined.includes('G4 P1'), `wireless retract should emit G4 dwell, got:\n${combined}`);
    assert.ok(!combined.includes('M8'), 'wireless mode must NOT emit wired M-codes');
  });
});

describe('wireless mode: DONGLE-sentinel sequence keeps ESP-NOW synced to physical execution', () => {
  test('job start in wireless: sync barrier + sentinel + dwell, no wired M-codes', () => {
    const batch = wrap('G21');
    onBeforeCommand(batch, ctx({ jobRunning: true, sourceId: 'resume' }), WIRELESS);
    const combined = batch.map(c => c.command).join('\n');
    assert.ok(combined.includes('G4 P0'), `wireless job-start retract must emit sync barrier, got:\n${combined}`);
    assert.ok(combined.includes('(DONGLE:autodustboot:goto:0)'),
      `wireless job-start retract must emit DONGLE sentinel, got:\n${combined}`);
    assert.ok(combined.includes('G4 P1'), `wireless job-start retract must emit dwell, got:\n${combined}`);
    assert.ok(!combined.match(/\bM8\b|\bM9\b/), 'wireless must NOT emit wired M-codes');
  });

  test('wireless: first G0 XY fires expand as sync + DONGLE goto:<saved> + dwell', () => {
    onBeforeCommand(wrap('G21'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRELESS);
    const g0 = wrap('G0 X10 Y20');
    onBeforeCommand(g0, ctx({ jobRunning: true, sourceId: 'resume' }), WIRELESS);
    const combined = g0.map(c => c.command).join('\n');
    // Stub advertises expand=1000, so expand payload is `goto:1000`.
    assert.ok(combined.includes('G4 P0'), 'wireless expand must emit sync barrier');
    assert.ok(combined.includes('(DONGLE:autodustboot:goto:1000)'),
      `wireless expand must emit DONGLE sentinel with saved position, got:\n${combined}`);
    assert.ok(combined.includes('G4 P1'), 'wireless expand must emit dwell');
    assert.ok(!combined.match(/\bM8\b|\bM9\b/), 'wireless must NOT emit wired M-codes');
  });
});

describe('onAfterJobEnd — wireless retract on job completion', () => {
  test('wireless mode: fires goto:0 ESP-NOW directly (CNC is idle, no sync needed)', () => {
    globalThis.__adbSentPayloads.length = 0;
    onAfterJobEnd(WIRELESS);
    const goto0 = globalThis.__adbSentPayloads.filter(p => p.name === 'autodustboot' && p.payload === 'goto:0');
    assert.equal(goto0.length, 1,
      `expected exactly one goto:0 send on job end, got ${JSON.stringify(globalThis.__adbSentPayloads)}`);
  });

  test('wired mode: does NOT fire ESP-NOW (relies on job postscript / Program-End event)', () => {
    globalThis.__adbSentPayloads.length = 0;
    onAfterJobEnd(WIRED);
    assert.equal(globalThis.__adbSentPayloads.length, 0,
      `wired job end must not fire ESP-NOW, got ${JSON.stringify(globalThis.__adbSentPayloads)}`);
  });
});

describe('fallback for old hosts (no context.jobRunning)', () => {
  test('sourceId=resume infers job-active — retract fires on first preamble line', () => {
    const batch = wrap('G21');
    // context.jobRunning omitted entirely — simulating an older host that
    // hasn't yet been rebuilt with the jobRunning context field.
    onBeforeCommand(batch, { sourceId: 'resume' }, WIRED);
    const combined = batch.map(c => c.command).join('\n');
    assert.ok(combined.includes('M8\nG4 P0.1\nM9\nG4 P1'),
      `preamble should still trigger job-start retract on old host, got:\n${combined}`);
  });

  test('N-prefixed job line infers job-active — retract fires', () => {
    const batch = wrap('N100 G0 X10 Y20');
    onBeforeCommand(batch, {}, WIRED);
    const combined = batch.map(c => c.command).join('\n');
    assert.ok(combined.includes('M8\nG4 P0.1\nM9\nG4 P1'),
      `N-prefixed first line should trigger job-start retract on old host, got:\n${combined}`);
    // And expand should fire on that same batch's G0 XY.
    assert.ok(batch.some((c, i) => /^N100 G0/.test(c.command) && i < batch.length - 1),
      'G0 XY should have expand appended after it');
  });
});

describe('onAfterJobEnd resets all state', () => {
  test('flags cleared — a new job re-fires retract from job-start transition', () => {
    onBeforeCommand(wrap('G21'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    onBeforeCommand(wrap('G0 X10 Y20'), ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    onAfterJobEnd();
    // Simulate a fresh job start — retract should fire again.
    const fresh = wrap('G21');
    onBeforeCommand(fresh, ctx({ jobRunning: true, sourceId: 'resume' }), WIRED);
    const combined = fresh.map(c => c.command).join('\n');
    assert.ok(combined.indexOf('M8\nG4 P0.1\nM9\nG4 P1') !== -1,
      `after onAfterJobEnd, next job start must re-fire retract, got:\n${combined}`);
  });
});

describe('injectDustBootMarkers (still exported for backward compat)', () => {
  test('injects RETRACT before M6 and EXPAND after first G0 XY', () => {
    const out = injectDustBootMarkers(['G21 G90', 'M6 T1', 'G0 X10 Y20', 'G1 Z-1'].join('\n'));
    const lines = out.split('\n');
    const rIdx = lines.findIndex(l => l.includes('$ADB_RETRACT'));
    const eIdx = lines.findIndex(l => l.includes('$ADB_EXPAND'));
    assert.ok(rIdx !== -1 && eIdx !== -1, `both markers should exist:\n${out}`);
  });
});
