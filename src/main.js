const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let mainWindow;
let currentProcess = null;

function getFFmpegPath() {
  // ffmpeg-static はアンパックされた場所に存在する
  const ffmpegStatic = require('ffmpeg-static');
  if (app.isPackaged) {
    // asar unpack後のパス
    return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
  }
  return ffmpegStatic;
}

function getFFprobePath() {
  const ffprobeStatic = require('ffprobe-static');
  const p = ffprobeStatic.path;
  if (app.isPackaged) {
    return p.replace('app.asar', 'app.asar.unpacked');
  }
  return p;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 580,
    height: 680,
    minWidth: 460,
    minHeight: 540,
    frame: false,
    backgroundColor: '#0f0f10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ウィンドウ操作
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => mainWindow?.close());

// ファイル選択
ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '動画ファイルを選択',
    filters: [
      { name: '動画', extensions: ['mp4','mov','avi','mkv','webm','flv','wmv','m4v','ts'] },
      { name: 'すべて', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const fp = result.filePaths[0];
  const stat = fs.statSync(fp);
  return { path: fp, name: path.basename(fp), size: stat.size };
});

// 動画情報取得
ipcMain.handle('get-video-info', async (_, inputPath) => {
  return new Promise((resolve) => {
    execFile(getFFprobePath(), [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) { resolve({ duration: null }); return; }
      try {
        const info = JSON.parse(stdout);
        const vs = (info.streams || []).find(s => s.codec_type === 'video');
        resolve({
          duration: parseFloat(info.format?.duration || 0) || null,
          width: vs?.width || null,
          height: vs?.height || null,
        });
      } catch { resolve({ duration: null }); }
    });
  });
});

// 圧縮処理（2パスエンコード）
ipcMain.handle('compress-video', async (event, { inputPath, outputPath, targetMB, quality }) => {
  return new Promise((resolve, reject) => {

    execFile(getFFprobePath(), [
      '-v', 'quiet', '-print_format', 'json', '-show_format', inputPath
    ], { timeout: 10000 }, (err, stdout) => {

      let duration = 60;
      if (!err) {
        try { duration = parseFloat(JSON.parse(stdout).format?.duration || 60); } catch {}
      }

      // ビットレート計算（目標の90%で余裕を持たせる）
      const targetBytes = targetMB * 1024 * 1024 * 0.90;
      const totalKbps = Math.floor((targetBytes * 8) / duration / 1000);
      const audioKbps = 96;
      const videoKbps = Math.max(totalKbps - audioKbps, 100);

      // quality 1-10 → preset（遅いほど高画質・小サイズ）
      const presets = ['veryslow','veryslow','slower','slower','slow','medium','fast','fast','veryfast','veryfast'];
      const preset = presets[quality - 1];

      const os = require('os');
      const passlogPath = path.join(os.tmpdir(), `ffmpeg2pass_${Date.now()}`);

      const ffmpeg = getFFmpegPath();

      // 共通オプション
      const commonArgs = [
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', preset,
        '-b:v', `${videoKbps}k`,
      ];

      // パス1（映像解析のみ、音声なし）
      const pass1Args = [
        ...commonArgs,
        '-pass', '1',
        '-passlogfile', passlogPath,
        '-an',
        '-f', 'null',
        process.platform === 'win32' ? 'NUL' : '/dev/null'
      ];

      // パス2（実際の出力）
      const pass2Args = [
        ...commonArgs,
        '-pass', '2',
        '-passlogfile', passlogPath,
        '-c:a', 'aac',
        '-b:a', `${audioKbps}k`,
        '-movflags', '+faststart',
        '-y',
        outputPath
      ];

      const runPass = (args, progressOffset, progressScale, onDone) => {
        const proc = execFile(ffmpeg, args, { maxBuffer: 1024 * 1024 * 20 }, (e) => {
          if (e?.killed) { reject(new Error('キャンセル')); return; }
          if (e) { reject(new Error(e.message)); return; }
          onDone(proc);
        });
        currentProcess = proc;

        let buf = '';
        proc.stderr?.on('data', (data) => {
          buf += data.toString();
          const matches = buf.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
          if (matches && duration > 0) {
            const last = matches[matches.length - 1].match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (last) {
              const elapsed = +last[1] * 3600 + +last[2] * 60 + parseFloat(last[3]);
              const pct = Math.min(Math.round(progressOffset + (elapsed / duration) * progressScale), 99);
              event.sender.send('compress-progress', pct);
            }
          }
        });
      };

      // パス1実行 → 完了後パス2実行
      runPass(pass1Args, 0, 45, () => {
        event.sender.send('compress-progress', 50);
        runPass(pass2Args, 50, 49, () => {
          currentProcess = null;
          // パスログ削除
          try {
            fs.unlinkSync(passlogPath + '-0.log');
            fs.unlinkSync(passlogPath + '-0.log.mbtree');
          } catch {}
          try {
            const stat = fs.statSync(outputPath);
            resolve({ outputSize: stat.size, outputPath });
          } catch {
            reject(new Error('出力ファイルが見つかりません'));
          }
        });
      });
    });
  });
});

ipcMain.on('cancel-compress', () => {
  currentProcess?.kill();
  currentProcess = null;
});

ipcMain.on('open-folder', (_, fp) => shell.showItemInFolder(fp));
