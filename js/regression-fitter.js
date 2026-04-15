/**
 * regression-fitter.js
 * ====================
 * Polynomial regression fitting for contour point groups.
 *
 * Uses:
 *  - Uniform arc-length sampling from contours
 *  - Center+scale normalized least-squares polynomial fitting
 *  - Auto-orientation detection (y=f(x) vs x=f(y))
 *  - Gaussian elimination with partial pivoting
 */

'use strict';

const RegressionFitter = (() => {

  // =========================================================
  //  Point sampling (curvature-adaptive)
  // =========================================================

  /**
   * Sample N points along a contour, concentrating samples where
   * the edge curves more and using fewer on straight sections.
   *
   * Uses a cumulative "importance" metric that blends arc length
   * with local curvature:
   *   weight_i = segLen_i * (1 + curvature_i * CURV_WEIGHT)
   *
   * Straight sections (curvature ≈ 0) get baseline arc-length
   * density. Sharp curves get up to ~10× more samples.
   *
   * @param {Array<{x,y}>} contour - ordered contour points
   * @param {number} count - number of samples
   * @returns {Array<{x,y}>}
   */
  function samplePoints(contour, count) {
    if (contour.length <= count) return contour.slice();
    if (count < 2) return [contour[0], contour[contour.length - 1]];

    const n = contour.length;

    // --- Step 1: Compute smoothed curvature at each point -----------
    // Use a window of ±w to reduce pixel-level noise
    const w = Math.max(1, Math.min(4, Math.floor(n / 30)));
    const curvature = new Float64Array(n); // default 0

    for (let i = w; i < n - w; i++) {
      const ax = contour[i].x - contour[i - w].x;
      const ay = contour[i].y - contour[i - w].y;
      const bx = contour[i + w].x - contour[i].x;
      const by = contour[i + w].y - contour[i].y;

      // Angle between incoming and outgoing vectors
      const cross = ax * by - ay * bx;
      const dot   = ax * bx + ay * by;
      curvature[i] = Math.abs(Math.atan2(cross, dot));
    }

    // --- Step 2: Build cumulative importance -----------------------
    // weight = segLen * (1 + avgCurvature * CURV_WEIGHT)
    // Straight → weight ≈ segLen
    // 90° turn → weight ≈ segLen × 9
    const CURV_WEIGHT = 5;
    const importance = [0];

    for (let i = 1; i < n; i++) {
      const segLen = Math.hypot(
        contour[i].x - contour[i - 1].x,
        contour[i].y - contour[i - 1].y
      );
      const avgCurv = (curvature[i - 1] + curvature[i]) / 2;
      const weight = segLen * (1 + avgCurv * CURV_WEIGHT);
      importance.push(importance[i - 1] + weight);
    }

    const total = importance[n - 1];
    if (total < 1e-6) return [contour[0]];

    // --- Step 3: Sample uniformly along importance ----------------
    const sampled = [];
    let j = 0;
    for (let s = 0; s < count; s++) {
      const target = (s / (count - 1)) * total;
      while (j < n - 2 && importance[j + 1] < target) j++;
      const seg = importance[j + 1] - importance[j];
      const t = seg > 0 ? (target - importance[j]) / seg : 0;
      sampled.push({
        x: contour[j].x + t * (contour[j + 1].x - contour[j].x),
        y: contour[j].y + t * (contour[j + 1].y - contour[j].y)
      });
    }
    return sampled;
  }

  // =========================================================
  //  Orientation detection
  // =========================================================

  /**
   * Determine if points spread more horizontally or vertically.
   * 'horizontal' ⇒ y = f(x) ;  'vertical' ⇒ x = f(y)
   */
  function orientation(points) {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of points) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    return (xMax - xMin) >= (yMax - yMin) ? 'horizontal' : 'vertical';
  }

  // =========================================================
  //  Polynomial fitting
  // =========================================================

  /**
   * Fit a polynomial of given degree using normalized least squares.
   * Returns coefficients in normalized space ((x − center)/halfRange)
   * along with normalization parameters.
   *
   * @param {Array<{x,y}>} points - must be sorted by x (or will be)
   * @param {number} degree - polynomial degree (1..8)
   * @returns {{ normCoeffs: number[], center: number, halfRange: number,
   *             minX: number, maxX: number, degree: number, rSquared: number } | null}
   */
  function polyFit(points, degree) {
    const n = points.length;
    const d = Math.min(degree, n - 1);
    if (d < 1 || n < 2) return null;

    // Normalization: u = (x − center) / halfRange  ∈ [−1, 1]
    let minX = Infinity, maxX = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
    const center = (minX + maxX) / 2;
    const halfRange = (maxX - minX) / 2 || 1;

    const m = d + 1; // number of coefficients

    // Build normal equations  X^ᵀ X a = X^ᵀ y
    const XtX = Array.from({ length: m }, () => new Float64Array(m));
    const Xty = new Float64Array(m);

    for (const p of points) {
      const u = (p.x - center) / halfRange;
      // Pre-compute powers up to 2d
      const pows = new Float64Array(2 * d + 1);
      pows[0] = 1;
      for (let k = 1; k <= 2 * d; k++) pows[k] = pows[k - 1] * u;

      for (let i = 0; i < m; i++) {
        for (let j = i; j < m; j++) XtX[i][j] += pows[i + j];
        Xty[i] += pows[i] * p.y;
      }
    }
    // Symmetric
    for (let i = 0; i < m; i++)
      for (let j = 0; j < i; j++)
        XtX[i][j] = XtX[j][i];

    const coeffs = solve(XtX, Xty, m);
    if (!coeffs) return null;

    // R²
    let meanY = 0;
    for (const p of points) meanY += p.y;
    meanY /= n;

    let ssRes = 0, ssTot = 0;
    for (const p of points) {
      const u = (p.x - center) / halfRange;
      let yp = 0, uk = 1;
      for (let k = 0; k <= d; k++) { yp += coeffs[k] * uk; uk *= u; }
      ssRes += (p.y - yp) ** 2;
      ssTot += (p.y - meanY) ** 2;
    }

    return {
      normCoeffs: Array.from(coeffs),
      center,
      halfRange,
      minX,
      maxX,
      degree: d,
      rSquared: ssTot > 0 ? 1 - ssRes / ssTot : 0
    };
  }

  // =========================================================
  //  Gaussian elimination (partial pivoting)
  // =========================================================

  function solve(A, b, n) {
    // Augmented matrix
    const M = Array.from({ length: n }, (_, i) => {
      const row = new Float64Array(n + 1);
      for (let j = 0; j < n; j++) row[j] = A[i][j];
      row[n] = b[i];
      return row;
    });

    for (let c = 0; c < n; c++) {
      // Partial pivot
      let best = c;
      for (let r = c + 1; r < n; r++)
        if (Math.abs(M[r][c]) > Math.abs(M[best][c])) best = r;
      [M[c], M[best]] = [M[best], M[c]];

      if (Math.abs(M[c][c]) < 1e-14) return null;

      // Forward elimination
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
      }
    }

    // Back substitution
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      x[i] = M[i][n];
      for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
      x[i] /= M[i][i];
    }
    return x;
  }

  // =========================================================
  //  Evaluation
  // =========================================================

  /**
   * Evaluate the polynomial at x given a fit result.
   */
  function evaluate(fit, x) {
    const u = (x - fit.center) / fit.halfRange;
    let y = 0, uk = 1;
    for (let k = 0; k < fit.normCoeffs.length; k++) {
      y += fit.normCoeffs[k] * uk;
      uk *= u;
    }
    return y;
  }

  // =========================================================
  //  Group fitting (auto-orientation)
  // =========================================================

  /**
   * Fit a curve to a group of points, choosing the best orientation.
   * Points should already be in the desired output coordinate system
   * (e.g. Desmos coords for equation export).
   *
   * @param {Array<{x,y}>} points
   * @param {number} degree
   * @returns {object|null} fit result with .orientation field
   */
  function fitGroup(points, degree) {
    if (points.length < 2) return null;

    const dir = orientation(points);

    // If vertical, swap x↔y so independent variable has wider spread
    const pts = dir === 'vertical'
      ? points.map(p => ({ x: p.y, y: p.x }))
      : points.slice();

    // Sort by independent variable
    pts.sort((a, b) => a.x - b.x);

    const fit = polyFit(pts, degree);
    if (!fit) return null;

    return {
      ...fit,
      orientation: dir,
      domainMin: fit.minX,
      domainMax: fit.maxX
    };
  }

  // =========================================================
  //  Adaptive piecewise regression
  // =========================================================

  /**
   * Compute the maximum absolute residual of a fit against the
   * original (un-swapped) points, respecting orientation.
   *
   * @param {Array<{x,y}>} points - in original coordinate space
   * @param {object} fit - result from fitGroup (has .orientation)
   * @returns {number}
   */
  function maxResidual(points, fit) {
    let maxErr = 0;
    const isVert = fit.orientation === 'vertical';
    for (const p of points) {
      const indep = isVert ? p.y : p.x;
      const dep   = isVert ? p.x : p.y;
      const predicted = evaluate(fit, indep);
      const err = Math.abs(dep - predicted);
      if (err > maxErr) maxErr = err;
    }
    return maxErr;
  }

  /**
   * Adaptively fit a sequence of continuous points using the
   * fewest, lowest-degree polynomial segments possible.
   *
   * Algorithm:
   *  1. Start at point i, try extending the segment to include
   *     as many consecutive points as possible.
   *  2. At each extension attempt, try the lowest degree first
   *     (1 = line, then 2 = quadratic, up to maxDegree).
   *  3. If the max residual for that degree is ≤ tolerance,
   *     accept the extension and keep going.
   *  4. When no degree can keep the residual under tolerance,
   *     finalize the segment with the last known good fit and
   *     start a new segment overlapping by 1 point.
   *
   * @param {Array<{x,y}>} points - ordered, in Desmos coords
   * @param {number} maxDegree - ceiling polynomial degree (1–8)
   * @param {number} tolerance - max allowed residual in Desmos units
   * @returns {Array<object>} array of fit results from fitGroup
   */
  function adaptiveFitContour(points, maxDegree, tolerance) {
    if (points.length < 2) return [];

    const segments = [];
    let i = 0;

    while (i < points.length - 1) {
      // Bootstrap: the first 2 points always form a perfect line
      let bestEnd = Math.min(i + 2, points.length);
      let bestFit = fitGroup(points.slice(i, bestEnd), 1);

      // Greedily extend the segment
      for (let end = i + 3; end <= points.length; end++) {
        const chunk = points.slice(i, end);
        let foundGoodFit = false;

        // Try lowest degree first → fewest equations
        const dCeil = Math.min(maxDegree, chunk.length - 1);
        for (let d = 1; d <= dCeil; d++) {
          const fit = fitGroup(chunk, d);
          if (!fit) continue;

          if (maxResidual(chunk, fit) <= tolerance) {
            bestEnd = end;
            bestFit = fit;
            foundGoodFit = true;
            break; // lowest degree that works → done
          }
        }

        // If even maxDegree can't fit, stop extending
        if (!foundGoodFit) break;
      }

      if (bestFit) {
        segments.push(bestFit);
      }

      // Advance — overlap by 1 point for C0 continuity
      const nextI = bestEnd - 1;
      // Safety: always advance at least 1 to avoid infinite loop
      i = nextI > i ? nextI : i + 1;
    }

    return segments;
  }

  // =========================================================
  //  Public API
  // =========================================================

  return {
    samplePoints,
    orientation,
    polyFit,
    evaluate,
    fitGroup,
    maxResidual,
    adaptiveFitContour
  };

})();
