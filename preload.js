const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('downloadDashboard', {
    getStatus: () => ipcRenderer.invoke('downloads:get-status'),
    exportHistory: () => ipcRenderer.invoke('history:export'),
    clearHistory: () => ipcRenderer.invoke('history:clear'),
    cancelRequest: id => ipcRenderer.invoke('history:cancel-request', id),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
    completeWelcome: () => ipcRenderer.invoke('settings:complete-welcome'),
    testConnection: (service, values) => ipcRenderer.invoke('settings:test-connection', service, values),
    getManagerOptions: (service, values) => ipcRenderer.invoke('settings:get-manager-options', service, values),
    registerCommand: () => ipcRenderer.invoke('settings:register-command'),
    onBotStatus: callback => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('bot:status', listener);
        return () => ipcRenderer.removeListener('bot:status', listener);
    },
    reannounceAllTrackers: () => ipcRenderer.invoke('trackers:reannounce-all'),
    chooseMediaSyncScript: role => ipcRenderer.invoke('media-sync:choose-script', role),
    getMediaSyncStatus: () => ipcRenderer.invoke('media-sync:get-status'),
    startMediaSync: role => ipcRenderer.invoke('media-sync:start', role),
    stopMediaSync: role => ipcRenderer.invoke('media-sync:stop', role),
    onMediaSyncStatus: callback => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('media-sync:status', listener);
        return () => ipcRenderer.removeListener('media-sync:status', listener);
    },
    getWindowState: () => ipcRenderer.invoke('window:get-state'),
    getPlatform: () => ipcRenderer.invoke('app:get-platform'),
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
    hideWindow: () => ipcRenderer.invoke('window:hide')
});
