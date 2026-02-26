import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { onBeforeCommand, buildInitialConfig, onAfterJobEnd } from './commands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const resolveServerPort = (pluginSettings = {}, appSettings = {}) => {
  const appPort = Number.parseInt(appSettings?.senderPort, 10);
  if (Number.isFinite(appPort)) {
    return appPort;
  }
  const pluginPort = Number.parseInt(pluginSettings?.port, 10);
  if (Number.isFinite(pluginPort)) {
    return pluginPort;
  }
  return 8090;
};

export async function onLoad(ctx) {
  ctx.log('AutoDustBoot plugin loaded');

  ctx.registerEventHandler('onBeforeCommand', async (commands, context) => {
    const settings = buildInitialConfig(ctx.getSettings() || {});
    return onBeforeCommand(commands, context, settings);
  });

  ctx.registerEventHandler('onAfterJobEnd', async () => {
    ctx.log('Job ended, resetting tool change state');
    onAfterJobEnd();
  });

  ctx.registerToolMenu('AutoDustBoot', async () => {
    ctx.log('AutoDustBoot settings opened');

    const storedSettings = ctx.getSettings() || {};
    const appSettings = ctx.getAppSettings() || {};
    const serverPort = resolveServerPort(storedSettings, appSettings);

    let html = readFileSync(join(__dirname, 'config.html'), 'utf-8');
    html = html.replace('__SERVER_PORT__', String(serverPort));

    ctx.showDialog('AutoDustBoot Settings', html, { closable: true, width: '650px' });
  }, { icon: 'icon.png' });
}

export function onUnload() {
  console.log('[PLUGIN:com.ncsender.autodustboot] AutoDustBoot plugin unloaded');
  onAfterJobEnd();
}
