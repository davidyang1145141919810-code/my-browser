const { app, BrowserWindow, dialog, ipcMain, session, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

let mainWindow;
const enabledThemes = ['system', 'aurora', 'midnight', 'sunrise'];
let currentTheme = 'system';
let downloads = [];
let loadedExtensions = [];
let settings = {
  searchEngine: 'https://www.google.com/search?q=',
  homepage: 'https://www.google.com',
  openLinksInNewTab: true,
  theme: 'system',
  downloadDir: app.getPath('downloads')
};
let aiConfig = { apiKey: '', model: 'deepseek-v4-flash' };

function parseAiConfig(content) {
  const lines = content.split(/\r?\n/);
  const parsed = { apiKey: '', model: 'deepseek-v4-flash' };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('```')) continue;
    const match = trimmed.match(/^(API_KEY|MODEL)\s*=\s*(.+)$/i);
    if (!match) continue;
    const key = match[1].toUpperCase();
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'API_KEY') parsed.apiKey = value;
    if (key === 'MODEL') parsed.model = value;
  }
  return parsed;
}

function readAiConfig() {
  const candidates = [
    path.join(process.cwd(), 'key.md'),
    path.join(app.getAppPath(), 'key.md'),
    path.join(__dirname, '../../key.md')
  ];

  for (const configPath of candidates) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, 'utf8');
      const parsed = parseAiConfig(content);
      if (parsed.apiKey || parsed.model) {
        aiConfig = {
          apiKey: parsed.apiKey,
          model: ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(parsed.model)
            ? parsed.model
            : 'deepseek-v4-flash'
        };
        return;
      }
    } catch {
      continue;
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0f172a',
    title: 'Browser Desktop',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = input.key?.toLowerCase();
    const ctrl = input.control || input.meta;
    const shift = input.shift;

    if (ctrl && key === 'l') { mainWindow.webContents.send('shortcut:focus-address'); event.preventDefault(); }
    else if (ctrl && key === 'w') { mainWindow.webContents.send('shortcut:close-tab'); event.preventDefault(); }
    else if (ctrl && key === 'tab' && !shift) { mainWindow.webContents.send('shortcut:next-tab'); event.preventDefault(); }
    else if (ctrl && key === 'tab' && shift) { mainWindow.webContents.send('shortcut:previous-tab'); event.preventDefault(); }
    else if (ctrl && key >= '1' && key <= '8') { mainWindow.webContents.send('shortcut:tab-index', Number(key) - 1); event.preventDefault(); }
    else if (ctrl && key === '9') { mainWindow.webContents.send('shortcut:tab-index', 8); event.preventDefault(); }
    else if (ctrl && shift && key === 'j') { mainWindow.webContents.send('shortcut:downloads'); event.preventDefault(); }
    else if (ctrl && key === 'h') { mainWindow.webContents.send('shortcut:history'); event.preventDefault(); }
    else if (ctrl && shift && key === 'b') { mainWindow.webContents.send('shortcut:bookmarks'); event.preventDefault(); }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function applyTheme(theme) {
  if (!enabledThemes.includes(theme)) return;
  currentTheme = theme;
  BrowserWindow.getAllWindows().forEach(win => win.webContents.send('theme-changed', theme));
}

function openLocalFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileUrl = url.pathToFileURL(filePath).toString();
  if (ext === '.html' || ext === '.htm') { mainWindow.webContents.send('open-url', fileUrl); return { type: 'html', url: fileUrl }; }
  if (ext === '.pdf') { mainWindow.webContents.send('open-pdf', fileUrl); return { type: 'pdf', url: fileUrl }; }
  throw new Error('仅支持 HTML/HTM/PDF 文件');
}

function broadcastDownloads() { BrowserWindow.getAllWindows().forEach(win => win.webContents.send('downloads-updated', downloads)); }
function broadcastExtensions() { BrowserWindow.getAllWindows().forEach(win => win.webContents.send('extensions-updated', loadedExtensions)); }
function broadcastSettings() { BrowserWindow.getAllWindows().forEach(win => win.webContents.send('settings-updated', settings)); }
function broadcastAiConfig() { BrowserWindow.getAllWindows().forEach(win => win.webContents.send('ai-config-updated', { model: aiConfig.model, hasApiKey: !!aiConfig.apiKey })); }

function setupDownloads() {
  session.defaultSession.on('will-download', (event, item) => {
    const fileName = item.getFilename();
    const downloadPath = path.join(settings.downloadDir || app.getPath('downloads'), fileName);
    item.setSavePath(downloadPath);

    const downloadRecord = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, fileName, savePath: downloadPath, state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes(), url: item.getURL() };
    downloads.unshift(downloadRecord);
    broadcastDownloads();

    item.on('updated', () => { downloadRecord.state = item.isPaused() ? 'paused' : 'progressing'; downloadRecord.receivedBytes = item.getReceivedBytes(); downloadRecord.totalBytes = item.getTotalBytes(); broadcastDownloads(); });
    item.once('done', (_, state) => { downloadRecord.state = state; downloadRecord.receivedBytes = item.getReceivedBytes(); downloadRecord.totalBytes = item.getTotalBytes(); broadcastDownloads(); });
  });
}

async function loadExtensionDir(extensionDir) {
  try {
    const extension = await session.defaultSession.loadExtension(extensionDir, { allowFileAccess: true });
    const item = { id: extension.id, name: extension.name, version: extension.version || 'unknown', path: extensionDir, enabled: true };
    const index = loadedExtensions.findIndex(ext => ext.id === item.id);
    if (index >= 0) loadedExtensions[index] = { ...loadedExtensions[index], ...item };
    else loadedExtensions.unshift(item);
    broadcastExtensions();
    return item;
  } catch (error) { throw new Error(`扩展加载失败: ${error.message}`); }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '新建标签页', accelerator: 'Ctrl+T', click: () => mainWindow?.webContents.send('shortcut:new-tab') },
        { label: '恢复关闭的标签页', accelerator: 'Ctrl+Shift+T', click: () => mainWindow?.webContents.send('shortcut:reopen-tab') },
        { label: '打开本地文件', accelerator: 'Ctrl+O', click: async () => { const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: '网页和文档', extensions: ['html', 'htm', 'pdf'] }] }); if (!result.canceled && result.filePaths[0]) { try { openLocalFile(result.filePaths[0]); } catch (error) { dialog.showErrorBox('打开失败', error.message); } } } },
        { type: 'separator' },
        { role: 'quit', accelerator: 'Ctrl+Shift+Q' }
      ]
    },
    {
      label: '查看',
      submenu: [
        { role: 'reload', accelerator: 'Ctrl+R' },
        { role: 'forceReload', accelerator: 'Ctrl+Shift+R' },
        { role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' },
        { type: 'separator' },
        { label: '主页', accelerator: 'Alt+Home', click: () => mainWindow?.webContents.send('shortcut:home') },
        { label: '下载管理', accelerator: 'Ctrl+J', click: () => mainWindow?.webContents.send('shortcut:downloads') },
        { label: '书签管理', accelerator: 'Ctrl+Shift+B', click: () => mainWindow?.webContents.send('shortcut:bookmarks') },
        { label: '扩展管理', accelerator: 'Ctrl+Shift+E', click: () => mainWindow?.webContents.send('shortcut:extensions') },
        { label: '设置', accelerator: 'Ctrl+,', click: () => mainWindow?.webContents.send('shortcut:settings') }
      ]
    },
    { label: '主题', submenu: enabledThemes.map(theme => ({ label: theme, type: 'radio', checked: theme === currentTheme, click: () => applyTheme(theme) })) }
  ]);
}

app.whenReady().then(() => {
  readAiConfig();
  createWindow();
  setupDownloads();
  Menu.setApplicationMenu(buildMenu());

  ipcMain.handle('browser:navigate', (_, targetUrl) => targetUrl);
  ipcMain.handle('browser:open-file', async () => { const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: '网页和文档', extensions: ['html', 'htm', 'pdf'] }] }); if (result.canceled || !result.filePaths[0]) return null; return openLocalFile(result.filePaths[0]); });
  ipcMain.handle('browser:set-theme', (_, theme) => { applyTheme(theme); settings.theme = theme; broadcastSettings(); return theme; });
  ipcMain.handle('browser:get-theme', () => currentTheme);
  ipcMain.handle('browser:list-extensions', async () => loadedExtensions);
  ipcMain.handle('browser:get-downloads', async () => downloads);
  ipcMain.handle('browser:open-download-location', async (_, savePath) => shell.showItemInFolder(savePath));
  ipcMain.handle('browser:load-extension', async (_, extensionDir) => loadExtensionDir(extensionDir));
  ipcMain.handle('browser:unload-extension', async (_, extensionId) => { const index = loadedExtensions.findIndex(ext => ext.id === extensionId); if (index === -1) return false; try { await session.defaultSession.removeExtension(extensionId); } catch {} loadedExtensions.splice(index, 1); broadcastExtensions(); return true; });
  ipcMain.handle('browser:pick-extension-dir', async () => { const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if (result.canceled || !result.filePaths[0]) return null; return result.filePaths[0]; });
  ipcMain.handle('browser:get-settings', async () => settings);
  ipcMain.handle('browser:update-settings', async (_, nextSettings) => { settings = { ...settings, ...nextSettings }; if (settings.theme) applyTheme(settings.theme); broadcastSettings(); return settings; });
  ipcMain.handle('browser:pick-download-dir', async () => { const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if (result.canceled || !result.filePaths[0]) return null; settings.downloadDir = result.filePaths[0]; broadcastSettings(); return settings.downloadDir; });
  ipcMain.handle('browser:get-download-dir', async () => settings.downloadDir);
  ipcMain.handle('browser:get-ai-config', async () => ({ model: aiConfig.model, hasApiKey: !!aiConfig.apiKey }));
  ipcMain.handle('browser:read-ai-config', async () => ({ model: aiConfig.model, hasApiKey: !!aiConfig.apiKey }));
  ipcMain.handle('browser:write-ai-config', async (_, nextConfig) => {
    aiConfig = {
      apiKey: typeof nextConfig?.apiKey === 'string' ? nextConfig.apiKey : aiConfig.apiKey,
      model: ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(nextConfig?.model) ? nextConfig.model : aiConfig.model
    };
    broadcastAiConfig();
    return { model: aiConfig.model, hasApiKey: !!aiConfig.apiKey };
  });

  broadcastAiConfig();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });