/**
 * AutoDustBoot - Command Processor
 * Pure command processing logic for automatic dust boot retract/expand.
 * Runs on Node.js natively OR on .NET via Jint.
 * No import/require/fetch/ctx — pure input→output.
 */

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

// === Module-level state (persists in Jint engine between calls) ===

let isToolChanging = false;

// === Settings Sanitization ===

const buildInitialConfig = function(raw) {
  if (!raw) raw = {};
  return {
    retractCommand: raw.retractCommand || 'M8\nG4 P0.1\nM9',
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

  var hasExpandRetract = expandCommand && retractCommand;
  if (!hasExpandRetract) {
    return commands;
  }

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
      if (context.sourceId === 'job') {
        isToolChanging = true;
      }
      var sequence = createCommandSequence(retractCommand);
      commands.splice(toolChangeIndex, 0, sequence);
      return commands;
    } else {
      // M6 command
      var parsed = parseM6Command(commandText);
      var toolNumber = parsed !== null ? parsed.toolNumber : null;

      if (toolNumber !== null && Number.isFinite(toolNumber)) {
        if (context.sourceId === 'job') {
          isToolChanging = true;
        }
        var seq = createCommandSequence(retractCommand);
        commands.splice(toolChangeIndex, 0, seq);
        return commands;
      }
    }
  }

  // Handle job post-tool-change expansion
  if (isToolChanging && context.sourceId === 'job') {
    var normalizedExpandCmd = expandCommand.toUpperCase().replace(/([GM])0+(\d)/g, '$1$2');

    for (var i = 0; i < commands.length; i++) {
      var cmd = commands[i];
      var normalizedLine = cmd.command.toUpperCase().replace(/([GM])0+(\d)/g, '$1$2');

      // Check if line contains the expand command (handle line numbers like N123 M8)
      var expandPattern = new RegExp('^(?:N\\d+\\s*)?' + normalizedExpandCmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (expandPattern.test(normalizedLine)) {
        cmd.command = '(' + cmd.command.trim() + ', Moved by AutoDustBoot Plugin)';
        cmd.displayCommand = null;
        continue;
      }

      // Check for first XY movement
      var hasXMovement = /[^A-Z]X[-+]?\d+\.?\d*/i.test(cmd.command);
      var hasYMovement = /[^A-Z]Y[-+]?\d+\.?\d*/i.test(cmd.command);

      if (cmd.isOriginal && (hasXMovement || hasYMovement)) {
        isToolChanging = false;

        // Insert expand command after this XY movement
        var expandSequence = {
          command: expandCommand,
          displayCommand: null,
          meta: showAddedGCode ? {} : { silent: true }
        };
        commands.splice(i + 1, 0, expandSequence);
        return commands;
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

export { onBeforeCommand, buildInitialConfig, onAfterJobEnd };
