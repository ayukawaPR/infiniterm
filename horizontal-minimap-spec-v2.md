# 水平ミニマップナビゲーター — 機能仕様書 v2.0

**プロジェクト名**: Horizontal Minimap Navigator — Inverse Activity Heatmap Edition  
**対象アプリ**: Electron製ZSHターミナル（xterm.js + node-pty）  
**バージョン**: 2.0.0-draft  
**更新日**: 2026-03-06  
**変更概要**: 描画方式をバッファ直接描画から「逆アクティビティヒートマップ」に全面変更

---

## 1. コンセプト

### 1.1 設計思想

「処理が終わった（静かな）場所を光らせる」

tmuxで多数のペインを並べて並列処理を走らせている状況では、**処理が完了したペインを素早く見つけることが最重要タスク**になる。

通常のヒートマップは「活発な場所を明るくする」設計だが、本機能はその**逆**を採用する。

```
更新が多い（処理中・ログ流れてる）  →  暗い（黒〜濃紺）
更新が少ない（処理完了・待機中）    →  明るい（輝く青〜白青）
```

これにより：
- ターミナル全体がほぼ暗い状態 = 全ペインが忙しい（待て）
- ミニマップのどこかが光り始める = そのペインの処理が完了した（見ろ）

という直感的なシグナルとして機能する。

### 1.2 ビジュアルイメージ

```
ミニマップ（横長）:

 ペインA      ペインB      ペインC      ペインD      ペインE
┌──────────┬──────────┬──────────┬──────────┬──────────┐
│          │░░░░░░░░░░│██████████│          │░░░░░░░░░░│
│  ██████  │░░░░░░░░░░│██████████│  ░░░░░░  │░░░░░░░░░░│  ← 暗い = 活発
│  ██████  │░░░░░░░░░░│██████████│  ░░░░░░  │░░░░░░░░░░│
│  ██████  │░░░░░░░░░░│██████████│          │░░░░░░░░░░│
│          │░░░░░░░░░░│██████████│  ✦✦✦✦✦✦  │░░░░░░░░░░│  ← 輝く = 完了
└──────────┴──────────┴──────────┴──────────┴──────────┘
      ↑            ↑           ↑           ↑
   処理完了     やや静か      激しく       完了！
  (明るく光る)              更新中      (最も明るい)
                           (最も暗い)

  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ← ビューポート枠（現在表示中の範囲）
```

カラースケール:
```
█ #0a0e1a  (黒〜深紺)    … 直近に大量更新あり（処理中）
░ #0d2137  (濃紺)        … やや更新あり
  #0a3d6b  (中紺)        … 更新が落ち着いてきた
  #1a6faf  (青)          … ほぼ静か
  #38b6ff  (明るい青)    … かなり静か
✦ #a8e6ff  (輝く水色)   … ほぼ無更新（処理完了の可能性大）
  #e8f8ff  (白青)        … 長時間完全無更新
```

---

## 2. アクティビティスコアの管理

### 2.1 スコアの定義

各「ミニマップセル（ミニマップ上の1ピクセル〜数ピクセル領域）」に対して、**アクティビティスコア**（0.0〜1.0）を管理する。

```
1.0 = 直近に激しく更新されている（最も暗い）
0.0 = 長時間まったく更新なし（最も明るい）
```

### 2.2 スコアの更新ロジック

#### 更新イベントの検出

xterm.jsの `onRender` コールバックは、変更のあった行範囲 `{start: number, end: number}` を引数として渡してくれる。これを使って「どのY行が更新されたか」を記録する。

```javascript
terminal.onRender(({ start, end }) => {
  const now = performance.now();
  for (let row = start; row <= end; row++) {
    activityMap[row] = now;  // 最終更新タイムスタンプを記録
  }
});
```

> **注意**: xterm.jsの `onRender` は行（Y軸）単位の変更範囲しか提供しない。  
> X軸（列）の粒度でのトラッキングはコストが高いため、**行単位のアクティビティ管理**を基本とする。  
> ミニマップ上でのX軸の違いはtmuxペイン境界によって自然に分かれるため、実用上は行単位で十分。

#### 時間減衰（Decay）

スコアはリアルタイムに時間減衰させる。描画フレームごとに以下を計算:

```javascript
function computeScore(lastUpdatedAt, now) {
  const age = now - lastUpdatedAt;  // 経過ミリ秒
  const decayMs = config.decayMs;   // デフォルト: 5000ms（5秒で完全減衰）

  // 指数減衰: score = e^(-age / decayMs * k)
  // age=0 → score≈1.0,  age=decayMs → score≈0.05
  const score = Math.exp(-age / decayMs * 3);
  return Math.max(0, Math.min(1, score));
}
```

**減衰曲線（decayMs=5000の場合）**:
```
経過時間    スコア    色
  0ms       1.00    ██ 黒（激しく更新中）
500ms       0.74    ░░ 濃紺
1000ms      0.55    　 中紺
2000ms      0.30    　 青
3500ms      0.12    　 明るい青
5000ms      0.05    ✦  輝く水色（ほぼ完了）
8000ms+     0.00    　 白青（完全停止）
```

### 2.3 activityMap のデータ構造

```typescript
// 行インデックス → 最終更新タイムスタンプ(ms)
type ActivityMap = Float64Array;  // terminal.rows 分の長さ

// 初期化
const activityMap = new Float64Array(terminal.rows).fill(0);
// 0 = 一度も更新されていない（最大輝度）
```

---

## 3. カラーマッピング

### 3.1 カラースケール定義

スコア（0.0〜1.0）から色へのマッピングは、グラデーションキーフレームで定義:

```javascript
const COLOR_SCALE = [
  { score: 0.00, color: [232, 248, 255] },  // #e8f8ff  白青（完全静止）
  { score: 0.08, color: [168, 230, 255] },  // #a8e6ff  輝く水色
  { score: 0.20, color:  [56, 182, 255] },  // #38b6ff  明るい青
  { score: 0.40, color:  [26, 111, 175] },  // #1a6faf  青
  { score: 0.60, color:  [10,  61, 107] },  // #0a3d6b  中紺
  { score: 0.80, color:  [13,  33,  55] },  // #0d2137  濃紺
  { score: 1.00, color:  [10,  14,  26] },  // #0a0e1a  黒
];

function scoreToColor(score) {
  // キーフレーム間を線形補間
  for (let i = 0; i < COLOR_SCALE.length - 1; i++) {
    const lo = COLOR_SCALE[i];
    const hi = COLOR_SCALE[i + 1];
    if (score >= lo.score && score <= hi.score) {
      const t = (score - lo.score) / (hi.score - lo.score);
      return [
        Math.round(lo.color[0] + (hi.color[0] - lo.color[0]) * t),
        Math.round(lo.color[1] + (hi.color[1] - lo.color[1]) * t),
        Math.round(lo.color[2] + (hi.color[2] - lo.color[2]) * t),
      ];
    }
  }
  return COLOR_SCALE[COLOR_SCALE.length - 1].color;
}
```

### 3.2 グロー効果（Glow）

スコアが低い（輝く）領域には、CSSまたはcanvasの `shadowBlur` でグロー効果を加え、「光っている感」を強調する。

```javascript
// スコアが 0.1 以下の場合にグロー
if (score < 0.1) {
  const glowIntensity = (0.1 - score) / 0.1;  // 0.0〜1.0
  ctx.shadowColor = `rgba(168, 230, 255, ${glowIntensity * 0.8})`;
  ctx.shadowBlur = glowIntensity * 8;
} else {
  ctx.shadowBlur = 0;
}
```

> **パフォーマンス注意**: `shadowBlur` はGPU負荷が高い。輝いているピクセルが少ない場合は問題ないが、広範囲が輝く状態になった場合はオフスクリーン合成を検討する。

---

## 4. 描画パイプライン

### 4.1 全体フロー

```
[xterm.js onRender イベント]
         │
         ▼
[activityMap 更新]  ← 変更行のタイムスタンプを記録
         │
         ▼ (次のrAFで)
[スコア計算]  ← 全行の (now - lastUpdated) から decay スコアを算出
         │
         ▼
[ピクセルバッファ生成]  ← scoreToColor() でRGB配列を生成
         │
         ▼
[ImageData → canvas 転送]  ← putImageData() で一括描画
         │
         ▼
[ビューポート枠を上書き描画]
         │
         ▼
[グロー後処理（オプション）]
```

### 4.2 ImageData を使った高速描画

canvasへの描画は `fillRect()` を繰り返すのではなく、ピクセルバッファを直接操作する `ImageData` を使う。

```javascript
function renderMinimap(ctx, activityMap, minimapWidth, minimapHeight, now) {
  const imageData = ctx.createImageData(minimapWidth, minimapHeight);
  const data = imageData.data;  // Uint8ClampedArray [R,G,B,A, R,G,B,A, ...]

  const rowsPerPixel = terminal.rows / minimapHeight;

  for (let py = 0; py < minimapHeight; py++) {
    // このミニマップY座標に対応するターミナル行を算出
    const termRow = Math.floor(py * rowsPerPixel);

    // 複数行をカバーする場合は平均スコアを使用
    const rowEnd = Math.floor((py + 1) * rowsPerPixel);
    let totalScore = 0;
    for (let r = termRow; r < rowEnd && r < terminal.rows; r++) {
      totalScore += computeScore(activityMap[r], now);
    }
    const avgScore = totalScore / Math.max(1, rowEnd - termRow);
    const [r, g, b] = scoreToColor(avgScore);

    // この行の全ピクセルに同じ色を設定
    for (let px = 0; px < minimapWidth; px++) {
      // X軸は現在は均一（将来的にはX軸解像度も実装可能）
      const idx = (py * minimapWidth + px) * 4;
      data[idx + 0] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}
```

> **将来拡張**: X軸（列）方向の解像度を追加する場合、`activityMap` を `Float64Array(rows * cols)` の2次元マップに拡張し、`onRender` の代わりにカスタムパーサーで変更セルを追跡する。

### 4.3 描画ループ

```javascript
let animFrameId = null;

function startRenderLoop() {
  function frame() {
    const now = performance.now();
    renderMinimap(ctx, activityMap, minimapWidth, minimapHeight, now);
    renderViewportIndicator(ctx, ...);
    animFrameId = requestAnimationFrame(frame);
  }
  animFrameId = requestAnimationFrame(frame);
}

function stopRenderLoop() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
}
```

**フレームレートの考え方**:
- ヒートマップは時間減衰が主なアニメーション要素（静かにフェードする）
- 60fps での描画は過剰な場合もある → `performance.now()` の差分で自前でスロットリング可能
- 推奨: **20fps**（50ms間隔）でも視覚的に十分滑らか

```javascript
const TARGET_FPS = 20;
const FRAME_MS = 1000 / TARGET_FPS;
let lastFrameTime = 0;

function frame(timestamp) {
  animFrameId = requestAnimationFrame(frame);
  if (timestamp - lastFrameTime < FRAME_MS) return;
  lastFrameTime = timestamp;
  // ... 描画処理
}
```

---

## 5. インタラクション仕様

（v1.0から変更なし。以下に再掲）

### 5.1 ビューポート枠

```javascript
const viewportBox = {
  x:      (scrollX / virtualWidth)  * minimapWidth,
  width:  (viewWidth / virtualWidth) * minimapWidth,
  y:      0,
  height: minimapHeight,
};

// ビューポート枠のスタイル（ヒートマップ背景に映えるよう白系に）
ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
ctx.lineWidth = 1.5;
ctx.strokeRect(viewportBox.x, viewportBox.y, viewportBox.width, viewportBox.height);
// 枠内を薄く塗りつぶし
ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
ctx.fillRect(viewportBox.x, viewportBox.y, viewportBox.width, viewportBox.height);
```

### 5.2 マウスインタラクション

| 操作 | 動作 |
|------|------|
| クリック | クリック位置がビューポート中央になるようスムーススクロール |
| ドラッグ | ビューポート枠をリアルタイム移動（メインビューも追従） |
| ホイール | メインビューを水平スクロール（倍率: ×3） |
| ホバー | ミニマップの不透明度 0.7 → 1.0 |

### 5.3 ツールチップ（オプション）

ミニマップ上でホバーした位置に対応するターミナル列番号と、その位置の「最終更新からの経過時間」をツールチップ表示する。

```
┌─────────────────┐
│ col: 240        │
│ last update: 3s ago │
└─────────────────┘
```

---

## 6. 仮想幅の拡張操作

ウィンドウ外にはマウスでドラッグできないため、「仮想幅をウィンドウ幅より広げる」操作はウィンドウ内で完結する必要がある。以下の2方式を組み合わせて採用する。

### 6.1 ミニマップ端ドラッグ（マウス操作）

ミニマップの右端に **幅変更ハンドル** を常時表示する。

```
通常状態（仮想幅 = ウィンドウ幅）:
┌─────────────────────────────────┬──┐
│  minimap（ビューポート = 全体）   │⟩⟩│ ← ハンドル（常時表示）
└─────────────────────────────────┴──┘

拡張後（仮想幅 > ウィンドウ幅）:
┌─────────────────────────────────┬──┐
│  [==viewport==]................  │⟩⟩│
└─────────────────────────────────┴──┘
     ↑ビューポート枠    ↑仮想領域
```

#### ハンドルの仕様

| 項目 | 仕様 |
|------|------|
| 位置 | ミニマップ右端、高さ全体 |
| 幅 | 12px |
| 通常時 | `⟩⟩` アイコン、`rgba(255,255,255,0.3)` |
| ホバー時 | `rgba(255,255,255,0.7)`、カーソル `col-resize` |
| ドラッグ中 | リアルタイムで仮想幅を更新、cols値をオーバーレイ表示 |

#### ドラッグ操作のロジック

```javascript
// ハンドルのドラッグ開始
handle.addEventListener('mousedown', (e) => {
  const startX = e.clientX;
  const startVirtualWidth = virtualWidth;  // 現在の仮想幅(px)

  function onMouseMove(e) {
    const delta = e.clientX - startX;
    // 最小幅 = ウィンドウ幅、最大幅 = ウィンドウ幅 × 8
    const newWidth = Math.max(
      viewWidth,
      Math.min(viewWidth * 8, startVirtualWidth + delta)
    );
    setVirtualWidth(newWidth);
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    // PTY をリサイズ（cols 単位に丸める）
    applyVirtualWidthToPty();
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});
```

#### 仮想幅をウィンドウ幅に戻す

ハンドルを**ダブルクリック**すると仮想幅をウィンドウ幅にリセットする。

---

### 6.2 キーボードショートカット（キーボード操作）

| ショートカット | 動作 |
|--------------|------|
| `Ctrl+Shift+→` | 仮想幅を +40cols 拡張 |
| `Ctrl+Shift+←` | 仮想幅を -40cols 縮小（最小 = ウィンドウ幅） |
| `Ctrl+Shift+0` | 仮想幅をウィンドウ幅にリセット |

操作時、現在の仮想幅を **一時オーバーレイ** でターミナル右上に1秒間表示する。

```
┌─────────────────────────────────────────┐
│  terminal content                 ╔════╗ │
│                                   ║320 ║ │  ← 「320cols」を1秒表示して消える
│                                   ╚════╝ │
└─────────────────────────────────────────┘
```

```javascript
// キーボードショートカット
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey) return;

  const step = 40;  // 1操作あたりの変化量 (cols)
  const colWidth = terminal.cols / virtualWidth * viewWidth;  // px/col

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    setVirtualWidth(virtualWidth + step * colWidth);
    showWidthOverlay();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    setVirtualWidth(Math.max(viewWidth, virtualWidth - step * colWidth));
    showWidthOverlay();
  } else if (e.key === '0') {
    e.preventDefault();
    setVirtualWidth(viewWidth);
    showWidthOverlay();
  }
});

let overlayTimer = null;
function showWidthOverlay() {
  const cols = Math.round(virtualWidth / viewWidth * terminal.cols);
  overlay.textContent = `${cols} cols`;
  overlay.classList.add('visible');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => overlay.classList.remove('visible'), 1000);
}
```

---

### 6.3 仮想幅の状態管理

```typescript
interface VirtualWidthState {
  virtualWidth: number;   // 仮想幅 (px)。viewWidth 以上
  viewWidth: number;      // 実際のウィンドウ幅 (px)
  scrollX: number;        // 水平スクロール位置 (px)。0 〜 virtualWidth - viewWidth
}

function setVirtualWidth(newWidth: number): void {
  state.virtualWidth = Math.max(state.viewWidth, newWidth);
  // スクロール位置が範囲外になった場合はクランプ
  state.scrollX = Math.min(state.scrollX, state.virtualWidth - state.viewWidth);
  // PTY cols の更新は確定時（mouseup / キー操作完了）のみ行う
}

function applyVirtualWidthToPty(): void {
  const newCols = Math.round(state.virtualWidth / state.viewWidth * terminal.cols);
  window.electronAPI.resize(ptyId, newCols, terminal.rows);
}
```

**PTY リサイズのタイミング**:
- ドラッグ中はミニマップとビューポートのみ更新（PTY は触らない）
- `mouseup` またはキー操作完了時に PTY へ反映（過剰なリサイズを防ぐ）

---

## 7. 設定項目

```json
{
  "minimap": {
    "enabled": true,
    "height": 80,
    "targetFps": 20,
    "decayMs": 5000,
    "glowEffect": true,
    "colorScale": "default",
    "viewportBorderColor": "rgba(255,255,255,0.6)",
    "showTooltip": true
  }
}
```

| パラメータ | デフォルト | 説明 |
|-----------|-----------|------|
| `height` | `80` | ミニマップの高さ(px) |
| `targetFps` | `20` | 描画フレームレート |
| `decayMs` | `5000` | スコアが 1.0→0.05 に減衰するまでの時間(ms) |
| `glowEffect` | `true` | 輝くエリアのグロー効果 |
| `colorScale` | `"default"` | カラースケール（将来カスタム対応） |

---

## 8. コンポーネント設計

```
HorizontalMinimap
  ├── ActivityTracker      ← onRender をフックして activityMap を更新
  ├── DecayEngine          ← 時間経過によるスコア計算
  ├── HeatmapRenderer      ← ImageData による高速canvas描画
  ├── GlowPostProcessor    ← 低スコア領域へのグロー合成（オプション）
  ├── ViewportIndicator    ← ビューポート枠の描画
  ├── InteractionHandler   ← マウスイベント → スクロール同期
  ├── VirtualWidthHandle   ← ミニマップ端ドラッグによる仮想幅変更
  └── WidthOverlay         ← キーボード操作時の一時cols表示
```

---

## 9. v1.0 との差分まとめ

| 項目 | v1.0（バッファ描画） | v2.0（逆ヒートマップ） |
|------|---------------------|----------------------|
| 描画内容 | ターミナルの文字・色 | アクティビティの時間減衰スコア |
| 描画負荷 | 高（全セル走査） | 低（行単位スコアのみ） |
| 情報量 | どこに何が表示されているか | どこが静か（完了）か |
| ユースケース | 内容の確認 | 処理完了の検知 |
| 実装難易度 | 中〜高 | 低〜中 |
| 視覚的インパクト | 中 | 高（輝く青が映える） |

---

## 10. 実装フェーズ

### Phase 1: MVP
- [ ] `ActivityTracker`: `onRender` フックと `activityMap` の管理
- [ ] `DecayEngine`: 指数減衰スコア計算
- [ ] `HeatmapRenderer`: `ImageData` による基本描画（グローなし）
- [ ] `ViewportIndicator`: ビューポート枠
- [ ] クリックでスクロール

### Phase 2: インタラクション
- [ ] ドラッグ・ホイールスクロール
- [ ] ホバー時の不透明度変化
- [ ] ツールチップ
- [ ] ミニマップ端ドラッグによる仮想幅変更（`VirtualWidthHandle`）
- [ ] `Ctrl+Shift+→/←/0` による仮想幅変更 + `WidthOverlay`

### Phase 3: 視覚品質
- [ ] グロー後処理
- [ ] `decayMs` のリアルタイム調整UI（スライダー）
- [ ] カラースケールの選択肢追加

### Phase 4: 将来拡張
- [ ] X軸（列）解像度への対応
- [ ] 「N秒以上静止しているペイン」のアラート通知
- [ ] tmuxペイン境界との重ね合わせ表示

---

## 11. 参考

- [xterm.js ITerminalOptions.onRender](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts)
- [MDN ImageData API](https://developer.mozilla.org/en-US/docs/Web/API/ImageData)
- [指数減衰 — Wikipedia](https://en.wikipedia.org/wiki/Exponential_decay)
