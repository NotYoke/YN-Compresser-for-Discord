const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFile:    ()     => ipcRenderer.invoke('select-file'),
  getVideoInfo:  (p)    => ipcRenderer.invoke('get-video-info', p),
  compressVideo: (opts) => ipcRenderer.invoke('compress-video', opts),
  cancelCompress:()     => ipcRenderer.send('cancel-compress'),
  openFolder:    (p)    => ipcRenderer.send('open-folder', p),
  onProgress:    (cb)   => ipcRenderer.on('compress-progress', (_, v) => cb(v)),
  offProgress:   ()     => ipcRenderer.removeAllListeners('compress-progress'),
  minimize:      ()     => ipcRenderer.send('window-minimize'),
  close:         ()     => ipcRenderer.send('window-close'),
});
