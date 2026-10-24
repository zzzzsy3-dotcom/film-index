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
  const BRAND_SAFETY_MM = 1;        // 布局阶段预留宽度的安全余量（量测误差兜底）

  // 品牌板字体：全部系统字体，不依赖任何外链加载（国内网络下 Google Fonts 会挂）
  const BRAND_FONT_SANS = '"Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';
  const BRAND_FONT_SERIF = 'Georgia, "Times New Roman", "Songti SC", SimSun, serif';
  const BRAND_FONT_MONO = 'Consolas, "SF Mono", Menlo, "PingFang SC", "Microsoft YaHei", monospace';

  // canvas 的 ctx.letterSpacing（字距）Safari 17.4 以下不支持 → 不支持就退化成 0 字距
  const SUPPORTS_LETTER_SPACING = (() => {
    try {
      return typeof CanvasRenderingContext2D !== "undefined"
        && "letterSpacing" in CanvasRenderingContext2D.prototype;
    } catch (e) {
      return false;
    }
  })();

  // 文字区预留宽度（按字符数估算，不依赖 canvas 测量，布局阶段就能算出）
  function estimateBrandTextWidth(baseSize) {
    return 0.55 * baseSize * BRAND_RESERVED_CHARS;
  }

  // 品牌板实际宽度要靠 canvas 量文字，布局阶段还没有画布。
  // 这里用一块离屏画布量，字体栈与绘制阶段完全一致，量出的毫米数相同。
  let brandMeasureCtx = null;
  function getBrandMeasureContext() {
    if (brandMeasureCtx !== null) return brandMeasureCtx;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      brandMeasureCtx = canvas.getContext("2d");
    } catch (e) {
      brandMeasureCtx = false;
    }
    return brandMeasureCtx;
  }

  // 品牌板的 5 行文字：布局阶段与绘制阶段共用同一份，避免两处算出不同宽度
  // font = 字族；spacing = 字距（em 倍数，相对字号）
  function buildBrandLines(frame, opts) {
    const raw = [
      { text: "FILM INDEX", weight: "700", level: 1.5, font: BRAND_FONT_SERIF, spacing: 0.02 },
      { text: (opts && opts.rollName) || "", weight: "500", level: 0.88, font: BRAND_FONT_MONO, spacing: 0.03 },
      { text: (opts && opts.dateStamp) || "", weight: "500", level: 0.88, font: BRAND_FONT_MONO, spacing: 0.03 },
      { text: "Process C41", weight: "500", level: 0.8, font: BRAND_FONT_MONO, spacing: 0.03 },
      { text: "ELLM Studio", weight: "700", level: 0.98, font: BRAND_FONT_SANS, spacing: 0.14 },
    ].filter((l) => l.text);
    return raw.map((l) => ({ ...l, size: frame.baseSize * l.level }));
  }

  // 量出品牌板内容宽度（不超过框架宽）
  // ⚠️ 自定义型号名可能很长（用户自己起名），超宽时不能硬截到框架宽 ——
  //    那样文字会压到 logo 上。这里按比例缩字号，缩到底仍超宽就加省略号截断。
  const BRAND_MIN_TEXT_SCALE = 0.72;

  function measureBrandPanel(context, frame, opts) {
    const base = buildBrandLines(frame, opts);
    if (!context) {
      const contentW = frame.reservedTextW + frame.colGap + frame.logoW + frame.padX * 2;
      return { lines: base, textW: frame.reservedTextW, panelW: Math.min(contentW, frame.frameW) };
    }

    // 文字区最多能占多宽 = 框架宽 - logo - 间距 - 内边距
    const maxTextW = Math.max(0, frame.frameW - frame.colGap - frame.logoW - frame.padX * 2);

    const measure = (line, size) => {
      context.save();
      context.textBaseline = "middle";
      context.textAlign = "left";
      context.font = `${line.weight} ${size}px ${line.font}`;
      if (SUPPORTS_LETTER_SPACING) context.letterSpacing = `${line.spacing * size}px`;
      const w = context.measureText(line.text).width;
      context.restore();
      return w;
    };

    let textW = 0;
    for (const line of base) textW = Math.max(textW, measure(line, line.size));

    // 超宽 → 整体缩字号（下限 0.72，再小就难看了）
    let scale = 1;
    if (textW > maxTextW && textW > 0) {
      scale = Math.max(BRAND_MIN_TEXT_SCALE, maxTextW / textW);
    }
    const lines = base.map((line) => ({ ...line, size: line.size * scale }));

    // 缩到底仍超宽的行 → 逐字截断加省略号
    for (const line of lines) {
      if (measure(line, line.size) > maxTextW) {
        line.text = truncateBrandLine(context, line, maxTextW);
      }
    }

    textW = 0;
    for (const line of lines) textW = Math.max(textW, measure(line, line.size));

    const contentW = textW + frame.colGap + frame.logoW + frame.padX * 2;
    return { lines, textW, panelW: Math.min(contentW, frame.frameW) };
  }

  // 逐字截断到指定宽度（加省略号）
  function truncateBrandLine(context, line, maxWidth) {
    const ELLIPSIS = "…";
    context.save();
    context.font = `${line.weight} ${line.size}px ${line.font}`;
    if (SUPPORTS_LETTER_SPACING) context.letterSpacing = `${line.spacing * line.size}px`;
    const ellipsisW = context.measureText(ELLIPSIS).width;
    let out = "";
    for (const ch of String(line.text)) {
      if (context.measureText(out + ch).width + ellipsisW > maxWidth) break;
      out += ch;
    }
    context.restore();
    return out ? out + ELLIPSIS : ELLIPSIS;
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

    // 品牌板：固定高度 12.7mm，宽度量出来（不随格子大小变）。
    // 位置规则（2026-10-24 定）：品牌板永远钉在「纸面右下角」，
    // 跟照片行数无关；照片区照常往下排，只有当末行会伸进品牌板那块矩形时，
    // 才把末行右侧相应的格子让出来。留位要求 = 不压到照片即可。
    const brandPanelH = BRAND_PANEL_H_MM * pxPerMm;
    const frame = computeBrandFrame(brandPanelH);

    // 品牌板实际宽度：布局阶段用离屏画布量（与绘制阶段同一套算法）。
    // 拿不到品牌文本（老调用点没传 brand）时退回框架宽，宁可多留也不压照片。
    const measureCtx = getBrandMeasureContext();
    const measured = options.brand && measureCtx
      ? measureBrandPanel(measureCtx, frame, options.brand)
      : { panelW: frame.frameW, lines: [], textW: 0 };
    const brandReserveW = Math.min(
      measured.panelW + BRAND_SAFETY_MM * pxPerMm,
      frame.frameW,
    );

    // 品牌区 = 纸面可用区右下角那块矩形（右贴纸边、下贴纸边）
    const brandZone = {
      x: areaX + areaW - brandReserveW,
      y: areaY + areaH - brandPanelH,
      w: brandReserveW,
      h: brandPanelH,
    };

    // ── 列数与行数求解 ────────────────────────────────────────────
    // 约束：末行必须至少 1 张照片；
    //       若末行底落进品牌区（垂直重叠），末行右侧被品牌区横向覆盖的格子
    //       必须让出来，末行照片数不能超过「末行可用格」。
    // 用户指定的列数若无解（常见于照片数恰好是列数整数倍），
    // 自动改用能放下的列数，并把实际列数回报给 UI 同步显示。

    // 品牌区横向覆盖了哪些列。
    // 网格恒为满宽（格宽 = 可用宽 / 列数），所以 gridX 恒等于 areaX，与列数无关。
    const brandCoveredCols = (cols, cw) => {
      const hits = [];
      const zoneRight = brandZone.x + brandZone.w;
      for (let c = 0; c < cols; c += 1) {
        const cx = areaX + c * (cw + gap);
        // 相交（重叠 > 0.5px 才算，避免浮点误差把相邻格也算进来）
        if (cx < zoneRight - 0.5 && cx + cw > brandZone.x + 0.5) hits.push(c);
      }
      return hits;
    };

    const solveAt = (cols) => {
      const cw = (areaW - (cols - 1) * gap) / cols;
      const ch = cw / ratio;
      if (cw * cols + (cols - 1) * gap > areaW + 0.5) return null;   // 横向放不下
      const hits = brandCoveredCols(cols, cw);
      const usableAll = cols - hits.length;
      if (usableAll < 1) return null;
      // 该列数下、可用高度内最多能放多少张（用于给用户提示）
      let maxRows = 1;
      for (let r = 1; r <= 20; r += 1) {
        if (r * ch + (r - 1) * gap > areaH + 0.5) break;
        maxRows = r;
      }
      const maxCapacity = (maxRows - 1) * cols + usableAll;
      for (let r = 1; r <= 20; r += 1) {
        const lastPhotos = itemCount - (r - 1) * cols;
        if (lastPhotos < 1) break;
        const gh = r * ch + (r - 1) * gap;
        if (gh > areaH + 0.5) break;                                 // 纵向放不下
        // 末行底有没有落进品牌区？落进去了才需要横向让位
        const rowBottom = areaY + (r - 1) * (ch + gap) + ch;
        const overlaps = rowBottom > brandZone.y + 0.5;
        const usable = overlaps ? usableAll : cols;
        if (lastPhotos <= usable) {
          return {
            columns: cols, cellW: cw, cellH: ch, rows: r, maxCapacity,
            blockedCols: overlaps ? hits : [],
          };
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
      const wusable = wanted - brandCoveredCols(wanted, wcw).length;
      let wmaxRows = 1;
      for (let r = 1; r <= 20; r += 1) {
        if (r * wch + (r - 1) * gap > areaH + 0.5) break;
        wmaxRows = r;
      }
      wantedMaxCapacity = (wmaxRows - 1) * wanted + Math.max(0, wusable);
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
      const hits = brandCoveredCols(cols, cw);
      solution = {
        columns: cols, cellW: cw, cellH: ch, rows: 2, maxCapacity: 0,
        blockedCols: hits,
      };
    }

    const { columns, cellW, cellH, rows } = solution;
    const blockedCols = solution.blockedCols || [];
    const brandSlot = blockedCols.length;
    const lastRowUsable = Math.max(0, columns - brandSlot);

    const gridW = columns * cellW + (columns - 1) * gap;
    const gridH = rows * cellH + (rows - 1) * gap;
    // 网格在可用区内水平居中、垂直居中
    const gridX = areaX + (areaW - gridW) / 2;
    // 顶对齐：留白集中到下方（品牌板那一侧），视觉上更像「排满整页」。
    // 格子宽度恒等于可用宽，横向不存在留白。
    const gridY = areaY;
    // 溢出标记：手动指定的列数放不下时，交给 UI 提示用户
    const overflow = gridH > areaH + 0.5 || gridW > areaW + 0.5;

    // 品牌板：钉死在纸面右下角（可用区右下角），跟照片行数无关。
    // zone 是布局阶段的预留矩形（含量测余量），板子画在 zone 内、右贴纸边。
    const rowBottom = gridY + (rows - 1) * (cellH + gap) + cellH;
    const brand = {
      frame,
      panelH: brandPanelH,
      // 精确宽度在绘制阶段重新量（字体度量可能与布局阶段有微小差异）
      panelW: measured.panelW,
      // 贴纸右边缘，绘制时右对齐用
      right: areaX + areaW,
      bottom: areaY + areaH,
      zone: brandZone,
      // 品牌区顶边：末行底超过它就要横向让位
      zoneTop: brandZone.y,
      rowBottom,
    };

    // 格子：末行里被品牌区横向覆盖的格子标 blocked（用列索引判定，不碰浮点）
    const blockedSet = new Set(blockedCols);
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
          blocked: r === rows - 1 && blockedSet.has(c),
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
      brandSlot,
      lastRowUsable,
      overflow,
      cells, brand,
      ratio, pxPerMm, dpi,
    };
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
  // 固定高度 12.7mm；宽度 = 实际内容宽（不超过框架宽）。
  // 位置（2026-10-24 定）：永远钉在「纸面右下角」，跟照片行数无关。
  // 底边贴纸边、右边贴纸边；板宽再窄也不会越过布局阶段预留的品牌区。
  function drawBrandPanel(context, layout, opts) {
    const brand = layout.brand;
    const frame = brand.frame;
    const panelH = brand.panelH;
    const logoValue = opts.logoValue || "full blue";
    const ink = LOGO_COLORS[logoValue] || "#000000";

    const logoImg = logoCache.get(getLogoSrc(logoValue));
    const img = logoImg && logoImg.img ? logoImg.img : null;

    // 内容：左列 5 行文字 + 右列 logo（竖向）
    // 与布局阶段共用同一份文字定义，保证量出的宽度一致
    const measured = measureBrandPanel(context, frame, opts);
    const lines = measured.lines;
    const textW = measured.textW;

    // logo 尺寸固定（由 panelH 决定）
    const logoH = frame.logoH;
    let logoW = 0;
    if (img) {
      const natW = img.naturalWidth || img.width || 1;
      const natH = img.naturalHeight || img.height || 1;
      logoW = logoH * (natW / natH);
    }

    // 实际板宽（内容真实宽度），不超过框架宽，也不超过布局预留的品牌区宽度
    const contentW = textW + frame.colGap + logoW + frame.padX * 2;
    const panelW = Math.min(contentW, frame.frameW, brand.zone.w);

    // 钉在纸面右下角：右贴纸边、底贴纸边
    const panelX = brand.right - panelW;
    const panelY = brand.bottom - panelH;

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
      context.font = `${line.weight} ${line.size}px ${line.font}`;
      if (SUPPORTS_LETTER_SPACING) context.letterSpacing = `${line.spacing * line.size}px`;
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
