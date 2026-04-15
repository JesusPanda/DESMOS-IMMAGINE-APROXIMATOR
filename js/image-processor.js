/**
 * image-processor.js
 * ===================
 * Handles the OpenCV.js image processing pipeline:
 *  1. Grayscale conversion
 *  2. Gaussian blur
 *  3. Canny edge detection (single or multi-pass)
 *  4. Contour extraction
 *  5. Contour point conversion
 *
 * All OpenCV operations run on the main thread using the WASM build.
 */

'use strict';

const ImageProcessor = (() => {

  // =========================================================
  //  Detail level presets
  // =========================================================

  /**
   * Get processing parameters based on the precision slider value (0-100).
   */
  function getParams(precision) {
    // Normalize to 0-1
    const t = precision / 100;

    // Gaussian blur kernel size (must be odd)
    const blurSize = Math.max(3, Math.round(7 - t * 5));
    const blurKernel = blurSize % 2 === 0 ? blurSize + 1 : blurSize;

    // Canny thresholds
    const cannyLow = Math.round(120 - t * 100);   // 120 → 20
    const cannyHigh = Math.round(240 - t * 160);   // 240 → 80

    // Ramer-Douglas-Peucker epsilon
    const epsilon = 6 - t * 5.2;  // 6.0 → 0.8

    // Bezier max error
    const bezierError = 5 - t * 3.5;  // 5.0 → 1.5

    // Minimum contour length (in pixels)
    const minContourLength = Math.round(40 - t * 30); // 40 → 10

    // Multi-pass (for high detail)
    const multiPass = t > 0.65;

    // Additional passes for shadows/highlights
    const passes = [];
    passes.push({ cannyLow, cannyHigh, label: 'edges' });

    if (multiPass) {
      // Extra pass with lower thresholds for subtle details
      passes.push({
        cannyLow: Math.round(cannyLow * 0.5),
        cannyHigh: Math.round(cannyHigh * 0.6),
        label: 'details'
      });
      // Extra pass with higher blur for macro shadows
      passes.push({
        cannyLow: Math.round(cannyLow * 1.5),
        cannyHigh: Math.round(cannyHigh * 1.2),
        label: 'shadows',
        extraBlur: 2
      });
    }

    return {
      blurKernel,
      cannyLow,
      cannyHigh,
      epsilon,
      bezierError,
      minContourLength,
      multiPass,
      passes,
      // Strict thresholds to ensure polygons like squares don't get matched as circles
      circleThreshold: 0.03 + t * 0.05,  // 0.03 -> 0.08
      ellipseThreshold: 0.08 + t * 0.12  // 0.08 -> 0.20
    };
  }

  // =========================================================
  //  Processing pipeline
  // =========================================================

  /**
   * Process an image element through the full pipeline.
   * @param {HTMLImageElement|HTMLCanvasElement} imageSource
   * @param {number} precision - 0 to 100
   * @param {function} onProgress - callback(stage, progress)
   * @returns {{ contours: Array, edgeMat: cv.Mat, allShapes: Array, width: number, height: number }}
   */
  function processImage(imageSource, precision, onProgress = () => {}, bwMode = false, curveMode = true) {
    const params = getParams(precision);

    onProgress('Loading image...', 5);

    // Read image into OpenCV Mat
    const src = cv.imread(imageSource);
    const width = src.cols;
    const height = src.rows;

    onProgress('Converting to grayscale...', 15);

    // Convert to grayscale
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    if (bwMode) {
      onProgress('Applying B&W filter...', 20);
      // Strictly binarize image to erase vague shadows and gradients
      cv.threshold(gray, gray, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    }

    onProgress('Applying blur...', 25);

    // Apply Gaussian blur
    const blurred = new cv.Mat();
    const ksize = new cv.Size(params.blurKernel, params.blurKernel);
    cv.GaussianBlur(gray, blurred, ksize, 0);

    onProgress('Detecting edges...', 40);

    // Combined edge mat (for multi-pass)
    const combinedEdges = new cv.Mat.zeros(height, width, cv.CV_8UC1);

    const allContourPoints = [];
    const passMats = []; // Keep references for cleanup

    for (let pi = 0; pi < params.passes.length; pi++) {
      const pass = params.passes[pi];
      const progressBase = 40 + (pi / params.passes.length) * 30;

      onProgress(`Edge detection (${pass.label})...`, progressBase);

      let source = blurred;

      // Extra blur for some passes
      if (pass.extraBlur) {
        source = new cv.Mat();
        const ebk = params.blurKernel + pass.extraBlur * 2;
        const ebkOdd = ebk % 2 === 0 ? ebk + 1 : ebk;
        cv.GaussianBlur(blurred, source, new cv.Size(ebkOdd, ebkOdd), 0);
        passMats.push(source);
      }

      // Canny edge detection
      const edges = new cv.Mat();
      cv.Canny(source, edges, pass.cannyLow, pass.cannyHigh);

      // Apply morphological closing to connect nearby edges
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
      const closed = new cv.Mat();
      cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
      kernel.delete();

      // Merge into combined edges
      cv.bitwise_or(combinedEdges, closed, combinedEdges);

      edges.delete();
      closed.delete();
    }

    onProgress('Extracting contours...', 75);

    // Find contours
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(combinedEdges, contours, hierarchy,
      cv.RETR_LIST, cv.CHAIN_APPROX_NONE);

    onProgress('Fitting curves...', 82);

    // Convert contours to point arrays and fit curves
    const allShapes = [];
    const contourData = [];
    const totalContours = contours.size();

    for (let i = 0; i < totalContours; i++) {
      const contour = contours.get(i);
      const points = matToPoints(contour);

      // Filter by minimum length
      if (points.length < params.minContourLength) continue;

      // Compute contour perimeter for additional filtering
      const perimeter = cv.arcLength(contour, false);
      if (perimeter < params.minContourLength) continue;

      contourData.push(points);

      // Fit curves to this contour
      const result = CurveFitter.fitContour(
        points,
        params.epsilon,
        params.bezierError,
        params.circleThreshold,
        params.ellipseThreshold,
        curveMode
      );

      if (result.shapes.length > 0) {
        allShapes.push(...result.shapes);
      }

      // Progress update
      if (i % 20 === 0) {
        const p = 82 + (i / totalContours) * 15;
        onProgress(`Fitting curves (${i}/${totalContours})...`, p);
      }
    }

    onProgress('Done!', 100);

    // Create a display-friendly edge image
    const edgeDisplay = new cv.Mat();
    combinedEdges.copyTo(edgeDisplay);

    // Cleanup
    src.delete();
    gray.delete();
    blurred.delete();
    contours.delete();
    hierarchy.delete();
    combinedEdges.delete();
    for (const m of passMats) m.delete();

    return {
      contours: contourData,
      edgeMat: edgeDisplay,
      allShapes,
      width,
      height,
      params
    };
  }

  /**
   * Convert OpenCV contour Mat to array of {x, y} points.
   */
  function matToPoints(contourMat) {
    const points = [];
    const data = contourMat.data32S;
    for (let j = 0; j < data.length; j += 2) {
      points.push({ x: data[j], y: data[j + 1] });
    }
    return points;
  }

  /**
   * Draw edge detection result to a canvas.
   */
  function drawEdges(edgeMat, canvas) {
    cv.imshow(canvas, edgeMat);
  }

  /**
   * Draw fitted shapes overlay on a canvas.
   * @param {Array} shapes
   * @param {HTMLCanvasElement} canvas
   * @param {number} width
   * @param {number} height
   */
  function drawShapesOverlay(shapes, canvas, width, height) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const shape of shapes) {
      ctx.beginPath();

      switch (shape.type) {
        case 'circle':
          ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
          break;

        case 'ellipse':
          ctx.save();
          ctx.translate(shape.cx, shape.cy);
          ctx.rotate(shape.angle);
          ctx.ellipse(0, 0, shape.a, shape.b, 0, 0, Math.PI * 2);
          ctx.restore();
          break;

        case 'line':
          ctx.moveTo(shape.x1, shape.y1);
          ctx.lineTo(shape.x2, shape.y2);
          break;

        case 'bezier':
          ctx.moveTo(shape.p0.x, shape.p0.y);
          ctx.bezierCurveTo(
            shape.p1.x, shape.p1.y,
            shape.p2.x, shape.p2.y,
            shape.p3.x, shape.p3.y
          );
          break;
      }

      ctx.stroke();
    }
  }

  return {
    processImage,
    getParams,
    drawEdges,
    drawShapesOverlay
  };

})();
