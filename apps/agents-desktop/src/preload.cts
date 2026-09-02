const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const channels = {
  list: 'servers:list',
  save: 'servers:save',
  remove: 'servers:remove',
  request: 'servers:request',
} as const;

contextBridge.exposeInMainWorld('piDeckServers', {
  list: () => ipcRenderer.invoke(channels.list),
  save: (input: unknown) => ipcRenderer.invoke(channels.save, input),
  remove: (serverId: string) => ipcRenderer.invoke(channels.remove, serverId),
  request: (input: unknown) => ipcRenderer.invoke(channels.request, input),
});
