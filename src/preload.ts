import { contextBridge, ipcRenderer } from 'electron';

export interface ShellEntry {
  id: string;
  label: string;
  exe: string;
  isMsys2: boolean;
}

export interface ShellListResult {
  shells: ShellEntry[];
  defaultId: string;
}

export interface PtyCreateResult {
  id: number;
  shell: string;
}

export interface PtyDataEvent {
  id: number;
  data: string;
}

export interface PtyExitEvent {
  id: number;
  exitCode: number;
  signal?: number;
}

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

const electronAPI = {
  // Platform info
  platform: process.platform as string,

  // Shell discovery and preferences
  listShells: (): Promise<ShellListResult> =>
    ipcRenderer.invoke('shell-list'),

  setDefaultShell: (id: string): void =>
    ipcRenderer.send('shell-set-default', { id }),

  // PTY lifecycle
  createPty: (opts: { shell?: string; cols: number; rows: number }): Promise<PtyCreateResult> =>
    ipcRenderer.invoke('pty-create', opts),

  killPty: (id: number): void =>
    ipcRenderer.send('pty-kill', { id }),

  // I/O
  sendInput: (id: number, data: string): void =>
    ipcRenderer.send('pty-input', { id, data }),

  resize: (id: number, cols: number, rows: number): void =>
    ipcRenderer.send('pty-resize', { id, cols, rows }),

  // Events
  onData: (callback: (event: PtyDataEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: PtyDataEvent) => callback(event);
    ipcRenderer.on('pty-data', handler);
    return () => ipcRenderer.removeListener('pty-data', handler);
  },

  onExit: (callback: (event: PtyExitEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: PtyExitEvent) => callback(event);
    ipcRenderer.on('pty-exit', handler);
    return () => ipcRenderer.removeListener('pty-exit', handler);
  },

  // Window controls
  minimize: (): void => ipcRenderer.send('window-minimize'),
  maximize: (): void => ipcRenderer.send('window-maximize'),
  close: (): void => ipcRenderer.send('window-close'),

  // SSH profiles
  sshProfilesList: (): Promise<SSHProfile[]> =>
    ipcRenderer.invoke('ssh-profiles-list'),

  sshProfileSave: (profile: SSHProfile): void =>
    ipcRenderer.send('ssh-profile-save', { profile }),

  sshProfileDelete: (id: string): void =>
    ipcRenderer.send('ssh-profile-delete', { id }),

  sshProfilePin: (id: string, pinned: boolean): void =>
    ipcRenderer.send('ssh-profile-pin', { id, pinned }),

  // SSH session
  sshConnect: (opts: { profile: SSHProfile; cols: number; rows: number }): Promise<{ id: number }> =>
    ipcRenderer.invoke('ssh-connect', opts),

  sshDisconnect: (id: number): void =>
    ipcRenderer.send('ssh-disconnect', { id }),

  sshResize: (id: number, cols: number, rows: number): void =>
    ipcRenderer.send('ssh-resize', { id, cols, rows }),

  // File dialog
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog-open-file'),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

declare global {
  interface Window {
    electronAPI: typeof electronAPI;
  }
}
