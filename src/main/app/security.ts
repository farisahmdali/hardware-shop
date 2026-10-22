import { app, session, type WebContents } from 'electron';
import type { Logger } from '../services/env';

/**
 * The application never needs the network. Every http(s)/ws request is cancelled,
 * except the local dev server while developing. This both hardens the renderer and
 * proves at runtime that no feature depends on an online service.
 */
export function blockNetwork(logger: Logger, devServerUrl: string | undefined): void {
  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : null;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const url = details.url;
    const local = /^(file|devtools|data|blob|chrome-extension):/i.test(url);
    const dev = devOrigin !== null && (url.startsWith(devOrigin) || url.startsWith(devOrigin.replace(/^http/, 'ws')));
    if (local || dev) return callback({});
    logger.warn(`Blocked network request: ${url}`);
    callback({ cancel: true });
  });

  // No camera, microphone, location, notifications or other device permissions.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

/** Applies navigation restrictions to every web contents the app creates. */
export function hardenWebContents(allowedUrlPrefix: () => string): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(allowedUrlPrefix())) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
