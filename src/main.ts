import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { Client as SSHClient, ConnectConfig } from 'ssh2';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { StringDecoder } from 'string_decoder';

// macOS: Chromium compositor の elastic overscroll を無効化 (app.ready より前に設定)
app.commandLine.appendSwitch('disable-features', 'ElasticOverscroll');
app.commandLine.appendSwitch('overscroll-history-navigation', '0');

export interface SSHProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'key' | 'both';
  password?: string;
  keyPath?: string;
  pinned: boolean;
  lastUsed: number;
  useCount: number;
}

let mainWindow: BrowserWindow | null = null;
const ptyProcesses = new Map<number, pty.IPty>();
const sshSessions = new Map<number, { conn: SSHClient; stream: NodeJS.ReadWriteStream }>();
let nextPtyId = 1;

// ---- Platform detection ----

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// ---- MSYS2 detection (Windows only) ----

function getMsys2SearchRoots(): string[] {
  const roots: string[] = [];
  const envRoot = process.env.MSYS2_ROOT ?? process.env.MSYS_ROOT;
  if (envRoot) roots.push(envRoot.replace(/[/\\]$/, ''));
  const sysDrive = (process.env.SYSTEMDRIVE ?? 'C:').replace(/[/\\]$/, '');
  roots.push(path.join(sysDrive, 'msys64'), path.join(sysDrive, 'msys32'));
  for (const letter of ['C', 'D', 'E']) {
    if (!sysDrive.toUpperCase().startsWith(letter)) {
      roots.push(`${letter}:\\msys64`, `${letter}:\\msys32`);
    }
  }
  return roots;
}

interface Msys2Info {
  root: string;
  zsh: string;
  bash: string;
}

function findMsys2(): Msys2Info | null {
  if (!isWin) return null;
  for (const root of getMsys2SearchRoots()) {
    const zsh = path.join(root, 'usr', 'bin', 'zsh.exe');
    const bash = path.join(root, 'usr', 'bin', 'bash.exe');
    if (fs.existsSync(zsh)) {
      return { root, zsh, bash };
    }
  }
  return null;
}

function buildMsys2Env(root: string): { [key: string]: string } {
  const msys2BinPaths = [
    path.join(root, 'usr', 'local', 'bin'),
    path.join(root, 'usr', 'bin'),
    path.join(root, 'bin'),
  ];

  const msys2PosixPaths = [
    '/usr/local/bin', '/usr/bin', '/bin',
    '/usr/bin/site_perl', '/usr/bin/vendor_perl', '/usr/bin/core_perl',
  ].join(':');

  const winPath = process.env.PATH ?? '';
  const combinedPath = [...msys2BinPaths, winPath].join(';');

  return {
    ...process.env as { [key: string]: string },
    MSYSTEM: 'MSYS',
    PATH: combinedPath,
    MSYS2_PATH: msys2PosixPaths,
    CHERE_INVOKING: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'infiniterm',
    TERM_PROGRAM_VERSION: '0.1.0',
    LANG: 'ja_JP.UTF-8',
    LC_ALL: 'ja_JP.UTF-8',
    MSYS: 'winsymlinks:nativestrict',
    NCURSES_NO_UTF8_ACS: '1',
  };
}

function buildBaseEnv(): { [key: string]: string } {
  return {
    ...process.env as { [key: string]: string },
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'infiniterm',
    TERM_PROGRAM_VERSION: '0.1.0',
  };
}

// ---- Shell catalog ----

export interface ShellEntry {
  id: string;
  label: string;
  exe: string;
  isMsys2: boolean;
}

function detectShells(): ShellEntry[] {
  if (isWin) return detectShellsWindows();
  return detectShellsUnix();
}

function detectShellsWindows(): ShellEntry[] {
  const shells: ShellEntry[] = [];

  // 1. MSYS2 zsh
  const msys2 = findMsys2();
  if (msys2) {
    shells.push({ id: 'msys2-zsh', label: 'zsh (MSYS2)', exe: msys2.zsh, isMsys2: true });
    if (fs.existsSync(msys2.bash)) {
      shells.push({ id: 'msys2-bash', label: 'bash (MSYS2)', exe: msys2.bash, isMsys2: true });
    }
  }

  // 2. PowerShell 7 (pwsh)
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  for (const p of [
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
  ]) {
    if (fs.existsSync(p)) {
      shells.push({ id: 'pwsh7', label: 'PowerShell 7 (pwsh)', exe: p, isMsys2: false });
      break;
    }
  }

  // 3. PowerShell 5
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const ps5 = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(ps5)) {
    shells.push({ id: 'pwsh5', label: 'PowerShell 5', exe: ps5, isMsys2: false });
  }

  // 4. CMD
  const cmd = process.env.COMSPEC ?? path.join(systemRoot, 'System32', 'cmd.exe');
  if (fs.existsSync(cmd)) {
    shells.push({ id: 'cmd', label: 'Command Prompt', exe: cmd, isMsys2: false });
  }

  return shells;
}

function detectShellsUnix(): ShellEntry[] {
  const shells: ShellEntry[] = [];
  const seen = new Set<string>();

  const candidates: { id: string; label: string; paths: string[] }[] = [
    { id: 'zsh',  label: 'zsh',  paths: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'] },
    { id: 'bash', label: 'bash', paths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'] },
    { id: 'fish', label: 'fish', paths: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'] },
    { id: 'sh',   label: 'sh',   paths: ['/bin/sh'] },
  ];

  for (const c of candidates) {
    for (const p of c.paths) {
      if (!seen.has(c.id) && fs.existsSync(p)) {
        shells.push({ id: c.id, label: c.label, exe: p, isMsys2: false });
        seen.add(c.id);
        break;
      }
    }
  }

  return shells;
}

// ---- Preferences (default shell) ----

const PREFS_FILE = path.join(os.homedir(), '.infiniterm.json');

interface Prefs {
  defaultShellId: string;
  sshProfiles: SSHProfile[];
}

function loadPrefs(): Prefs {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) as Prefs;
  } catch {
    return { defaultShellId: '', sshProfiles: [] };
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf8');
  } catch { /* ignore */ }
}

// ---- PTY env resolver ----

function resolveShellEnv(exe: string): { [key: string]: string } {
  const msys2 = findMsys2();
  if (msys2 && exe.toLowerCase().startsWith(msys2.root.toLowerCase())) {
    return buildMsys2Env(msys2.root);
  }
  return buildBaseEnv();
}

// ---- Window ----

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    frame: isWin ? false : true,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 10, y: 6 } : undefined,
    show: false,
    title: 'infiniterm',
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    for (const ptyProc of ptyProcesses.values()) {
      try { ptyProc.kill(); } catch (_) { /* ignore */ }
    }
    ptyProcesses.clear();
    for (const ssh of sshSessions.values()) {
      try { ssh.conn.end(); } catch (_) { /* ignore */ }
    }
    sshSessions.clear();
    mainWindow = null;
  });
}

// ---- IPC ----

app.whenReady().then(() => {
  createWindow();

  // List available shells
  ipcMain.handle('shell-list', () => {
    const shells = detectShells();
    const prefs = loadPrefs();
    const defaultId = prefs.defaultShellId || (shells[0]?.id ?? '');
    return { shells, defaultId };
  });

  // Set default shell
  ipcMain.on('shell-set-default', (_event, { id }: { id: string }) => {
    const prefs = loadPrefs();
    prefs.defaultShellId = id;
    savePrefs(prefs);
  });

  // Create PTY
  ipcMain.handle('pty-create', (_event, { shell: shellExe, cols, rows }: {
    shell?: string;
    cols: number;
    rows: number;
  }) => {
    const id = nextPtyId++;

    let exe: string;
    if (shellExe) {
      exe = shellExe;
    } else {
      // Use saved default or first detected shell
      const shells = detectShells();
      const prefs = loadPrefs();
      const found = shells.find(s => s.id === prefs.defaultShellId) ?? shells[0];
      if (isWin) {
        exe = found?.exe ?? (process.env.COMSPEC ?? 'cmd.exe');
      } else {
        exe = found?.exe ?? (process.env.SHELL ?? '/bin/zsh');
      }
    }

    const env = resolveShellEnv(exe);

    let spawnExe: string;
    let spawnArgs: string[];

    if (isWin) {
      // MSYS2 シェルは cmd.exe 経由で起動し、先に chcp 65001 (UTF-8) を設定する。
      const msys2 = findMsys2();
      const isMsys2Shell = !!(msys2 && exe.toLowerCase().startsWith(msys2.root.toLowerCase()));

      if (isMsys2Shell) {
        const comspec = process.env.COMSPEC ?? 'cmd.exe';
        spawnExe = comspec;
        spawnArgs = ['/c', `chcp 65001>nul 2>&1 & ${exe}`];
      } else {
        spawnExe = exe;
        spawnArgs = [];
      }
    } else {
      // macOS / Linux
      spawnExe = exe;
      spawnArgs = [];
    }

    const ptyProc = pty.spawn(spawnExe, spawnArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env,
      ...(isWin ? { useConpty: false } : {}),
    });

    ptyProc.onData((data: string) => {
      mainWindow?.webContents.send('pty-data', { id, data });
    });

    ptyProc.onExit(({ exitCode, signal }) => {
      mainWindow?.webContents.send('pty-exit', { id, exitCode, signal });
      ptyProcesses.delete(id);
    });

    ptyProcesses.set(id, ptyProc);
    return { id, shell: exe };
  });

  // Input
  ipcMain.on('pty-input', (_event, { id, data }: { id: number; data: string }) => {
    const ptyProc = ptyProcesses.get(id);
    if (ptyProc) {
      try { ptyProc.write(data); } catch (_) { /* ignore */ }
      return;
    }
    const ssh = sshSessions.get(id);
    if (ssh) {
      try { ssh.stream.write(data); } catch (_) { /* ignore */ }
    }
  });

  // Resize
  ipcMain.on('pty-resize', (_event, { id, cols, rows }: { id: number; cols: number; rows: number }) => {
    const ptyProc = ptyProcesses.get(id);
    if (ptyProc) {
      try { ptyProc.resize(Math.max(1, cols), Math.max(1, rows)); } catch (_) { /* ignore */ }
    }
  });

  // Kill
  ipcMain.on('pty-kill', (_event, { id }: { id: number }) => {
    const ptyProc = ptyProcesses.get(id);
    if (ptyProc) {
      try { ptyProc.kill(); } catch (_) { /* ignore */ }
      ptyProcesses.delete(id);
    }
  });

  // SSH profile list
  ipcMain.handle('ssh-profiles-list', () => {
    return loadPrefs().sshProfiles;
  });

  // SSH profile save (upsert)
  ipcMain.on('ssh-profile-save', (_event, { profile }: { profile: SSHProfile }) => {
    const prefs = loadPrefs();
    const idx = prefs.sshProfiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) prefs.sshProfiles[idx] = profile;
    else prefs.sshProfiles.push(profile);
    savePrefs(prefs);
  });

  // SSH profile delete
  ipcMain.on('ssh-profile-delete', (_event, { id }: { id: string }) => {
    const prefs = loadPrefs();
    prefs.sshProfiles = prefs.sshProfiles.filter(p => p.id !== id);
    savePrefs(prefs);
  });

  // SSH profile pin
  ipcMain.on('ssh-profile-pin', (_event, { id, pinned }: { id: string; pinned: boolean }) => {
    const prefs = loadPrefs();
    const p = prefs.sshProfiles.find(p => p.id === id);
    if (p) { p.pinned = pinned; savePrefs(prefs); }
  });

  // SSH connect
  ipcMain.handle('ssh-connect', (_event, {
    profile, cols, rows
  }: { profile: SSHProfile; cols: number; rows: number }) => {
    return new Promise<{ id: number }>((resolve, reject) => {
      const conn = new SSHClient();
      const id = nextPtyId++;

      const cfg: ConnectConfig = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
      };

      if (profile.authType === 'password') {
        cfg.password = profile.password;
      } else if (profile.authType === 'key') {
        if (profile.keyPath) {
          try { cfg.privateKey = fs.readFileSync(profile.keyPath); } catch (e) {
            return reject(new Error(`鍵ファイルを読み込めません: ${e}`));
          }
        }
        if (profile.password) cfg.passphrase = profile.password;
      } else if (profile.authType === 'both') {
        cfg.password = profile.password;
        if (profile.keyPath) {
          try { cfg.privateKey = fs.readFileSync(profile.keyPath); } catch (e) {
            return reject(new Error(`鍵ファイルを読み込めません: ${e}`));
          }
        }
      }

      conn.on('ready', () => {
        conn.shell({
          term: 'xterm-256color', cols, rows,
          modes: {
            VERASE: 127,  // Backspace = DEL (0x7f)
            ICRNL: 1,     // Map CR to NL on input
            ONLCR: 1,     // Map NL to CR+NL on output
            ISIG: 1,      // Generate signals (Ctrl+C etc.)
            ICANON: 1,    // Canonical input processing
            ECHO: 1,      // Echo input characters
            ECHOE: 1,     // Echo erase character
          },
        }, (err, stream) => {
          if (err) { conn.end(); return reject(err); }

          sshSessions.set(id, { conn, stream });
          resolve({ id });

          const decoder = new StringDecoder('utf8');
          stream.on('data', (data: Buffer) => {
            mainWindow?.webContents.send('pty-data', { id, data: decoder.write(data) });
          });
          stream.stderr?.on('data', (data: Buffer) => {
            mainWindow?.webContents.send('pty-data', { id, data: decoder.write(data) });
          });
          stream.on('close', () => {
            mainWindow?.webContents.send('pty-exit', { id, exitCode: 0 });
            sshSessions.delete(id);
            conn.end();
          });
        });
      });

      conn.on('error', (err) => {
        reject(new Error(err.message));
      });

      conn.connect(cfg);
    });
  });

  // SSH disconnect
  ipcMain.on('ssh-disconnect', (_event, { id }: { id: number }) => {
    const ssh = sshSessions.get(id);
    if (ssh) {
      try { ssh.conn.end(); } catch (_) { /* ignore */ }
      sshSessions.delete(id);
    }
  });

  // SSH resize
  ipcMain.on('ssh-resize', (_event, { id, cols, rows }: { id: number; cols: number; rows: number }) => {
    const ssh = sshSessions.get(id);
    if (ssh) {
      try { (ssh.stream as any).setWindow(rows, cols, 0, 0); } catch (_) { /* ignore */ }
    }
  });

  // Dialog: open file (for key selection)
  ipcMain.handle('dialog-open-file', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '秘密鍵ファイルを選択',
      properties: ['openFile'],
      filters: [
        { name: '秘密鍵', extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519', 'openssh'] },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // Window controls
  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.on('window-close', () => mainWindow?.close());

  mainWindow?.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  // macOS では全ウィンドウを閉じてもアプリを終了しない (標準的な挙動)
  if (!isMac) app.quit();
});

// macOS: Dock アイコンクリック時にウィンドウがなければ再作成
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
