let isToolChanging = false;

export function onLoad(ctx) {
  ctx.log('AutoDustBoot plugin loaded');

  ctx.registerToolMenu('AutoDustBoot', async () => {
    ctx.log('AutoDustBoot settings opened');

    ctx.showDialog(
      'AutoDustBoot Settings',
      /* html */ `
      <style>
        .adb-dialog {
          padding: 20px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: var(--color-text-primary, #333);
          max-width: 600px;
        }
        .adb-form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 20px;
        }
        .adb-form-group {
          display: flex;
          flex-direction: column;
        }
        .adb-form-group > label {
          margin-bottom: 8px;
          font-weight: 600;
          color: var(--color-text-primary, #333);
        }
        .adb-toggle-switch {
          position: relative;
          width: 50px;
          height: 28px;
          margin-top: 8px;
        }
        .adb-toggle-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .adb-toggle-slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: #ccc;
          transition: .4s;
          border-radius: 28px;
        }
        .adb-toggle-slider:before {
          position: absolute;
          content: "";
          height: 20px;
          width: 20px;
          left: 4px;
          bottom: 4px;
          background-color: white;
          transition: .4s;
          border-radius: 50%;
        }
        .adb-toggle-switch input:checked + .adb-toggle-slider {
          background-color: var(--color-accent, #4a90e2);
        }
        .adb-toggle-switch input:checked + .adb-toggle-slider:before {
          transform: translateX(22px);
        }
        .adb-help-text {
          font-size: 0.85rem;
          color: var(--color-text-secondary, #666);
          margin-top: 6px;
          line-height: 1.4;
        }
        .adb-monaco-container {
          height: 80px;
          border: 1px solid var(--color-border, #ddd);
          border-radius: 4px;
          overflow: hidden;
        }
        .adb-button-row {
          display: flex;
          justify-content: center;
          gap: 10px;
          margin-top: 24px;
          padding-top: 16px;
          border-top: 1px solid var(--color-border, #ddd);
        }
        .adb-btn {
          padding: 10px 24px;
          border-radius: 4px;
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.2s, border-color 0.2s;
        }
        .adb-btn-secondary {
          background: var(--color-surface, #fff);
          border: 1px solid var(--color-border, #ddd);
          color: var(--color-text-primary, #333);
        }
        .adb-btn-secondary:hover {
          background: var(--color-surface-muted, #f5f5f5);
        }
        .adb-btn-primary {
          background: var(--color-accent, #4a90e2);
          border: 1px solid var(--color-accent, #4a90e2);
          color: white;
        }
        .adb-btn-primary:hover {
          background: var(--color-accent-hover, #3a7bc8);
        }
      </style>
      <div class="adb-dialog">
        <div class="adb-form-row">
          <div class="adb-form-group">
            <label>Retract Sequence</label>
            <div class="adb-monaco-container" id="adb-retractCommand-editor"></div>
            <p class="adb-help-text">G-code sequence to retract the dust boot</p>
          </div>

          <div class="adb-form-group">
            <label>Expand Sequence</label>
            <div class="adb-monaco-container" id="adb-expandCommand-editor"></div>
            <p class="adb-help-text">G-code sequence to expand the dust boot</p>
          </div>
        </div>

        <div class="adb-form-row">
          <div class="adb-form-group">
            <label>Retract on Home</label>
            <label class="adb-toggle-switch">
              <input type="checkbox" id="adb-retractOnHome" checked>
              <span class="adb-toggle-slider"></span>
            </label>
            <p class="adb-help-text">Automatically retract when homing ($H)</p>
          </div>

          <div class="adb-form-group">
            <label>Retract on Rapid Move (G0)</label>
            <label class="adb-toggle-switch">
              <input type="checkbox" id="adb-retractOnRapidMove" checked>
              <span class="adb-toggle-slider"></span>
            </label>
            <p class="adb-help-text">Retract during rapid moves (except when running jobs)</p>
          </div>
        </div>

        <div class="adb-form-row">
          <div class="adb-form-group">
            <label>Show Added GCode in Terminal</label>
            <label class="adb-toggle-switch">
              <input type="checkbox" id="adb-showAddedGCode">
              <span class="adb-toggle-slider"></span>
            </label>
            <p class="adb-help-text">When disabled, commands are executed silently</p>
          </div>
        </div>

        <div class="adb-button-row">
          <button type="button" class="adb-btn adb-btn-secondary" onclick="window.postMessage({ type: 'close-plugin-dialog' }, '*')">Close</button>
          <button type="button" class="adb-btn adb-btn-primary" id="adb-saveBtn">Save</button>
        </div>
      </div>

      <script>
        (function() {
          const DEFAULT_RETRACT = 'M8\\nG4 P0.1\\nM9';
          const DEFAULT_EXPAND = 'M8';

          let retractEditor = null;
          let expandEditor = null;

          // Register G-code language and theme if not already registered
          function registerGcodeLanguage() {
            if (typeof monaco === 'undefined') return;

            // Check if already registered
            const languages = monaco.languages.getLanguages();
            if (languages.some(lang => lang.id === 'gcode')) return;

            monaco.languages.register({ id: 'gcode' });

            monaco.languages.setMonarchTokensProvider('gcode', {
              tokenizer: {
                root: [
                  [/\\(.*?\\)/, 'comment'],
                  [/;.*$/, 'comment'],
                  [/\\b[Gg]0*(?=\\s|$|[A-Za-z])/, 'gcode-rapid'],
                  [/\\b[Gg][1-3]\\b/, 'gcode-cutting'],
                  [/\\b[Gg]\\d+\\.?\\d*/, 'gcode-g'],
                  [/\\b[Mm]\\d+/, 'gcode-m'],
                  [/\\b[Tt]\\d+/, 'gcode-tool'],
                  [/\\b[Ss]\\d+\\.?\\d*/, 'gcode-spindle'],
                  [/\\b[Ff]\\d+\\.?\\d*/, 'gcode-feed'],
                  [/\\b[Xx]-?\\d+\\.?\\d*/, 'gcode-coord-x'],
                  [/\\b[Yy]-?\\d+\\.?\\d*/, 'gcode-coord-y'],
                  [/\\b[Zz]-?\\d+\\.?\\d*/, 'gcode-coord-z'],
                  [/\\b[AaBbCcIiJjKk]-?\\d+\\.?\\d*/, 'gcode-coord-other'],
                  [/\\b[Nn]\\d+/, 'gcode-line-number'],
                  [/-?\\d+\\.?\\d*/, 'number'],
                ]
              }
            });

            monaco.editor.defineTheme('gcode-dark', {
              base: 'vs-dark',
              inherit: true,
              rules: [
                { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
                { token: 'gcode-rapid', foreground: 'FF8C00', fontStyle: 'bold' },
                { token: 'gcode-cutting', foreground: '569CD6', fontStyle: 'bold' },
                { token: 'gcode-g', foreground: 'C586C0' },
                { token: 'gcode-m', foreground: 'DCDCAA' },
                { token: 'gcode-tool', foreground: '4EC9B0' },
                { token: 'gcode-spindle', foreground: 'CE9178' },
                { token: 'gcode-feed', foreground: 'B5CEA8' },
                { token: 'gcode-coord-x', foreground: 'F14C4C' },
                { token: 'gcode-coord-y', foreground: '4EC9B0' },
                { token: 'gcode-coord-z', foreground: '569CD6' },
                { token: 'gcode-coord-other', foreground: '9CDCFE' },
                { token: 'gcode-line-number', foreground: '858585' },
                { token: 'number', foreground: 'B5CEA8' },
              ],
              colors: {}
            });

            monaco.editor.defineTheme('gcode-light', {
              base: 'vs',
              inherit: true,
              rules: [
                { token: 'comment', foreground: '008000', fontStyle: 'italic' },
                { token: 'gcode-rapid', foreground: 'FF6600', fontStyle: 'bold' },
                { token: 'gcode-cutting', foreground: '0000FF', fontStyle: 'bold' },
                { token: 'gcode-g', foreground: 'AF00DB' },
                { token: 'gcode-m', foreground: '795E26' },
                { token: 'gcode-tool', foreground: '267F99' },
                { token: 'gcode-spindle', foreground: 'A31515' },
                { token: 'gcode-feed', foreground: '098658' },
                { token: 'gcode-coord-x', foreground: 'CD3131' },
                { token: 'gcode-coord-y', foreground: '267F99' },
                { token: 'gcode-coord-z', foreground: '0000FF' },
                { token: 'gcode-coord-other', foreground: '001080' },
                { token: 'gcode-line-number', foreground: '858585' },
                { token: 'number', foreground: '098658' },
              ],
              colors: {}
            });
          }

          registerGcodeLanguage();

          const isLightTheme = () => document.body.classList.contains('theme-light');
          const getMonacoTheme = () => isLightTheme() ? 'gcode-light' : 'gcode-dark';

          const monacoOptions = {
            language: 'gcode',
            theme: getMonacoTheme(),
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontSize: 12,
            tabSize: 2
          };

          async function init() {
            // Load settings
            let settings = {};
            try {
              const response = await fetch('/api/plugins/com.ncsender.autodustboot/settings');
              if (response.ok) {
                settings = await response.json();
              }
            } catch (error) {
              console.error('Failed to load settings:', error);
            }

            // Initialize Monaco editors
            if (typeof monaco !== 'undefined') {
              const retractContainer = document.getElementById('adb-retractCommand-editor');
              if (retractContainer) {
                retractEditor = monaco.editor.create(retractContainer, {
                  ...monacoOptions,
                  value: settings.retractCommand || DEFAULT_RETRACT.replace(/\\\\n/g, '\\n')
                });
              }

              const expandContainer = document.getElementById('adb-expandCommand-editor');
              if (expandContainer) {
                expandEditor = monaco.editor.create(expandContainer, {
                  ...monacoOptions,
                  value: settings.expandCommand || DEFAULT_EXPAND
                });
              }

              // Watch for theme changes
              const themeObserver = new MutationObserver(() => {
                monaco.editor.setTheme(getMonacoTheme());
              });
              themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            }

            // Load toggle values
            document.getElementById('adb-retractOnHome').checked = settings.retractOnHome !== undefined ? settings.retractOnHome : true;
            document.getElementById('adb-retractOnRapidMove').checked = settings.retractOnRapidMove !== undefined ? settings.retractOnRapidMove : true;
            document.getElementById('adb-showAddedGCode').checked = settings.showAddedGCode !== undefined ? settings.showAddedGCode : false;
          }

          async function saveAndClose() {
            const retractCommand = retractEditor ? retractEditor.getValue().trim() : '';
            const expandCommand = expandEditor ? expandEditor.getValue().trim() : '';
            const retractOnHome = document.getElementById('adb-retractOnHome').checked;
            const retractOnRapidMove = document.getElementById('adb-retractOnRapidMove').checked;
            const showAddedGCode = document.getElementById('adb-showAddedGCode').checked;

            const settings = {
              retractCommand,
              expandCommand,
              retractOnHome,
              retractOnRapidMove,
              showAddedGCode
            };

            try {
              await fetch('/api/plugins/com.ncsender.autodustboot/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
              });
              window.postMessage({ type: 'close-plugin-dialog' }, '*');
            } catch (error) {
              console.error('Failed to save settings:', error);
            }
          }

          document.getElementById('adb-saveBtn').addEventListener('click', saveAndClose);
          init();
        })();
      </script>
      `,
      { closable: true, width: '650px' }
    );
  }, { icon: 'icon.png' });

  // NEW API: onBeforeCommand receives command array
  ctx.registerEventHandler('onBeforeCommand', async (commands, context) => {
    const settings = ctx.getSettings();
    const expandCommand = settings.expandCommand || 'M8';
    const retractCommand = settings.retractCommand || 'M8\nG4 P0.1\nM9';
    const retractOnHome = settings.retractOnHome !== undefined ? settings.retractOnHome : true;
    const retractOnRapidMove = settings.retractOnRapidMove !== undefined ? settings.retractOnRapidMove : true;
    const showAddedGCode = settings.showAddedGCode !== undefined ? settings.showAddedGCode : false;

    const hasExpandRetract = expandCommand && retractCommand;
    if (!hasExpandRetract) {
      return commands; // No configuration, pass through
    }

    // Helper to create command sequence
    function createCommandSequence(commandText) {
      const sequence = [];

      if (showAddedGCode) {
        sequence.push('(Start of AutoDustBoot Plugin Sequence)');
      }

      sequence.push(commandText);

      if (showAddedGCode) {
        sequence.push('(End of AutoDustBoot Plugin Sequence)');
      }

      // Return single command object with multi-line command string
      // When showAddedGCode is false, use silent meta to hide from terminal
      return {
        command: sequence.join('\n'),
        displayCommand: null,
        meta: showAddedGCode ? {} : { silent: true }
      };
    }

    // Find original M6 or $TLS command
    const m6Index = commands.findIndex(cmd => {
      if (!cmd.isOriginal) return false;
      const parsed = ctx.utils.parseM6Command(cmd.command);
      return parsed?.matched && parsed.toolNumber !== null;
    });

    const tlsIndex = commands.findIndex(cmd => {
      if (!cmd.isOriginal) return false;
      return /^\$tls/i.test(cmd.command.trim());
    });

    const toolChangeIndex = m6Index !== -1 ? m6Index : tlsIndex;

    if (toolChangeIndex !== -1) {
      const isTLS = toolChangeIndex === tlsIndex;
      const commandText = commands[toolChangeIndex].command.trim();

      if (isTLS) {
        const location = context.lineNumber !== undefined
          ? `at line ${context.lineNumber}`
          : `from ${context.sourceId}`;
        ctx.log(`$TLS tool change detected ${location}`);

        if (context.sourceId === 'job') {
          ctx.log('$TLS from job source, tracking tool change');
          isToolChanging = true;
          const sequence = createCommandSequence(retractCommand);
          commands.splice(toolChangeIndex, 0, sequence);
          return commands;
        } else {
          const sequence = createCommandSequence(retractCommand);
          commands.splice(toolChangeIndex, 0, sequence);
          return commands;
        }
      } else {
        // M6 command
        const parsed = ctx.utils.parseM6Command(commandText);
        const toolNumber = parsed?.toolNumber;

        if (toolNumber !== null && Number.isFinite(toolNumber)) {
          const location = context.lineNumber !== undefined
            ? `at line ${context.lineNumber}`
            : `from ${context.sourceId}`;
          ctx.log(`M6 tool change detected with T${toolNumber} ${location}`);

          if (context.sourceId === 'job') {
            ctx.log('M6 from job source, tracking tool change');
            isToolChanging = true;
            const sequence = createCommandSequence(retractCommand);
            commands.splice(toolChangeIndex, 0, sequence);
            return commands;
          } else {
            const sequence = createCommandSequence(retractCommand);
            commands.splice(toolChangeIndex, 0, sequence);
            return commands;
          }
        }
      }
    }

    // Handle job post-tool-change expansion
    if (isToolChanging && context.sourceId === 'job') {
      const normalizedExpandCmd = expandCommand.toUpperCase().replace(/([GM])0+(\d)/g, '$1$2');

      // Skip expand command from G-code (we'll inject it ourselves)
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        const normalizedLine = cmd.command.toUpperCase().replace(/([GM])0+(\d)/g, '$1$2');

        // Check if line contains the expand command (handle line numbers like N123 M8)
        // Match pattern: optional line number, optional whitespace, then the expand command
        const expandPattern = new RegExp(`^(?:N\\d+\\s*)?${normalizedExpandCmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
        if (expandPattern.test(normalizedLine)) {
          ctx.log(`Skipping expand command: ${cmd.command.trim()}`);
          cmd.command = `(${cmd.command.trim()}, Moved by AutoDustBoot Plugin)`;
          cmd.displayCommand = null;
          continue;
        }

        // Check for first XY movement
        const hasXMovement = /[^A-Z]X[-+]?\d+\.?\d*/i.test(cmd.command);
        const hasYMovement = /[^A-Z]Y[-+]?\d+\.?\d*/i.test(cmd.command);

        if (cmd.isOriginal && (hasXMovement || hasYMovement)) {
          ctx.log(`First XY movement after tool change at line ${context.lineNumber}`);
          isToolChanging = false;

          // Insert expand command after this XY movement
          const expandSequence = {
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
    const homeIndex = commands.findIndex(cmd =>
      cmd.isOriginal && cmd.command.trim().toUpperCase().startsWith('$H')
    );

    if (homeIndex !== -1 && retractOnHome) {
      ctx.log(`Home command detected: ${commands[homeIndex].command.trim()}`);
      const sequence = createCommandSequence(retractCommand);
      commands.splice(homeIndex, 0, sequence);
      return commands;
    }

    // Handle G0 rapid move (client/macro only)
    if ((context.sourceId === 'client' || context.sourceId === 'macro') && retractOnRapidMove) {
      const g0Index = commands.findIndex(cmd => {
        const normalized = cmd.command.toUpperCase().replace(/([GM])0+(\d)/g, '$1$2');
        const hasG0 = /\bG0\b/i.test(normalized);
        return cmd.isOriginal && hasG0;
      });

      if (g0Index !== -1) {
        ctx.log(`G0 command from ${context.sourceId} detected: ${commands[g0Index].command.trim()}`);
        const sequence = createCommandSequence(retractCommand);
        commands.splice(g0Index, 0, sequence);
        return commands;
      }
    }

    return commands;
  });

  ctx.registerEventHandler('onAfterJobEnd', async () => {
    ctx.log('Job ended, resetting tool change state');
    isToolChanging = false;
  });
}

export function onUnload() {
  console.log('[PLUGIN:com.ncsender.autodustboot] AutoDustBoot plugin unloaded');
  isToolChanging = false;
}
