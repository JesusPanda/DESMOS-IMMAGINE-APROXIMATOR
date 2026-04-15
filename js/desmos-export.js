/**
 * desmos-export.js
 * ================
 * Converts fitted shapes (circles, ellipses, Bézier curves, lines)
 * into Desmos-compatible equation strings.
 *
 * Handles coordinate transformation from image space (top-left, y-down)
 * to Desmos/math space (centered, y-up).
 */

'use strict';

const DesmosExport = (() => {

  // Precision for exported numbers
  const PRECISION = 3;

  function fmt(n) {
    return Number(n.toFixed(PRECISION));
  }

  // Sign-aware formatting for addition in equations
  function fmtSign(n) {
    const v = fmt(n);
    return v >= 0 ? `+ ${v}` : `- ${Math.abs(v)}`;
  }

  /**
   * Create coordinate transformer: image coords → Desmos coords
   * Centers the image and flips Y axis.
   * @param {number} imgWidth
   * @param {number} imgHeight
   * @param {number} scale - scale factor (default: fit to ~20 unit range)
   */
  function createTransformer(imgWidth, imgHeight, scale) {
    if (!scale) {
      // Scale so the larger dimension fits in ~20 units
      scale = 20 / Math.max(imgWidth, imgHeight);
    }
    const cx = imgWidth / 2;
    const cy = imgHeight / 2;

    return {
      x: (ix) => fmt((ix - cx) * scale),
      y: (iy) => fmt((cy - iy) * scale), // flip Y
      scale: scale,
      // Transform a point
      pt: (p) => ({ x: fmt((p.x - cx) * scale), y: fmt((cy - p.y) * scale) }),
      // Inverse transforms: Desmos → image (full precision, no rounding)
      invX: (dx) => dx / scale + cx,
      invY: (dy) => cy - dy / scale
    };
  }

  /**
   * Convert a shape to a Desmos equation string.
   * @param {object} shape - from CurveFitter
   * @param {object} tx - transformer from createTransformer
   * @returns {string} Desmos LaTeX equation
   */
  function shapeToDesmos(shape, tx) {
    switch (shape.type) {
      case 'circle':
        return circleToDesmos(shape, tx);
      case 'ellipse':
        return ellipseToDesmos(shape, tx);
      case 'line':
        return lineToDesmos(shape, tx);
      case 'bezier':
        return bezierToDesmos(shape, tx);
      default:
        return null;
    }
  }

  function circleToDesmos(shape, tx) {
    const h = tx.x(shape.cx);
    const k = tx.y(shape.cy);
    const r = fmt(shape.r * tx.scale);

    // (x - h)^2 + (y - k)^2 = r^2
    let xPart, yPart;

    if (h === 0) xPart = 'x^{2}';
    else xPart = `\\left(x - ${fmt(h)}\\right)^{2}`;

    if (k === 0) yPart = 'y^{2}';
    else yPart = `\\left(y - ${fmt(k)}\\right)^{2}`;

    return `${xPart} + ${yPart} = ${fmt(r * r)}`;
  }

  function ellipseToDesmos(shape, tx) {
    const h = tx.x(shape.cx);
    const k = tx.y(shape.cy);
    const a = fmt(shape.a * tx.scale);
    const b = fmt(shape.b * tx.scale);
    const angle = shape.angle;

    if (Math.abs(angle) < 0.05) {
      // Axis-aligned ellipse
      let xPart = h === 0 ? 'x' : `\\left(x - ${fmt(h)}\\right)`;
      let yPart = k === 0 ? 'y' : `\\left(y - ${fmt(k)}\\right)`;
      return `\\frac{${xPart}^{2}}{${fmt(a * a)}} + \\frac{${yPart}^{2}}{${fmt(b * b)}} = 1`;
    }

    // Rotated ellipse: parametric form
    // Note: Desmos angle is negated because we flipped Y
    const cosA = fmt(Math.cos(-angle));
    const sinA = fmt(Math.sin(-angle));

    const xExpr = `${fmt(h)} + ${fmt(a)} \\cos(t) \\cdot ${cosA} - ${fmt(b)} \\sin(t) \\cdot ${sinA}`;
    const yExpr = `${fmt(k)} + ${fmt(a)} \\cos(t) \\cdot ${sinA} + ${fmt(b)} \\sin(t) \\cdot ${cosA}`;

    return `\\left(${xExpr}, ${yExpr}\\right)`;
  }

  function lineToDesmos(shape, tx) {
    const p1 = tx.pt({ x: shape.x1, y: shape.y1 });
    const p2 = tx.pt({ x: shape.x2, y: shape.y2 });

    const dx = fmt(p2.x - p1.x);
    const dy = fmt(p2.y - p1.y);

    // Parametric: (x1 + t*dx,  y1 + t*dy) for 0 ≤ t ≤ 1
    const xExpr = dx === 0 ? `${p1.x}` : dx < 0 ? `${p1.x} - ${Math.abs(dx)}t` : `${p1.x} + ${dx}t`;
    const yExpr = dy === 0 ? `${p1.y}` : dy < 0 ? `${p1.y} - ${Math.abs(dy)}t` : `${p1.y} + ${dy}t`;

    return `\\left(${xExpr}, ${yExpr}\\right)`;
  }

  function bezierToDesmos(shape, tx) {
    const p0 = tx.pt(shape.p0);
    const p1 = tx.pt(shape.p1);
    const p2 = tx.pt(shape.p2);
    const p3 = tx.pt(shape.p3);

    // Cubic Bezier:
    // B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
    // Expand to polynomial in t:
    // B(t) = P0 + (-3P0 + 3P1)t + (3P0 - 6P1 + 3P2)t^2 + (-P0 + 3P1 - 3P2 + P3)t^3

    const ax = fmt(-p0.x + 3 * p1.x - 3 * p2.x + p3.x);
    const bx = fmt(3 * p0.x - 6 * p1.x + 3 * p2.x);
    const cx = fmt(-3 * p0.x + 3 * p1.x);
    const dx = p0.x;

    const ay = fmt(-p0.y + 3 * p1.y - 3 * p2.y + p3.y);
    const by = fmt(3 * p0.y - 6 * p1.y + 3 * p2.y);
    const cy = fmt(-3 * p0.y + 3 * p1.y);
    const dy = p0.y;

    // Build polynomial expression
    const xExpr = buildPoly(ax, bx, cx, dx);
    const yExpr = buildPoly(ay, by, cy, dy);

    return `\\left(${xExpr}, ${yExpr}\\right)`;
  }

  /**
   * Build a polynomial expression string: a*t^3 + b*t^2 + c*t + d
   * Omits zero terms for cleaner output.
   */
  function buildPoly(a, b, c, d) {
    const terms = [];

    if (a !== 0) {
      if (a === 1) terms.push('t^{3}');
      else if (a === -1) terms.push('-t^{3}');
      else terms.push(`${fmt(a)}t^{3}`);
    }

    if (b !== 0) {
      const bStr = b === 1 ? 't^{2}' : b === -1 ? '-t^{2}' : `${fmt(b)}t^{2}`;
      if (terms.length > 0 && b > 0) terms.push(`+ ${bStr}`);
      else terms.push(bStr);
    }

    if (c !== 0) {
      const cStr = c === 1 ? 't' : c === -1 ? '-t' : `${fmt(c)}t`;
      if (terms.length > 0 && c > 0) terms.push(`+ ${cStr}`);
      else terms.push(cStr);
    }

    if (d !== 0 || terms.length === 0) {
      if (terms.length > 0 && d > 0) terms.push(`+ ${fmt(d)}`);
      else terms.push(`${fmt(d)}`);
    }

    return terms.join(' ');
  }

  /**
   * Convert all shapes to Desmos equations.
   * @param {Array} shapes - array of shape objects from CurveFitter
   * @param {number} imgWidth
   * @param {number} imgHeight
   * @returns {{ equations: string[], transformer: object }}
   */
  function exportAll(shapes, imgWidth, imgHeight) {
    const tx = createTransformer(imgWidth, imgHeight);
    const equations = [];

    for (const shape of shapes) {
      const eq = shapeToDesmos(shape, tx);
      if (eq) equations.push(eq);
    }

    return { equations, transformer: tx };
  }

  /**
   * Generate a plain-text export of all equations (for copy/download).
   */
  function toPlainText(equations) {
    return equations.join('\n');
  }

  /**
   * Generate Desmos API expression objects.
   * @param {string[]} equations
   * @returns {Array<{latex: string, color: string}>}
   */
  function toDesmosExpressions(equations) {
    // Use a consistent dark color for sketch-like appearance
    const colors = [
      '#2d70b3', // Desmos blue
      '#388c46', // green
      '#fa7e19', // orange
      '#6042a6', // purple
      '#c74440', // red
      '#000000', // black
    ];

    return equations.map((latex, i) => ({
      id: `eq_${i}`,
      latex: latex,
      color: colors[i % colors.length],
      lineWidth: 2
    }));
  }

  // =========================================================
  //  Regression equation export
  // =========================================================

  /**
   * Convert a regression fit result to a Desmos LaTeX equation.
   * The fit should contain normCoeffs, center, halfRange, orientation,
   * domainMin, domainMax — all in Desmos coordinate space.
   */
  function regressionToDesmos(fit) {
    const P = 4; // higher precision for regression
    const f = (n) => Number(n.toFixed(P));

    const iv = fit.orientation === 'vertical' ? 'y' : 'x';  // independent
    const dv = fit.orientation === 'vertical' ? 'x' : 'y';  // dependent

    // Build the normalized variable: (iv − center) / halfRange
    const cSign = fit.center >= 0 ? '-' : '+';
    const cAbs = f(Math.abs(fit.center));
    const uBase = `\\frac{${iv} ${cSign} ${cAbs}}{${f(fit.halfRange)}}`;

    // Build polynomial terms
    const parts = [];
    for (let k = 0; k < fit.normCoeffs.length; k++) {
      const c = f(fit.normCoeffs[k]);
      if (c === 0) continue;

      if (k === 0) {
        parts.push(`${c}`);
      } else if (k === 1) {
        parts.push(`${c} \\cdot ${uBase}`);
      } else {
        parts.push(`${c} \\left(${uBase}\\right)^{${k}}`);
      }
    }

    if (parts.length === 0) parts.push('0');

    // Join with '+', then fix adjacent '+ -' into '- '
    const poly = parts.join(' + ').replace(/\+ -/g, '- ');

    // Domain restriction
    const lo = f(fit.domainMin);
    const hi = f(fit.domainMax);
    const domain = `\\left\\{${lo} \\le ${iv} \\le ${hi}\\right\\}`;

    return `${dv} = ${poly} ${domain}`;
  }

  return {
    exportAll,
    shapeToDesmos,
    regressionToDesmos,
    createTransformer,
    toPlainText,
    toDesmosExpressions
  };

})();
