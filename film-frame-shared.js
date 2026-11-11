/**
 * film-frame-shared.js — 135/120 画幅渲染器共享的画布基元
 *
 * 依赖顺序：本文件必须先于 film-frame-135.js 加载。
 * 只放"两个渲染器都用到的纯绘制工具"，不含任何画幅业务逻辑。
 */
(() => {
  "use strict";

  /** 读取 options.tune，缺省时回退到调用方给定的默认调参 */
  function resolveTune(options, fallbackTune) {
    return options.tune || fallbackTune;
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function deterministicNoise(seed) {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  /**
   * 片边字号核心：两个渲染器的 edgeFont/edgeFont120 仅
   * 调参键名与最小钳制值不同，统一在此计算。
   */
  function edgeFontSize(options, scale, tune, sizeKey, minRegular, minScaled) {
    const regularSize = Math.max(minRegular, Math.round(options.textH * tune[sizeKey]));
    const fontSize = Math.max(minScaled, Math.round(regularSize * scale));
    return { fontSize, font: `700 ${fontSize}px "Courier New", monospace` };
  }

  function setEdgeInk(ctx, options) {
    ctx.shadowColor = options.stock.edgeInk.glow;
    ctx.shadowBlur = 3;
    ctx.fillStyle = options.stock.edgeInk.color;
  }

  /** 条带底片圆角路径：120 幅面圆角更小，其余（含 135）走同一档 */
  function buildSingleStripPath(ctx, x, y, stripW, stripH, options) {
    const radius = options.is120
      ? Math.max(2, Math.round(options.frameW * 0.004))
      : Math.max(6, Math.round(options.frameW * 0.015));
    roundedRect(ctx, x, y, stripW, stripH, radius);
  }

  /** 条带底面：投影底层 + 渐变基色 + 斜向光泽（fill 后保持 clip 打开） */
  function beginStripSurface(ctx, x, y, stripW, stripH, options, buildPath) {
    if (options.showStripShadow !== false) {
      ctx.save();
      ctx.shadowColor = "rgba(25, 20, 12, 0.35)";
      ctx.shadowBlur = Math.round(options.frameW * 0.05);
      ctx.shadowOffsetY = Math.round(options.frameW * 0.018);
      buildPath(ctx, x, y, stripW, stripH);
      ctx.fillStyle = "#131110";
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    buildPath(ctx, x, y, stripW, stripH);
    ctx.clip();
    const baseGradient = ctx.createLinearGradient(0, y, 0, y + stripH);
    baseGradient.addColorStop(0, "#231e19");
    baseGradient.addColorStop(0.12, "#161311");
    baseGradient.addColorStop(0.5, "#191512");
    baseGradient.addColorStop(0.88, "#151210");
    baseGradient.addColorStop(1, "#241f1a");
    ctx.fillStyle = baseGradient;
    ctx.fillRect(x, y, stripW, stripH);
    const sheen = ctx.createLinearGradient(x, y, x + stripW * 0.55, y + stripH);
    sheen.addColorStop(0, "rgba(255, 250, 235, 0.05)");
    sheen.addColorStop(0.35, "rgba(255, 250, 235, 0)");
    sheen.addColorStop(0.8, "rgba(255, 250, 235, 0.025)");
    sheen.addColorStop(1, "rgba(255, 250, 235, 0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(x, y, stripW, stripH);
  }

  /** 条带收尾：闭合 beginStripSurface 的 save/clip，并描一圈高光描边 */
  function endStripSurface(ctx, x, y, stripW, stripH, options, buildPath) {
    ctx.restore();
    buildPath(ctx, x + 0.5, y + 0.5, stripW - 1, stripH - 1);
    ctx.strokeStyle = "rgba(255, 248, 230, 0.07)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** 透明示意棋盘格：18px 灰白格，按全局网格锚定，保证多处绘制对齐 */
  function fillCheckerboard(ctx, x, y, w, h) {
    const cell = 18;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#e3e1db";
    const startX = Math.floor(x / cell) * cell;
    const startY = Math.floor(y / cell) * cell;
    for (let cy = startY; cy < y + h; cy += cell) {
      for (let cx = startX; cx < x + w; cx += cell) {
        if ((Math.round(cx / cell) + Math.round(cy / cell)) % 2 !== 0) continue;
        const px = Math.max(cx, x);
        const py = Math.max(cy, y);
        const pw = Math.min(cx + cell, x + w) - px;
        const ph = Math.min(cy + cell, y + h) - py;
        ctx.fillRect(px, py, pw, ph);
      }
    }
  }

  /**
   * 按 sourceTurns 旋转绘制照片源。
   *
   * 为什么需要（2026-11-10）：
   * 之前「自动转 90°」是把位图真的转一遍、再存一份新位图。37 张 2000px 照片
   * 实测导入后常驻 611MB，其中 246MB 就是这份旋转副本 —— 同一份像素换个方向存了两份。
   * 手机浏览器进程内存上限远低于桌面，叠加导出画布后直接被系统杀进程（白屏）。
   *
   * 现在旋转只记录角度（item.sourceTurns），绘制时用变换矩阵完成，位图始终只有一份。
   * turns 为 0 时走原来的直绘路径，行为完全不变。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {CanvasImageSource} source 原始位图
   * @param {number} turns 0-3，顺时针 90° 的次数
   * @param {number} sourceWidth 原始位图宽（未旋转）
   * @param {number} sourceHeight 原始位图高（未旋转）
   * @param {{x,y,w,h}} dest 目标矩形（已按旋转后的呈现尺寸算好）
   */
  function drawRotatedSource(ctx, source, turns, sourceWidth, sourceHeight, dest) {
    const t = ((Number(turns) || 0) % 4 + 4) % 4;
    if (t === 0) {
      ctx.drawImage(source, dest.x, dest.y, dest.w, dest.h);
      return;
    }
    ctx.save();
    switch (t) {
      case 1:
        // 顺时针 90°：目标左上角 = 旋转后矩形的右上角
        ctx.translate(dest.x + dest.w, dest.y);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, dest.h, dest.w);
        break;
      case 2:
        ctx.translate(dest.x + dest.w, dest.y + dest.h);
        ctx.rotate(Math.PI);
        ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, dest.w, dest.h);
        break;
      default:
        // 逆时针 90°
        ctx.translate(dest.x, dest.y + dest.h);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, dest.h, dest.w);
        break;
    }
    ctx.restore();
  }

  window.FilmFrameShared = Object.freeze({
    resolveTune,
    roundedRect,
    deterministicNoise,
    edgeFontSize,
    setEdgeInk,
    buildSingleStripPath,
    beginStripSurface,
    endStripSurface,
    fillCheckerboard,
    drawRotatedSource,
  });
})();
