/**
 * curve-fitter.js
 * ===============
 * Fits mathematical curves (cubic Bezier, circles, ellipses, lines)
 * to contour point arrays extracted from edge detection.
 *
 * Uses:
 *  - Ramer-Douglas-Peucker for contour simplification
 *  - Least-squares cubic Bezier fitting with adaptive splitting
 *  - Circle / ellipse fitting for closed contours
 */

'use strict';

const CurveFitter = (() => {

  // =========================================================
  //  Ramer-Douglas-Peucker simplification
  // =========================================================

  /**
   * @param {Array<{x:number, y:number}>} points
   * @param {number} epsilon - tolerance
   * @returns {Array<{x:number, y:number}>}
   */
  function rdpSimplify(points, epsilon) {
    if (points.length <= 2) return points.slice();

    // Find the point with the maximum distance from the line (first → last)
    let dmax = 0;
    let index = 0;
    const first = points[0];
    const last = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
      const d = perpendicularDist(points[i], first, last);
      if (d > dmax) {
        dmax = d;
        index = i;
      }
    }

    if (dmax > epsilon) {
      const left = rdpSimplify(points.slice(0, index + 1), epsilon);
      const right = rdpSimplify(points.slice(index), epsilon);
      return left.slice(0, -1).concat(right);
    } else {
      return [first, last];
    }
  }

  function perpendicularDist(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
      return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
    }

    const num = Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x);
    return num / Math.sqrt(lenSq);
  }

  // =========================================================
  //  Cubic Bezier fitting
  // =========================================================

  /**
   * Fit a sequence of cubic Bézier curves to the given points.
   * Uses adaptive splitting when error exceeds maxError.
   *
   * @param {Array<{x:number, y:number}>} points
   * @param {number} maxError - max allowed fitting error
   * @returns {Array<{p0, p1, p2, p3}>} array of cubic Bézier segments
   */
  function fitCubicBeziers(points, maxError) {
    if (points.length < 2) return [];
    if (points.length === 2) {
      // Degenerate: just a line
      return [{
        p0: points[0],
        p1: lerp2D(points[0], points[1], 1 / 3),
        p2: lerp2D(points[0], points[1], 2 / 3),
        p3: points[1],
        type: 'line'
      }];
    }

    // Compute left and right tangent directions
    const tHat1 = computeLeftTangent(points, 0);
    const tHat2 = computeRightTangent(points, points.length - 1);

    return fitCubicBeziersInternal(points, tHat1, tHat2, maxError, 0, 6);
  }

  function fitCubicBeziersInternal(points, tHat1, tHat2, maxError, depth, maxDepth) {
    const nPts = points.length;

    if (nPts === 2) {
      const dist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / 3;
      return [{
        p0: points[0],
        p1: { x: points[0].x + tHat1.x * dist, y: points[0].y + tHat1.y * dist },
        p2: { x: points[1].x + tHat2.x * dist, y: points[1].y + tHat2.y * dist },
        p3: points[1],
        type: 'bezier'
      }];
    }

    // Parameterize points by chord length
    let u = chordLengthParameterize(points);

    // Fit Bezier
    let bezCurve = generateBezier(points, u, tHat1, tHat2);

    // Find max deviation
    let { maxDist, splitPoint } = computeMaxError(points, bezCurve, u);

    if (maxDist < maxError) {
      return [{ ...bezCurve, type: 'bezier' }];
    }

    // Try reparameterization (Newton-Raphson refinement)
    const iterationError = maxError * 4;
    if (maxDist < iterationError) {
      for (let i = 0; i < 4; i++) {
        u = reparameterize(points, u, bezCurve);
        bezCurve = generateBezier(points, u, tHat1, tHat2);
        ({ maxDist, splitPoint } = computeMaxError(points, bezCurve, u));
        if (maxDist < maxError) {
          return [{ ...bezCurve, type: 'bezier' }];
        }
      }
    }

    // Stop splitting if we've reached max recursion depth — accept the best fit we have
    if (depth >= maxDepth) {
      return [{ ...bezCurve, type: 'bezier' }];
    }

    // Split at point of max error and recurse
    const tHatCenter = computeCenterTangent(points, splitPoint);
    const left = fitCubicBeziersInternal(points.slice(0, splitPoint + 1), tHat1, negate2D(tHatCenter), maxError, depth + 1, maxDepth);
    const right = fitCubicBeziersInternal(points.slice(splitPoint), tHatCenter, tHat2, maxError, depth + 1, maxDepth);

    return left.concat(right);
  }

  function generateBezier(points, uPrime, tHat1, tHat2) {
    const nPts = points.length;
    const firstPt = points[0];
    const lastPt = points[nPts - 1];

    // Build A matrix (precomputed Bernstein basis × tangents)
    const A = [];
    for (let i = 0; i < nPts; i++) {
      const t = uPrime[i];
      const b1 = bernstein1(t);
      const b2 = bernstein2(t);
      A.push([
        { x: tHat1.x * b1, y: tHat1.y * b1 },
        { x: tHat2.x * b2, y: tHat2.y * b2 }
      ]);
    }

    // Build C and X matrices for least squares
    const C = [[0, 0], [0, 0]];
    const X = [0, 0];

    for (let i = 0; i < nPts; i++) {
      C[0][0] += dot2D(A[i][0], A[i][0]);
      C[0][1] += dot2D(A[i][0], A[i][1]);
      C[1][0] = C[0][1];
      C[1][1] += dot2D(A[i][1], A[i][1]);

      const t = uPrime[i];
      const tmp = sub2D(points[i], bezierPoint(firstPt, firstPt, lastPt, lastPt, t));
      X[0] += dot2D(A[i][0], tmp);
      X[1] += dot2D(A[i][1], tmp);
    }

    // Solve 2×2 system
    const detC = C[0][0] * C[1][1] - C[1][0] * C[0][1];
    let alphaL, alphaR;

    if (Math.abs(detC) > 1e-12) {
      alphaL = (C[1][1] * X[0] - C[0][1] * X[1]) / detC;
      alphaR = (C[0][0] * X[1] - C[1][0] * X[0]) / detC;
    } else {
      const c0 = C[0][0] + C[0][1];
      if (Math.abs(c0) > 1e-12) {
        alphaL = alphaR = X[0] / c0;
      } else {
        alphaL = alphaR = 0;
      }
    }

    // If alpha is invalid or impossibly large, use fallback heuristic
    const segLength = Math.hypot(lastPt.x - firstPt.x, lastPt.y - firstPt.y);
    const epsilon = 1e-6 * segLength;
    const maxAlpha = segLength * 3; // Prevent exploding overshoot loops

    if (alphaL < epsilon || alphaR < epsilon || alphaL > maxAlpha || alphaR > maxAlpha) {
      const dist = segLength / 3;
      return {
        p0: firstPt,
        p1: { x: firstPt.x + tHat1.x * dist, y: firstPt.y + tHat1.y * dist },
        p2: { x: lastPt.x + tHat2.x * dist, y: lastPt.y + tHat2.y * dist },
        p3: lastPt
      };
    }

    return {
      p0: firstPt,
      p1: { x: firstPt.x + tHat1.x * alphaL, y: firstPt.y + tHat1.y * alphaL },
      p2: { x: lastPt.x + tHat2.x * alphaR, y: lastPt.y + tHat2.y * alphaR },
      p3: lastPt
    };
  }

  function reparameterize(points, u, bezCurve) {
    return u.map((uVal, i) => newtonRaphsonRootFind(bezCurve, points[i], uVal));
  }

  function newtonRaphsonRootFind(bez, point, u) {
    const { p0, p1, p2, p3 } = bez;

    // Q(u)
    const q = bezierPoint(p0, p1, p2, p3, u);

    // Q'(u) - first derivative
    const q1_0 = { x: 3 * (p1.x - p0.x), y: 3 * (p1.y - p0.y) };
    const q1_1 = { x: 3 * (p2.x - p1.x), y: 3 * (p2.y - p1.y) };
    const q1_2 = { x: 3 * (p3.x - p2.x), y: 3 * (p3.y - p2.y) };

    const q1 = bezierPoint2(q1_0, q1_1, q1_2, u);

    // Q''(u) - second derivative
    const q2_0 = { x: 2 * (q1_1.x - q1_0.x), y: 2 * (q1_1.y - q1_0.y) };
    const q2_1 = { x: 2 * (q1_2.x - q1_1.x), y: 2 * (q1_2.y - q1_1.y) };

    const q2 = lerp2D(q2_0, q2_1, u);

    // Newton step
    const diff = { x: q.x - point.x, y: q.y - point.y };
    const num = diff.x * q1.x + diff.y * q1.y;
    const den = q1.x * q1.x + q1.y * q1.y + diff.x * q2.x + diff.y * q2.y;

    if (Math.abs(den) < 1e-12) return u;

    return Math.max(0, Math.min(1, u - num / den));
  }

  // =========================================================
  //  Bezier evaluation helpers
  // =========================================================

  function bezierPoint(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
      y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y
    };
  }

  // Quadratic Bezier evaluation (for derivatives)
  function bezierPoint2(p0, p1, p2, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
    };
  }

  function bernstein1(t) { return 3 * t * (1 - t) * (1 - t); }
  function bernstein2(t) { return 3 * t * t * (1 - t); }

  // =========================================================
  //  Parameterization & error
  // =========================================================

  function chordLengthParameterize(points) {
    const u = [0];
    for (let i = 1; i < points.length; i++) {
      u.push(u[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    }
    const total = u[u.length - 1];
    if (total > 0) {
      for (let i = 1; i < u.length; i++) u[i] /= total;
    }
    return u;
  }

  function computeMaxError(points, bezCurve, u) {
    let maxDist = 0;
    let splitPoint = Math.floor(points.length / 2);

    for (let i = 1; i < points.length - 1; i++) {
      const p = bezierPoint(bezCurve.p0, bezCurve.p1, bezCurve.p2, bezCurve.p3, u[i]);
      const dist = Math.hypot(p.x - points[i].x, p.y - points[i].y);
      if (dist > maxDist) {
        maxDist = dist;
        splitPoint = i;
      }
    }

    return { maxDist, splitPoint };
  }

  // =========================================================
  //  Tangent computation
  // =========================================================

  function computeLeftTangent(points, end) {
    const t = { x: points[end + 1].x - points[end].x, y: points[end + 1].y - points[end].y };
    return normalize2D(t);
  }

  function computeRightTangent(points, end) {
    const t = { x: points[end - 1].x - points[end].x, y: points[end - 1].y - points[end].y };
    return normalize2D(t);
  }

  function computeCenterTangent(points, center) {
    let t;
    if (center === 0) {
      t = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
    } else if (center === points.length - 1) {
      t = { x: points[center].x - points[center - 1].x, y: points[center].y - points[center - 1].y };
    } else {
      const v1 = { x: points[center - 1].x - points[center].x, y: points[center - 1].y - points[center].y };
      const v2 = { x: points[center].x - points[center + 1].x, y: points[center].y - points[center + 1].y };
      t = { x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 };
    }
    return normalize2D(t);
  }

  // =========================================================
  //  Circle / ellipse fitting
  // =========================================================

  /**
   * Try to fit a circle to the given closed contour.
   * Uses algebraic circle fit (Kåsa method).
   * @returns {{ cx, cy, r, error }} or null if bad fit
   */
  function fitCircle(points) {
    const n = points.length;
    if (n < 5) return null;

    let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumXY = 0;
    let sumX3 = 0, sumY3 = 0, sumX2Y = 0, sumXY2 = 0;

    for (const p of points) {
      sumX += p.x;
      sumY += p.y;
      sumX2 += p.x * p.x;
      sumY2 += p.y * p.y;
      sumXY += p.x * p.y;
      sumX3 += p.x * p.x * p.x;
      sumY3 += p.y * p.y * p.y;
      sumX2Y += p.x * p.x * p.y;
      sumXY2 += p.x * p.y * p.y;
    }

    const A = n * sumX2 - sumX * sumX;
    const B = n * sumXY - sumX * sumY;
    const C = n * sumY2 - sumY * sumY;
    const D = 0.5 * (n * sumX3 + n * sumXY2 - sumX * sumX2 - sumX * sumY2);
    const E = 0.5 * (n * sumX2Y + n * sumY3 - sumY * sumX2 - sumY * sumY2);

    const det = A * C - B * B;
    if (Math.abs(det) < 1e-10) return null;

    const cx = (D * C - B * E) / det;
    const cy = (A * E - B * D) / det;
    const r = Math.sqrt((sumX2 - 2 * cx * sumX + n * cx * cx + sumY2 - 2 * cy * sumY + n * cy * cy) / n);

    // Compute fit error (mean squared radial error)
    let totalErr = 0;
    for (const p of points) {
      const dist = Math.hypot(p.x - cx, p.y - cy);
      totalErr += (dist - r) * (dist - r);
    }
    const mse = totalErr / n;
    const relError = Math.sqrt(mse) / r;

    return { cx, cy, r, error: relError };
  }

  /**
   * Try to fit an ellipse to the given closed contour.
   * Uses direct least-squares fitting (Fitzgibbon's method simplified).
   * @returns {{ cx, cy, a, b, angle, error }} or null
   */
  function fitEllipse(points) {
    const n = points.length;
    if (n < 6) return null;

    // Compute mean for centering
    let mx = 0, my = 0;
    for (const p of points) { mx += p.x; my += p.y; }
    mx /= n;
    my /= n;

    // Simple approach: use second-order moments
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of points) {
      const dx = p.x - mx;
      const dy = p.y - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    sxx /= n;
    syy /= n;
    sxy /= n;

    // Eigenvalues of covariance matrix
    const trace = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
    const l1 = trace / 2 + disc;
    const l2 = trace / 2 - disc;

    if (l1 <= 0 || l2 <= 0) return null;

    const a = Math.sqrt(l1) * 2.5; // Semi-major (scale factor for ~95% coverage)
    const b = Math.sqrt(l2) * 2.5; // Semi-minor

    // Angle of major axis
    let angle = 0;
    if (Math.abs(sxy) > 1e-10) {
      angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    } else if (sxx < syy) {
      angle = Math.PI / 2;
    }

    // Compute fit error
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);
    let totalErr = 0;
    for (const p of points) {
      const dx = p.x - mx;
      const dy = p.y - my;
      const rx = dx * cosA - dy * sinA;
      const ry = dx * sinA + dy * cosA;
      const val = (rx * rx) / (a * a) + (ry * ry) / (b * b);
      totalErr += (val - 1) * (val - 1);
    }
    const mse = totalErr / n;

    return { cx: mx, cy: my, a, b, angle, error: Math.sqrt(mse) };
  }

  // =========================================================
  //  2D vector helpers
  // =========================================================

  function lerp2D(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  function sub2D(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
  }

  function dot2D(a, b) {
    return a.x * b.x + a.y * b.y;
  }

  function negate2D(v) {
    return { x: -v.x, y: -v.y };
  }

  function normalize2D(v) {
    const len = Math.hypot(v.x, v.y);
    if (len < 1e-12) return { x: 1, y: 0 };
    return { x: v.x / len, y: v.y / len };
  }

  // =========================================================
  //  Check if contour is closed
  // =========================================================

  function isClosedContour(points, threshold = 8) {
    if (points.length < 10) return false;
    const first = points[0];
    const last = points[points.length - 1];
    return Math.hypot(first.x - last.x, first.y - last.y) < threshold;
  }

  // =========================================================
  //  Main fitting pipeline for a single contour
  // =========================================================

  /**
   * Fit curves to a contour.
   * @param {Array<{x:number, y:number}>} contourPoints
   * @param {number} epsilon - RDP simplification tolerance
   * @param {number} bezierMaxError - max Bézier fitting error
   * @param {number} circleThreshold - max relative error for circle acceptance (0-1)
   * @param {number} ellipseThreshold - max MSE for ellipse acceptance
   * @returns {{shapes: Array}} fitted shapes
   */
  function fitContour(contourPoints, epsilon, bezierMaxError, circleThreshold = 0.12, ellipseThreshold = 0.3, useCurves = false) {
    if (contourPoints.length < 3) return { shapes: [] };

    const shapes = [];
    const closed = isClosedContour(contourPoints);

    // Compute bounding box to reject insanely large circles/ellipses fitted to tiny broken arcs
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of contourPoints) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const maxDim = Math.max(maxX - minX, maxY - minY, 10);

    // For closed contours, try circle/ellipse first
    if (closed && contourPoints.length >= 10) {
      const circleFit = fitCircle(contourPoints);
      if (circleFit && circleFit.error < circleThreshold && circleFit.r > 3 && circleFit.r < maxDim * 3) {
        shapes.push({
          type: 'circle',
          cx: circleFit.cx,
          cy: circleFit.cy,
          r: circleFit.r
        });
        return { shapes };
      }

      const ellipseFit = fitEllipse(contourPoints);
      if (ellipseFit && ellipseFit.error < ellipseThreshold && ellipseFit.a > 3 && ellipseFit.b > 3 && Math.max(ellipseFit.a, ellipseFit.b) < maxDim * 3) {
        // Check aspect ratio - if close to 1, it's basically a circle
        const ratio = Math.min(ellipseFit.a, ellipseFit.b) / Math.max(ellipseFit.a, ellipseFit.b);
        if (ratio > 0.92 && circleFit) {
          shapes.push({
            type: 'circle',
            cx: circleFit.cx,
            cy: circleFit.cy,
            r: (ellipseFit.a + ellipseFit.b) / 2
          });
        } else {
          shapes.push({
            type: 'ellipse',
            cx: ellipseFit.cx,
            cy: ellipseFit.cy,
            a: ellipseFit.a,
            b: ellipseFit.b,
            angle: ellipseFit.angle
          });
        }
        return { shapes };
      }
    }

    // Simplify with Ramer-Douglas-Peucker
    const simplified = rdpSimplify(contourPoints, epsilon);

    if (simplified.length < 2) return { shapes: [] };

    // Check if simplified contour is just a line segment
    if (simplified.length === 2) {
      const dx = simplified[1].x - simplified[0].x;
      const dy = simplified[1].y - simplified[0].y;
      const len = Math.hypot(dx, dy);
      if (len > 2) {
        shapes.push({
          type: 'line',
          x1: simplified[0].x,
          y1: simplified[0].y,
          x2: simplified[1].x,
          y2: simplified[1].y
        });
      }
      return { shapes };
    }

    if (useCurves) {
      // Pre-simplify to remove pixel noise but keep shape (use 3x the RDP epsilon for gentler smoothing)
      const smoothed = rdpSimplify(contourPoints, Math.max(epsilon * 0.5, 1.0));
      // Use a much more relaxed error so each Bézier covers a larger arc of the shape
      const curveError = bezierMaxError * 8;
      const beziers = fitCubicBeziers(smoothed.length >= 4 ? smoothed : contourPoints, curveError);
      for (const bez of beziers) {
        shapes.push({
          type: 'bezier',
          p0: bez.p0,
          p1: bez.p1,
          p2: bez.p2,
          p3: bez.p3
        });
      }
    } else {
      // Use linear functions (polygons) for everything that is not explicitly a circle/ellipse.
      // The RDP algorithm guarantees these lines closely match the original curves.
      for (let i = 0; i < simplified.length - 1; i++) {
        const dx = simplified[i + 1].x - simplified[i].x;
        const dy = simplified[i + 1].y - simplified[i].y;
        if (Math.hypot(dx, dy) > 2) {
          shapes.push({
            type: 'line',
            x1: simplified[i].x,
            y1: simplified[i].y,
            x2: simplified[i + 1].x,
            y2: simplified[i + 1].y
          });
        }
      }
    }

    return { shapes };
  }

  // =========================================================
  //  Public API
  // =========================================================

  return {
    fitContour,
    fitCircle,
    fitEllipse,
    fitCubicBeziers,
    rdpSimplify,
    isClosedContour,
    // Expose for preview drawing
    bezierPoint
  };

})();
