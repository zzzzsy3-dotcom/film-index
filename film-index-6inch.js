/**
 * 网格索引输出引擎（多尺寸：6 寸 / 8 寸 / A4）
 *
 * 设计原则：完全复用胶卷的既有逻辑，本文件不改任何照片处理行为。
 *   - 照片源用 item.source —— 裁切（cropRect）、手动旋转（manualTurns）、
 *     EXIF 自动旋转（autoTurns）都已由 app.js 的 rebuildItemSource 烘焙进
 *     item.source，这里只读不改。
 *   - 填充方式与 FilmFrame135.getCoverPlacement 一致：Math.max 等比放大填满
 *     格子并居中裁切，不留白、不变形。
 *   - 只画照片本身，不画齿孔、不画边字框。
 *
 * 布局：
 *   - 页边距 5mm，行列间距 1.5mm
 *   - 格子比例 = 胶片画幅比例（format.ratio，如 135 全画幅 36/24 = 3:2）
 *   - 品牌板「占位」是最后一行的最后 BRAND_SLOT 格（整数格，边界对齐格线）
 *   - 品牌板「板子」高度 = 1 格高，宽度按内容自动排布，靠右贴纸边；
 *     内部文字 + logo 作为整体，以格高为基准等比缩放。
 */
(function (global) {
  "use strict";

  // ── 尺寸预设 ────────────────────────────────────────────────────────
  // 全部横向。physical = 导出时是否默认勾选「真实尺寸打印」。
  const GRID_PRESETS = {
    "6inch": { id: "6inch", name: "6 寸", w: 152, h: 102, physical: false },
    "8inch": { id: "8inch", name: "8 寸", w: 203, h: 152, physical: false },
    "a4grid": { id: "a4grid", name: "A4", w: 297, h: 210, physical: true },
  };
  const PRESET_ORDER = ["6inch", "8inch", "a4grid"];

  // ── 布局常量 ────────────────────────────────────────────────────────
  const MARGIN_MM = 5;
  const GAP_MM = 1.5;          // 行列间距
  const DEFAULT_DPI = 300;
  const MIN_COLUMNS = 4;
  const MAX_COLUMNS = 8;       // 上限 8：再密格子太小，且品牌板固定高度会顶出纸面
  const DEFAULT_RATIO = 36 / 24;

  // ── 品牌板（固定尺寸）────────────────────────────────────────────────
  // 品牌信息是一个整体：高度固定 12.7mm，宽度由「框架」决定（不随格子大小变）。
  // 这样 6 寸 / 8 寸 / A4 三种尺寸下品牌信息完全一样大。
  const BRAND_PANEL_H_MM = 12.7;    // 品牌板固定高度
  const BRAND_RESERVED_CHARS = 24;  // 文字区预留字符数（占位按此预留，保证不压照片）
  const BRAND_LINE_HEIGHT = 1.2;
  const BRAND_LEVEL_SUM = 1.5 + 1.0 + 1.0 + 0.95 + 1.12;  // 5 行文字的层级系数和

  // 文字区预留宽度（按字符数估算，不依赖 canvas 测量，布局阶段就能算出）
  function estimateBrandTextWidth(baseSize) {
    return 0.55 * baseSize * BRAND_RESERVED_CHARS;
  }

  // 品牌板「框架」：logo 宽 + 间距 + 预留文字区 + 内边距
  // 框架宽是固定的（只随缩放倍数变化），占位格数由它算出。
  function computeBrandFrame(panelHeightPx) {
    const lineGap = panelHeightPx * 0.05;
    const baseSize = Math.max(
      3,
      (panelHeightPx - lineGap * 4) / (BRAND_LEVEL_SUM * BRAND_LINE_HEIGHT),
    );
    const padX = panelHeightPx * 0.1;
    const padY = panelHeightPx * 0.08;
    const colGap = panelHeightPx * 0.12;
    const logoH = panelHeightPx - padY * 2;
    const logoW = logoH * 0.75;                 // ELLM logo 宽高比约 3:4
    const reservedTextW = estimateBrandTextWidth(baseSize);
    const frameW = reservedTextW + colGap + logoW + padX * 2;
    return { baseSize, padX, padY, colGap, logoH, logoW, reservedTextW, frameW, lineGap };
  }

  // logo 主色（与 logos/*.png 实际像素一致）
  const LOGO_COLORS = {
    "full blue": "#6090a8",
    "full black": "#000000",
    "hollow blue": "#6090a8",
    "hollow black": "#000000",
  };

  // ── logo 加载 ────────────────────────────────────────────────────────
  // 用 base64 data URL 内嵌（见 film-index-logos.js）：
  // file:// 协议下加载外部图片会污染 canvas，浏览器禁止 toBlob 导出。
  const logoCache = new Map();
  const logoPromises = new Map();

  function getLogoKey(value) {
    return String(value || "full blue").trim();
  }

  // logo 一律取 base64 内嵌版（见 film-index-logos.js）。
  // 部署目录已完全平铺，不再携带 logos/*.png —— 外链图片在 file:// 下会污染
  // canvas 导致 toBlob 失败，下面那行外链仅作理论兜底，正常不会走到。
  function getLogoSrc(value) {
    const key = getLogoKey(value);
    const embedded = global.FilmIndexLogos && global.FilmIndexLogos[key];
    return embedded || `logos/${key}.png`;
  }

  function loadLogo(value) {
    const src = getLogoSrc(value);
    if (logoCache.has(src)) return logoCache.get(src);
    const entry = { img: null, status: "loading" };
    logoCache.set(src, entry);
    const promise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { entry.img = img; entry.status = "ready"; resolve(img); };
      img.onerror = () => { entry.status = "error"; resolve(null); };
      img.src = src;
    });
    logoPromises.set(src, promise);
    return promise;
  }

  async function ensureLogoReady(value) {
    const src = getLogoSrc(value);
    await loadLogo(value);
    const p = logoPromises.get(src);
    if (p) await p;
    const entry = logoCache.get(src);
    return entry && entry.status === "ready" ? entry.img : null;
  }

  // ── 尺寸预设查询 ────────────────────────────────────────────────────
  function getPreset(id) {
    return GRID_PRESETS[id] || GRID_PRESETS["6inch"];
  }

  function isGridPreset(id) {
    return Boolean(GRID_PRESETS[id]);
  }

  // ── 布局 ────────────────────────────────────────────────────────────
  /**
   * @param {number} itemCount 照片数量
   * @param {object} opts { dpi, columns, ratio, preset }
   */
  function computeLayout(itemCount, opts) {
    const options = opts || {};
    const preset = getPreset(options.preset || "6inch");
    const dpi = options.dpi || DEFAULT_DPI;
    const pxPerMm = dpi / 25.4;
    const ratio = options.ratio > 0 ? options.ratio : DEFAULT_RATIO;

    const pageW = Math.round(preset.w * pxPerMm);
    const pageH = Math.round(preset.h * pxPerMm);
    const margin = MARGIN_MM * pxPerMm;
    const gap = GAP_MM * pxPerMm;

    const areaX = margin;
    const areaY = margin;
    const areaW = pageW - margin * 2;
    const areaH = pageH - margin * 2;

    // 品牌板固定高度 → 框架宽固定 → 占位格数 = ceil(框架宽 / 格宽)
    const brandPanelH = BRAND_PANEL_H_MM * pxPerMm;
    const frame = computeBrandFrame(brandPanelH);

    // ── 列数与行数求解 ────────────────────────────────────────────
    // 约束：末行必须至少 1 张照片（否则品牌板独占一行），
    //       且末行照片数不能超过「末行可用格 = 列数 - 品牌板占位格数」。
    // 用户指定的列数若无解（常见于照片数恰好是列数整数倍），
    // 自动改用能放下的列数，并把实际列数回报给 UI 同步显示。

    const solveAt = (cols) => {
      const cw = (areaW - (cols - 1) * gap) / cols;
      const ch = cw / ratio;
      if (cw * cols + (cols - 1) * gap > areaW + 0.5) return null;   // 横向放不下
      const sl = Math.max(1, Math.min(cols - 1, Math.ceil((frame.frameW + gap) / (cw + gap))));
      const usable = cols - sl;
      if (usable < 1) return null;
      // 该列数下、可用高度内最多能放多少张（用于给用户提示）
      let maxRows = 1;
      for (let r = 1; r <= 20; r += 1) {
        if (r * ch + (r - 1) * gap > areaH + 0.5) break;
        maxRows = r;
      }
      const maxCapacity = (maxRows - 1) * cols + usable;
      for (let r = 1; r <= 20; r += 1) {
        const lastPhotos = itemCount - (r - 1) * cols;
        if (lastPhotos >= 1 && lastPhotos <= usable) {
          const gh = r * ch + (r - 1) * gap;
          if (gh > areaH + 0.5) return null;                        // 纵向放不下
          return { columns: cols, cellW: cw, cellH: ch, slot: sl, rows: r, maxCapacity };
        }
      }
      return null;   // 该列数放不下（无「末行有照片且不超格」的解）
    };

    let solution = null;
    let wantedMaxCapacity = 0;
    if (options.columns > 0) {
      const wanted = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(options.columns)));
      solution = solveAt(wanted);
      // 记录用户所选列数的最大容量（放不下时用来提示）
      const wcw = (areaW - (wanted - 1) * gap) / wanted;
      const wch = wcw / ratio;
      const wsl = Math.max(1, Math.min(wanted - 1, Math.ceil((frame.frameW + gap) / (wcw + gap))));
      let wmaxRows = 1;
      for (let r = 1; r <= 20; r += 1) {
        if (r * wch + (r - 1) * gap > areaH + 0.5) break;
        wmaxRows = r;
      }
      wantedMaxCapacity = (wmaxRows - 1) * wanted + (wanted - wsl);
    }
    if (!solution) {
      // 自动模式（或用户列数无解）：遍历所有列数，挑「纵向填充率最高」的那个。
      // 格子宽度恒等于撑满可用宽，所以填充率 = 网格总高 / 可用高。
      // 老板要的「尽量占满整页」就是这个指标。
      let bestFill = -1;
      for (let cols = MIN_COLUMNS; cols <= MAX_COLUMNS; cols += 1) {
        const cand = solveAt(cols);
        if (!cand) continue;
        const gridH = cand.rows * cand.cellH + (cand.rows - 1) * gap;
        const fill = gridH / areaH;
        if (fill > bestFill + 1e-6 || (Math.abs(fill - bestFill) < 1e-6 && cand.cellW > solution.cellW)) {
          bestFill = fill;
          solution = cand;
        }
      }
    }
    if (!solution) {
      // 极端兜底：用用户/默认列数，只保证能算出一个布局
      const cols = options.columns > 0
        ? Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(options.columns)))
        : MIN_COLUMNS;
      const cw = (areaW - (cols - 1) * gap) / cols;
      const ch = cw / ratio;
      const sl = Math.max(1, Math.min(cols - 1, Math.ceil((frame.frameW + gap) / (cw + gap))));
      solution = { columns: cols, cellW: cw, cellH: ch, slot: sl, rows: 2, maxCapacity: 0 };
    }

    const { columns, cellW, cellH, slot, rows } = solution;
    const lastRowUsable = Math.max(0, columns - slot);

    const gridW = columns * cellW + (columns - 1) * gap;
    const gridH = rows * cellH + (rows - 1) * gap;
    // 网格在可用区内水平居中、垂直居中
    const gridX = areaX + (areaW - gridW) / 2;
    // 顶对齐：留白集中到下方（品牌板那一侧），视觉上更像「排满整页」。
    // 格子宽度恒等于可用宽，横向不存在留白。
    const gridY = areaY;
    // 溢出标记：手动指定的列数放不下时，交给 UI 提示用户
    const overflow = gridH > areaH + 0.5 || gridW > areaW + 0.5;

    // 品牌板占位区：最后一行的最后 slot 格（右侧贴纸边）
    // 板子本身宽度 = 框架宽（固定），靠右贴纸边；占位区左边多出的部分是留白。
    const slotX = gridX + (columns - slot) * (cellW + gap);
    const slotY = gridY + (rows - 1) * (cellH + gap);
    const rowBottom = gridY + (rows - 1) * (cellH + gap) + cellH;
    const slotW = slot * cellW + (slot - 1) * gap;
    const brand = {
      slotX, slotY, slotW,
      slotH: cellH,
      frame,
      panelH: brandPanelH,
      // 垂直定位：贴行底；若固定高度超过格高，则改为顶对齐向下延伸（不压上一行）
      panelY: Math.max(slotY, rowBottom - brandPanelH),
      panelX: 0,
      panelW: 0,
      rowBottom,
    };

    // 格子：品牌板占位内的格子标 blocked（用行列索引判定，不碰浮点）
    const brandStartCol = columns - slot;
    const cells = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        cells.push({
          row: r,
          col: c,
          x: gridX + c * (cellW + gap),
          y: gridY + r * (cellH + gap),
          w: cellW,
          h: cellH,
          blocked: r === rows - 1 && c >= brandStartCol,
        });
      }
    }

    return {
      presetId: preset.id,
      presetName: preset.name,
      pageWmm: preset.w,
      pageHmm: preset.h,
      pageW, pageH, margin, gap,
      canvasW: pageW,
      canvasH: pageH,
      pages: [{ y: 0, w: pageW, h: pageH }],
      areaX, areaY, areaW, areaH,
      gridX, gridY, gridW, gridH,
      columns, rows, cellW, cellH,
      actualColumns: columns,
      maxCapacity: solution.maxCapacity,
      userMaxCapacity: wantedMaxCapacity,
      brandSlot: slot,
      lastRowUsable,
      overflow,
      cells, brand,
      ratio, pxPerMm, dpi,
    };
  }

  // 选列数：格子尽量大、总高放得进可用区
  // 占位格数由品牌板框架宽动态决定（向上取整到整数格）
  function pickColumns(itemCount, areaW, areaH, gap, ratio, frameW) {
    let best = MIN_COLUMNS;
    let bestCellW = -1;
    for (let cols = MIN_COLUMNS; cols <= MAX_COLUMNS; cols += 1) {
      const cellW = (areaW - (cols - 1) * gap) / cols;
      const cellH = cellW / ratio;
      const slot = Math.max(1, Math.min(cols - 1, Math.ceil((frameW + gap) / (cellW + gap))));
      const usable = cols - slot;
      if (usable < 1) continue;
      // 找最小行数，且末行必须有照片（否则品牌板独占一行）
      let rows = 1;
      let valid = false;
      for (let r = 1; r <= 20; r += 1) {
        const lastPhotos = itemCount - (r - 1) * cols;
        if (lastPhotos >= 1 && lastPhotos <= usable) { rows = r; valid = true; break; }
      }
      if (!valid) continue;
      const gridH = rows * cellH + (rows - 1) * gap;
      if (gridH > areaH) continue;          // 放不下
      if (cellW > bestCellW) { bestCellW = cellW; best = cols; }
    }
    return bestCellW > 0 ? best : MIN_COLUMNS;
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  /**
   * @param {CanvasRenderingContext2D} context
   * @param {Array} items 已排序照片（source 已含裁切/旋转）
   * @param {object} layout computeLayout 结果
   * @param {object} opts { rollName, logoValue, dateStamp }
   */
  function draw(context, items, layout, opts) {
    let index = 0;
    for (const cell of layout.cells) {
      if (cell.blocked) continue;
      if (index >= items.length) break;
      try {
        drawPhoto(context, items[index], cell);
      } catch (error) {
        console.error("网格索引：照片绘制失败", error);
      }
      index += 1;
    }
    try {
      drawBrandPanel(context, layout, opts || {});
    } catch (error) {
      console.error("网格索引：品牌板绘制失败", error);
    }
  }

  // 照片：等比放大填满格子并居中裁切（与 FilmFrame135.getCoverPlacement 同一算法）
  function drawPhoto(context, item, cell) {
    const source = item && item.source;
    let sw = item && item.width;
    let sh = item && item.height;
    if (!source) return;
    if (!sw || !sh) {
      sw = source.naturalWidth || source.width || 0;
      sh = source.naturalHeight || source.height || 0;
    }
    if (!sw || !sh) return;

    const scale = Math.max(cell.w / sw, cell.h / sh);
    const drawW = sw * scale;
    const drawH = sh * scale;
    const drawX = cell.x + (cell.w - drawW) / 2;
    const drawY = cell.y + (cell.h - drawH) / 2;

    context.save();
    context.beginPath();
    context.rect(cell.x, cell.y, cell.w, cell.h);
    context.clip();
    try {
      context.drawImage(source, drawX, drawY, drawW, drawH);
    } catch (error) {
      console.error("网格索引：照片绘制失败", error);
    }
    context.restore();
  }

  // ── 品牌板 ──────────────────────────────────────────────────────────
  // 固定高度 12.7mm；宽度 = 实际内容宽（不超过框架宽）；靠右贴纸边。
  // 垂直：贴行底；格高不足时顶对齐向下延伸（不压上一行）。
  function drawBrandPanel(context, layout, opts) {
    const brand = layout.brand;
    const frame = brand.frame;
    const panelH = brand.panelH;
    const logoValue = opts.logoValue || "full blue";
    const ink = LOGO_COLORS[logoValue] || "#000000";

    const logoImg = logoCache.get(getLogoSrc(logoValue));
    const img = logoImg && logoImg.img ? logoImg.img : null;

    // 内容：左列 5 行文字 + 右列 logo（竖向）
    const rawLines = [
      { text: "Film Index", weight: "700", level: 1.5 },
      { text: opts.rollName || "", weight: "500", level: 1.0 },
      { text: opts.dateStamp || "", weight: "500", level: 1.0 },
      { text: "Process C41", weight: "500", level: 0.95 },
      { text: "ELLM Studio", weight: "700", level: 1.12 },
    ].filter((l) => l.text);

    // 字号按固定高度算（不随格子大小变）
    const lines = rawLines.map((l) => ({ ...l, size: frame.baseSize * l.level }));

    // 实际文字宽（用 canvas 精确测量）
    context.save();
    context.textBaseline = "middle";
    context.textAlign = "left";
    let textW = 0;
    for (const line of lines) {
      context.font = `${line.weight} ${line.size}px "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif`;
      textW = Math.max(textW, context.measureText(line.text).width);
    }
    context.restore();

    // logo 尺寸固定（由 panelH 决定）
    const logoH = frame.logoH;
    let logoW = 0;
    if (img) {
      const natW = img.naturalWidth || img.width || 1;
      const natH = img.naturalHeight || img.height || 1;
      logoW = logoH * (natW / natH);
    }

    // 实际板宽（内容真实宽度），不超过框架宽
    const contentW = textW + frame.colGap + logoW + frame.padX * 2;
    const panelW = Math.min(contentW, frame.frameW);

    // 靠右贴纸边
    const panelX = brand.slotX + brand.slotW - panelW;
    const panelY = brand.panelY;

    brand.panelW = panelW;
    brand.panelH = panelH;
    brand.panelX = panelX;
    brand.panelY = panelY;

    // 左列文字：在板内垂直居中
    const blockH = lines.reduce((sum, l) => sum + l.size * BRAND_LINE_HEIGHT, 0)
      + frame.lineGap * (lines.length - 1);
    let cursorY = panelY + (panelH - blockH) / 2;
    const textX = panelX + frame.padX;

    context.save();
    context.textBaseline = "middle";
    context.textAlign = "left";
    for (const line of lines) {
      context.font = `${line.weight} ${line.size}px "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif`;
      context.fillStyle = ink;
      context.fillText(line.text, textX, cursorY + line.size * 0.6);
      cursorY += line.size * BRAND_LINE_HEIGHT + frame.lineGap;
    }
    context.restore();

    // 右列 logo：与文字块等高，垂直居中于板
    if (img) {
      const dw = logoW;
      const dh = logoH;
      const lx = panelX + frame.padX + textW + frame.colGap;
      const ly = panelY + (panelH - dh) / 2;
      context.save();
      try {
        context.drawImage(img, lx, ly, dw, dh);
      } catch (error) {
        console.error("网格索引：logo 绘制失败", error);
      }
      context.restore();
    }
  }

  global.FilmIndex6Inch = {
    // 旧名保留（兼容 app.js 现有引用），内部已支持多尺寸
    GRID_PRESETS,
    PRESET_ORDER,
    getPreset,
    isGridPreset,
    computeLayout,
    draw,
    ensureLogoReady,
    loadLogo,
    getLogoSrc,
    LOGO_COLORS,
    MARGIN_MM,
    GAP_MM,
    BRAND_PANEL_H_MM,
    BRAND_RESERVED_CHARS,
    MAX_COLUMNS,
    PAGE_W_MM: GRID_PRESETS["6inch"].w,
    PAGE_H_MM: GRID_PRESETS["6inch"].h,
  };
})(typeof window !== "undefined" ? window : globalThis);
