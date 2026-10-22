import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's only door to the application: one function that sends a named
 * command to the main process. Main validates the command name, the input and the
 * caller's permissions; nothing else (filesystem, SQL, Node) is exposed.
 */
const api = {
  invoke: (command: string, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('hws:invoke', { command, input }),
};

contextBridge.exposeInMainWorld('hws', api);
