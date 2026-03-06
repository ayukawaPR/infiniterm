# infiniterm

Windows 向け Electron ターミナルエミュレーター。MSYS2 zsh・PowerShell・CMD をタブで使えます。

## 対応シェル

| シェル | アイコン | 検出パス |
|--------|---------|---------|
| zsh (MSYS2) | 🐧 | `C:\msys64\usr\bin\zsh.exe` など |
| bash (MSYS2) | 🐧 | `C:\msys64\usr\bin\bash.exe` など |
| PowerShell 7 (pwsh) | 💠 | `C:\Program Files\PowerShell\7\pwsh.exe` |
| PowerShell 5 | 🔵 | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| Command Prompt | ⬛ | `%COMSPEC%` |

インストール済みのシェルが自動検出されます。

## 主な機能

- **タブ管理** — 複数のシェルセッションをタブで切り替え
- **シェルピッカー** — `+` ボタンからシェルを選択して新規タブを開く
- **デフォルトシェル設定** — `~/.infiniterm.json` に保存、次回起動から自動適用
- **日本語対応** — UTF-8 ロケール、和文フォント対応 (Cascadia Code / MS Gothic / BIZ UDGothic)
- **tmux 互換** — `TERM=xterm-256color`、ConPTY 無効化済み
- **カラーテーマ** — Catppuccin Mocha
- **Web リンク** — URL をクリックでブラウザ起動

## 基本操作

### シェルの選択・起動

1. タブバー右端の `+` ボタンをクリック
2. シェルピッカーが開くので、使いたいシェルを左クリック → 新しいタブが開く

### デフォルトシェルの変更

シェルピッカーでシェル名を**右クリック** → 「デフォルト」バッジが付き、次回から自動選択されます。

### タブの閉じ方

- タブの `×` ボタンをクリック
- または `Ctrl+W`

## キーボードショートカット

| ショートカット | 動作 |
|--------------|------|
| `Ctrl+T` | シェルピッカーを開く |
| `Ctrl+W` | 現在のタブを閉じる |
| `Ctrl+Tab` | 次のタブへ切り替え |
| `Ctrl+Shift+Tab` | 前のタブへ切り替え |
| `Ctrl+1` 〜 `Ctrl+9` | タブ番号で直接切り替え |

## 必要環境

- Windows 10/11 (x64)
- MSYS2 を使う場合: `C:\msys64` または `D:\msys64` にインストール済みであること

## インストール

`release/` フォルダにある以下のいずれかを使用してください。

- `infiniterm Setup 0.1.0.exe` — インストーラー版 (スタートメニュー・デスクトップショートカット作成)
- `infiniterm-portable.exe` — ポータブル版 (インストール不要)

## 開発者向け

### セットアップ

```bash
npm run setup
# 内部で npm install --ignore-scripts → node-pty パッチ適用 → ネイティブリビルドを実行
```

### ビルド & 起動

```bash
npm run build   # TypeScript + webpack コンパイル
# 起動:
cmd /c "start D:\infiniterm\node_modules\.bin\electron.cmd D:\infiniterm"
# または infiniterm.bat をダブルクリック
```

### パッケージング

```bash
npm run package   # release/ にインストーラーとポータブル版を生成
```

### 技術スタック

| コンポーネント | ライブラリ |
|-------------|---------|
| アプリフレーム | Electron 28 |
| 言語 | TypeScript |
| ターミナルUI | xterm.js v5 |
| PTY (擬似端末) | @homebridge/node-pty-prebuilt-multiarch |

## ライセンス

MIT
