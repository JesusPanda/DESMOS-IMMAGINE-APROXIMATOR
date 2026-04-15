/**
 * app.js
 * ======
 * Main application controller.
 * Handles UI interactions, file upload, processing orchestration,
 * Desmos integration, and export functionality.
 *
 * Supports two modes:
 *  - Auto Trace: edge detection → contour fitting → Bézier/line/circle equations
 *  - Regression:  edge detection → point sampling → polynomial regression equations
 */

'use strict';

const App = (() => {
  // =========================================================
  //  State
  // =========================================================
  let state = {
    imageLoaded: false,
    processing: false,
    precision: 50,
    loadedImage: null,      // HTMLImageElement
    results: null,          // Processing results
    equations: [],          // Desmos equation strings
    desmosCalc: null,       // Desmos calculator instance
    currentView: 'original',// 'original' | 'edges' | 'curves' | 'desmos'
    mode: 'auto',           // 'auto' | 'regression'
    manualPoints: [],       // [{x,y}] in image-canvas coords
    sampledGroups: [],      // array of point-arrays (per contour)
    regressionFits: []      // fit results from RegressionFitter
  };

  // DOM refs
  const dom = {};

  // =========================================================
  //  Initialization
  // =========================================================

  function init() {
    cacheDom();
    bindEvents();
    updateSliderDisplay();
    checkOpenCVReady();
  }

  function cacheDom() {
    dom.uploadZone = document.getElementById('upload-zone');
    dom.fileInput = document.getElementById('file-input');
    dom.uploadPreview = document.getElementById('upload-preview');
    dom.btnProcess = document.getElementById('btn-process');
    dom.precisionSlider = document.getElementById('precision-slider');
    dom.precisionValue = document.getElementById('precision-value');
    dom.progressSection = document.getElementById('progress-section');
    dom.progressFill = document.getElementById('progress-fill');
    dom.progressText = document.getElementById('progress-text');
    dom.statCurves = document.getElementById('stat-curves');
    dom.statTime = document.getElementById('stat-time');
    dom.statCircles = document.getElementById('stat-circles');
    dom.statBeziers = document.getElementById('stat-beziers');
    dom.statCirclesLabel = document.getElementById('stat-circles-label');
    dom.statBeziersLabel = document.getElementById('stat-beziers-label');
    dom.previewCanvas = document.getElementById('preview-canvas');
    dom.edgeCanvas = document.getElementById('edge-canvas');
    dom.curveCanvas = document.getElementById('curve-canvas');
    dom.desmosContainer = document.getElementById('desmos-container');
    dom.previewPlaceholder = document.getElementById('preview-placeholder');
    dom.viewTabs = document.querySelectorAll('.view-tab');
    dom.equationsPanel = document.getElementById('equations-panel');
    dom.btnCopyAll = document.getElementById('btn-copy-all');
    dom.btnDownload = document.getElementById('btn-download');
    dom.btnOpenDesmos = document.getElementById('btn-open-desmos');
    dom.toast = document.getElementById('toast');
    dom.statusDot = document.getElementById('status-dot');
    dom.statusText = document.getElementById('status-text');
    dom.sliderLabels = document.querySelectorAll('.slider-label');
    dom.statsCard = document.getElementById('stats-card');
    dom.loadingOverlay = document.getElementById('loading-overlay');
    dom.toggleBw = document.getElementById('toggle-bw');
    dom.toggleCurves = document.getElementById('toggle-curves');

    // Mode
    dom.modeBtns = document.querySelectorAll('.mode-btn');
    dom.autoSettings = document.getElementById('auto-settings');
    dom.regressionSettings = document.getElementById('regression-settings');

    // Regression controls
    dom.sampleSlider = document.getElementById('sample-slider');
    dom.sampleValue = document.getElementById('sample-value');
    dom.toleranceSlider = document.getElementById('tolerance-slider');
    dom.toleranceValue = document.getElementById('tolerance-value');
    dom.toggleBwReg = document.getElementById('toggle-bw-reg');
    dom.btnClearPoints = document.getElementById('btn-clear-points');
    dom.manualPointCount = document.getElementById('manual-point-count');
    dom.previewContainer = document.querySelector('.preview-container');
  }

  function bindEvents() {
    // Upload zone
    dom.uploadZone.addEventListener('click', () => dom.fileInput.click());
    dom.uploadZone.addEventListener('dragover', handleDragOver);
    dom.uploadZone.addEventListener('dragleave', handleDragLeave);
    dom.uploadZone.addEventListener('drop', handleDrop);
    dom.fileInput.addEventListener('change', handleFileSelect);

    // Process button
    dom.btnProcess.addEventListener('click', startProcessing);

    // Precision slider
    dom.precisionSlider.addEventListener('input', handleSliderChange);

    // View tabs
    dom.viewTabs.forEach(tab => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    // Export buttons
    dom.btnCopyAll.addEventListener('click', copyAllEquations);
    dom.btnDownload.addEventListener('click', downloadEquations);
    dom.btnOpenDesmos.addEventListener('click', openInDesmos);

    // Paste support
    document.addEventListener('paste', handlePaste);

    // Mode switching
    dom.modeBtns.forEach(btn => {
      btn.addEventListener('click', () => switchMode(btn.dataset.mode));
    });

    // Regression sliders
    dom.sampleSlider.addEventListener('input', () => {
      dom.sampleValue.textContent = dom.sampleSlider.value;
    });
    dom.toleranceSlider.addEventListener('input', () => {
      dom.toleranceValue.textContent = dom.toleranceSlider.value;
    });

    // Clear manual points
    dom.btnClearPoints.addEventListener('click', () => {
      state.manualPoints = [];
      dom.manualPointCount.textContent = '0';
      if (state.imageLoaded) redrawOriginalWithPoints();
      showToast('Manual points cleared');
    });

    // Canvas interaction for regression mode (manual point placement)
    dom.previewCanvas.addEventListener('click', handleCanvasClick);
    dom.previewCanvas.addEventListener('contextmenu', handleCanvasRightClick);
  }

  // =========================================================
  //  Mode Switching
  // =========================================================

  function switchMode(mode) {
    state.mode = mode;

    // Update buttons
    dom.modeBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Show/hide relevant settings
    if (mode === 'auto') {
      dom.autoSettings.style.display = '';
      dom.regressionSettings.style.display = 'none';
      dom.previewContainer.classList.remove('regression-mode');
      // Restore stat labels
      dom.statCirclesLabel.textContent = 'Circles';
      dom.statBeziersLabel.textContent = 'Béziers';
    } else {
      dom.autoSettings.style.display = 'none';
      dom.regressionSettings.style.display = '';
      dom.previewContainer.classList.add('regression-mode');
      // Update stat labels for regression
      dom.statCirclesLabel.textContent = 'Avg R²';
      dom.statBeziersLabel.textContent = 'Points';
    }

    // Redraw image with points if in regression mode
    if (state.imageLoaded && mode === 'regression') {
      redrawOriginalWithPoints();
      switchView('original');
    }
  }

  // =========================================================
  //  Canvas Interaction (Regression Mode)
  // =========================================================

  function handleCanvasClick(e) {
    if (state.mode !== 'regression' || !state.imageLoaded) return;
    // Only respond when on Original view
    if (state.currentView !== 'original') {
      switchView('original');
    }

    const rect = dom.previewCanvas.getBoundingClientRect();
    const scaleX = dom.previewCanvas.width / rect.width;
    const scaleY = dom.previewCanvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    state.manualPoints.push({ x, y });
    dom.manualPointCount.textContent = state.manualPoints.length;
    redrawOriginalWithPoints();
  }

  function handleCanvasRightClick(e) {
    if (state.mode !== 'regression' || state.manualPoints.length === 0) return;
    e.preventDefault();

    const rect = dom.previewCanvas.getBoundingClientRect();
    const scaleX = dom.previewCanvas.width / rect.width;
    const scaleY = dom.previewCanvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    // Find nearest within 20px
    let minDist = 20, minIdx = -1;
    for (let i = 0; i < state.manualPoints.length; i++) {
      const d = Math.hypot(state.manualPoints[i].x - x, state.manualPoints[i].y - y);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    if (minIdx >= 0) {
      state.manualPoints.splice(minIdx, 1);
      dom.manualPointCount.textContent = state.manualPoints.length;
      redrawOriginalWithPoints();
    }
  }

  function redrawOriginalWithPoints() {
    if (!state.loadedImage) return;
    const ctx = dom.previewCanvas.getContext('2d');
    ctx.drawImage(state.loadedImage, 0, 0, dom.previewCanvas.width, dom.previewCanvas.height);

    // Draw manual points
    for (let i = 0; i < state.manualPoints.length; i++) {
      const p = state.manualPoints[i];
      // Outer ring
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Inner fill
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ff6b6b';
      ctx.fill();
      // Index label
      ctx.font = '10px Inter, sans-serif';
      ctx.fillStyle = 'white';
      ctx.fillText(i + 1, p.x + 8, p.y + 4);
    }
  }

  // =========================================================
  //  OpenCV Loading
  // =========================================================

  function checkOpenCVReady() {
    if (typeof cv !== 'undefined' && cv.Mat) {
      onOpenCVReady();
    }
    // Otherwise wait — the cv['onRuntimeInitialized'] callback will fire
  }

  function onOpenCVReady() {
    dom.statusDot.classList.add('ready');
    dom.statusText.textContent = 'Engine Ready';
    dom.loadingOverlay.classList.add('hidden');
    console.log('[App] OpenCV.js loaded and ready');
  }

  // Exposed globally for OpenCV callback
  window.onOpenCVReady = onOpenCVReady;

  // =========================================================
  //  File Upload
  // =========================================================

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    dom.uploadZone.classList.add('dragover');
  }

  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    dom.uploadZone.classList.remove('dragover');
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    dom.uploadZone.classList.remove('dragover');

    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      loadFile(files[0]);
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) loadFile(file);
  }

  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) loadFile(file);
        break;
      }
    }
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        state.loadedImage = img;
        state.imageLoaded = true;

        // Show preview in upload zone
        dom.uploadPreview.src = e.target.result;
        dom.uploadZone.classList.add('has-image');

        // Draw on preview canvas
        drawOriginal(img);

        // Enable process button
        dom.btnProcess.disabled = false;

        // Reset previous results
        clearResults();

        switchView('original');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function drawOriginal(img) {
    // Scale to fit max canvas size
    const maxW = 800;
    const maxH = 600;
    let w = img.width;
    let h = img.height;

    if (w > maxW || h > maxH) {
      const scale = Math.min(maxW / w, maxH / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    dom.previewCanvas.width = w;
    dom.previewCanvas.height = h;
    const ctx = dom.previewCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    dom.previewPlaceholder.style.display = 'none';
    dom.previewCanvas.style.display = 'block';

    // If in regression mode, redraw with any existing points
    if (state.mode === 'regression') {
      redrawOriginalWithPoints();
    }
  }

  // =========================================================
  //  Precision Slider
  // =========================================================

  function handleSliderChange() {
    state.precision = parseInt(dom.precisionSlider.value);
    updateSliderDisplay();
  }

  function updateSliderDisplay() {
    const val = state.precision;
    dom.precisionValue.textContent = val;

    // Update active label
    dom.sliderLabels.forEach(label => label.classList.remove('active'));
    if (val <= 33) dom.sliderLabels[0].classList.add('active');
    else if (val <= 66) dom.sliderLabels[1].classList.add('active');
    else dom.sliderLabels[2].classList.add('active');

    // Update slider thumb color based on zone
    const slider = dom.precisionSlider;
    if (val <= 33) {
      slider.style.setProperty('--thumb-color', 'var(--accent-cyan)');
    } else if (val <= 66) {
      slider.style.setProperty('--thumb-color', 'var(--accent-purple)');
    } else {
      slider.style.setProperty('--thumb-color', 'var(--accent-pink)');
    }
  }

  // =========================================================
  //  Processing (dispatcher)
  // =========================================================

  async function startProcessing() {
    if (!state.imageLoaded || state.processing) return;
    if (typeof cv === 'undefined' || !cv.Mat) {
      showToast('OpenCV is still loading, please wait...', 'warning');
      return;
    }

    state.processing = true;
    dom.btnProcess.disabled = true;
    dom.btnProcess.classList.add('processing');
    dom.btnProcess.textContent = 'Processing...';
    dom.progressSection.classList.add('visible');

    // Yield to UI before heavy processing
    await yieldToUI();

    try {
      if (state.mode === 'regression') {
        await processRegression();
      } else {
        await processAutoTrace();
      }
    } catch (err) {
      console.error('[App] Processing error:', err);
      showToast('Processing failed: ' + err.message, 'error');
    }

    state.processing = false;
    dom.btnProcess.disabled = false;
    dom.btnProcess.classList.remove('processing');
    dom.btnProcess.textContent = '⚡ Process Image';
    dom.progressSection.classList.remove('visible');
  }

  // =========================================================
  //  Auto Trace Processing
  // =========================================================

  async function processAutoTrace() {
    const sourceCanvas = dom.previewCanvas;
    const startTime = performance.now();

    const onProgress = (stage, pct) => {
      dom.progressFill.style.width = pct + '%';
      dom.progressText.textContent = stage;
    };

    // Run processing
    const bwMode = dom.toggleBw.checked;
    const curveMode = dom.toggleCurves.checked;
    const results = ImageProcessor.processImage(sourceCanvas, state.precision, onProgress, bwMode, curveMode);
    state.results = results;

    // Draw edge detection result
    dom.edgeCanvas.width = results.width;
    dom.edgeCanvas.height = results.height;
    ImageProcessor.drawEdges(results.edgeMat, dom.edgeCanvas);

    // Draw fitted curves overlay
    ImageProcessor.drawShapesOverlay(results.allShapes, dom.curveCanvas, results.width, results.height);

    // Generate Desmos equations
    const exportResult = DesmosExport.exportAll(results.allShapes, results.width, results.height);
    state.equations = exportResult.equations;

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

    // Update stats
    const circles = results.allShapes.filter(s => s.type === 'circle').length;
    const ellipses = results.allShapes.filter(s => s.type === 'ellipse').length;
    const beziers = results.allShapes.filter(s => s.type === 'bezier').length;
    const lines = results.allShapes.filter(s => s.type === 'line').length;

    dom.statCirclesLabel.textContent = 'Circles';
    dom.statBeziersLabel.textContent = 'Béziers';
    dom.statCurves.textContent = state.equations.length;
    dom.statTime.textContent = elapsed + 's';
    dom.statCircles.textContent = circles + ellipses;
    dom.statBeziers.textContent = beziers + lines;
    dom.statsCard.style.display = 'block';

    // Populate equations list
    populateEquations(state.equations);

    // Enable export buttons
    dom.btnCopyAll.disabled = false;
    dom.btnDownload.disabled = false;
    dom.btnOpenDesmos.disabled = false;

    // Load into Desmos if available
    loadDesmos(state.equations);

    // Switch to curves view
    switchView('curves');

    // Clean up edge Mat
    results.edgeMat.delete();

    showToast(`Generated ${state.equations.length} equations in ${elapsed}s`);
  }

  // =========================================================
  //  Regression Processing
  // =========================================================

  async function processRegression() {
    const sourceCanvas = dom.previewCanvas;
    const startTime = performance.now();

    const onProgress = (stage, pct) => {
      dom.progressFill.style.width = pct + '%';
      dom.progressText.textContent = stage;
    };

    // Step 1: Edge detection to get contours (reuse existing pipeline)
    const bwMode = dom.toggleBwReg.checked;
    const results = ImageProcessor.processImage(sourceCanvas, state.precision, onProgress, bwMode, false);
    state.results = results;

    // Draw edge output
    dom.edgeCanvas.width = results.width;
    dom.edgeCanvas.height = results.height;
    ImageProcessor.drawEdges(results.edgeMat, dom.edgeCanvas);

    onProgress('Tracing edges...', 80);
    await yieldToUI();

    // ── Precision & Tolerance sliders ──
    const precision = parseInt(dom.sampleSlider.value);
    const pNorm = (precision - 1) / 99;  // 0 → 1

    const toleranceVal = parseInt(dom.toleranceSlider.value);
    const tNorm = (toleranceVal - 1) / 99; // 0 → 1

    // Tolerance: how close curves must hug the edge (Desmos units)
    //   tNorm 0 (Loose) → ~2.0     tNorm 1 (Exact) → 0.015
    const tolerance = 2.0 * Math.pow(0.0075, tNorm);

    // Epsilon for RDP simplification (erases pixel wiggles on straight lines)
    const epsilon = 6 - (precision / 100) * 5.2;

    // Max degree: auto-selected per segment, ceiling rises with precision
    //   precision  1-33 → max 3       34-66 → max 4       67-100 → max 6
    const MAX_DEGREE = pNorm < 0.33 ? 3 : pNorm < 0.66 ? 4 : 6;

    // Max points per contour for curvature-adaptive subsampling
    //   precision  1 → 60        100 → 800
    const maxPtsPerContour = Math.round(60 + pNorm * 740);

    // Step 2: Filter contours by minimum length
    const contours = results.contours.filter(c => c.length >= 6);

    // Step 3: For each contour, subsample if needed, then fit
    const tx = DesmosExport.createTransformer(results.width, results.height);
    const fits = [];
    const allSampled = [];

    onProgress('Fitting curves to edges...', 85);
    await yieldToUI();

    // Helper to resample a polyline (like RDP output) evenly
    function resamplePolyline(points, spacing = 2) {
      if (points.length < 2) return points;
      const out = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const p1 = points[i - 1];
        const p2 = points[i];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.hypot(dx, dy);
        const steps = Math.floor(dist / spacing);
        for (let s = 1; s <= steps; s++) {
          out.push({
            x: p1.x + (dx * s) / steps,
            y: p1.y + (dy * s) / steps
          });
        }
        if (steps === 0 || out[out.length - 1].x !== p2.x || out[out.length - 1].y !== p2.y) {
          out.push(p2);
        }
      }
      return out;
    }

    for (let ci = 0; ci < contours.length; ci++) {
      const raw = contours[ci];

      // Step 3a: Apply RDP simplification to remove pixel wiggles.
      const simplified = CurveFitter.rdpSimplify(raw, epsilon);

      // Step 3b: Resample the RDP polyline densely so the polynomial fitter 
      // doesn't wiggle out of control between sparse vertices (Runge's phenomenon).
      const smoothDense = resamplePolyline(simplified, 2);

      // Step 3c: Subsample if there are still an excessive number of points
      const pts = smoothDense.length <= maxPtsPerContour
        ? smoothDense
        : RegressionFitter.samplePoints(smoothDense, maxPtsPerContour);

      allSampled.push(...pts);

      // Transform to Desmos coordinate space
      const dPts = pts.map(p => ({ x: tx.x(p.x), y: tx.y(p.y) }));
      if (dPts.length < 2) continue;

      // Adaptive fitting: auto-selects lowest degree per segment
      const segFits = RegressionFitter.adaptiveFitContour(dPts, MAX_DEGREE, tolerance);
      fits.push(...segFits);

      // Yield periodically for large images
      if (ci % 50 === 0 && ci > 0) {
        const p = 85 + (ci / contours.length) * 10;
        onProgress(`Fitting curves (${ci}/${contours.length})...`, p);
        await yieldToUI();
      }
    }

    // Fit manual guide points as their own group
    if (state.manualPoints.length >= 2) {
      const dManual = state.manualPoints.map(p => ({ x: tx.x(p.x), y: tx.y(p.y) }));
      const manualFits = RegressionFitter.adaptiveFitContour(dManual, MAX_DEGREE, tolerance);
      fits.push(...manualFits);
      allSampled.push(...state.manualPoints);
    }

    state.regressionFits = fits;

    onProgress('Generating equations...', 94);

    // Step 6: Generate Desmos equations
    const equations = fits.map(f => DesmosExport.regressionToDesmos(f));
    state.equations = equations;

    // Step 7: Draw results on curve canvas
    drawRegressionResults(allSampled, fits, tx, results.width, results.height);

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

    // Step 8: Update stats
    const avgR2 = fits.length > 0
      ? (fits.reduce((s, f) => s + f.rSquared, 0) / fits.length)
      : 0;

    dom.statCirclesLabel.textContent = 'Avg R²';
    dom.statBeziersLabel.textContent = 'Points';
    dom.statCurves.textContent = equations.length;
    dom.statTime.textContent = elapsed + 's';
    dom.statCircles.textContent = avgR2.toFixed(2);
    dom.statBeziers.textContent = allSampled.length;
    dom.statsCard.style.display = 'block';

    // Populate equations + Desmos
    populateEquations(equations);
    dom.btnCopyAll.disabled = false;
    dom.btnDownload.disabled = false;
    dom.btnOpenDesmos.disabled = false;

    loadDesmosRegression(equations);

    switchView('curves');
    results.edgeMat.delete();

    showToast(`Generated ${equations.length} regression curves in ${elapsed}s`);
  }

  // =========================================================
  //  Regression Drawing
  // =========================================================

  function drawRegressionResults(sampledPts, fits, tx, width, height) {
    dom.curveCanvas.width = width;
    dom.curveCanvas.height = height;
    const ctx = dom.curveCanvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    // Draw sampled points (small semi-transparent dots)
    ctx.fillStyle = 'rgba(139,92,246,0.45)';
    for (const p of sampledPts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw manual guide points (larger, highlighted)
    ctx.fillStyle = '#ff6b6b';
    for (const p of state.manualPoints) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Draw fitted polynomial curves
    const colors = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899',
                    '#2d70b3', '#388c46', '#fa7e19', '#6042a6', '#c74440'];

    for (let f = 0; f < fits.length; f++) {
      const fit = fits[f];
      ctx.strokeStyle = colors[f % colors.length];
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      const steps = 300;
      const isVert = fit.orientation === 'vertical';
      let started = false;

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const indep = fit.domainMin + t * (fit.domainMax - fit.domainMin);
        const dep = RegressionFitter.evaluate(fit, indep);

        let imgX, imgY;
        if (isVert) {
          // independent is Desmos-y, dependent is Desmos-x
          imgX = tx.invX(dep);
          imgY = tx.invY(indep);
        } else {
          imgX = tx.invX(indep);
          imgY = tx.invY(dep);
        }

        if (!started) { ctx.moveTo(imgX, imgY); started = true; }
        else ctx.lineTo(imgX, imgY);
      }
      ctx.stroke();
    }
  }

  // =========================================================
  //  Helpers
  // =========================================================

  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 50));
  }

  function clearResults() {
    state.results = null;
    state.equations = [];
    state.regressionFits = [];
    state.sampledGroups = [];
    dom.statsCard.style.display = 'none';
    dom.equationsPanel.innerHTML = '<div class="equations-empty">Process an image to generate equations</div>';
    dom.btnCopyAll.disabled = true;
    dom.btnDownload.disabled = true;
    dom.btnOpenDesmos.disabled = true;
  }

  // =========================================================
  //  View Switching
  // =========================================================

  function switchView(view) {
    state.currentView = view;

    dom.viewTabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });

    // Hide all canvases
    dom.previewCanvas.style.display = 'none';
    dom.edgeCanvas.style.display = 'none';
    dom.curveCanvas.style.display = 'none';
    dom.desmosContainer.classList.remove('visible');
    dom.previewPlaceholder.style.display = 'none';

    switch (view) {
      case 'original':
        if (state.imageLoaded) {
          dom.previewCanvas.style.display = 'block';
          // Redraw with manual points if in regression mode
          if (state.mode === 'regression') {
            redrawOriginalWithPoints();
          }
        } else {
          dom.previewPlaceholder.style.display = 'block';
        }
        break;
      case 'edges':
        if (state.results || dom.edgeCanvas.width > 0) {
          dom.edgeCanvas.style.display = 'block';
        } else {
          dom.previewPlaceholder.style.display = 'block';
        }
        break;
      case 'curves':
        if (state.results || dom.curveCanvas.width > 0) {
          dom.curveCanvas.style.display = 'block';
        } else {
          dom.previewPlaceholder.style.display = 'block';
        }
        break;
      case 'desmos':
        if (state.equations.length > 0) {
          dom.desmosContainer.classList.add('visible');
        } else {
          dom.previewPlaceholder.style.display = 'block';
        }
        break;
    }
  }

  // =========================================================
  //  Equations Display
  // =========================================================

  function populateEquations(equations) {
    if (equations.length === 0) {
      dom.equationsPanel.innerHTML = '<div class="equations-empty">No equations generated</div>';
      return;
    }

    // Limit displayed equations for performance (show first 200)
    const maxDisplay = 200;
    const displayed = equations.slice(0, maxDisplay);

    let html = '';
    for (let i = 0; i < displayed.length; i++) {
      html += `
        <div class="equation-item" data-index="${i}">
          <span class="equation-item__index">#${i + 1}</span>
          <span class="equation-item__text" title="${escapeHtml(equations[i])}">${escapeHtml(equations[i])}</span>
          <button class="equation-item__copy" onclick="App.copySingle(${i})">Copy</button>
        </div>`;
    }

    if (equations.length > maxDisplay) {
      html += `<div class="equations-empty">...and ${equations.length - maxDisplay} more equations</div>`;
    }

    dom.equationsPanel.innerHTML = html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // =========================================================
  //  Desmos Integration
  // =========================================================

  function ensureDesmosCalc() {
    if (!state.desmosCalc && typeof Desmos !== 'undefined') {
      const elt = document.getElementById('desmos-calculator');
      state.desmosCalc = Desmos.GraphingCalculator(elt, {
        expressions: true,
        settingsMenu: false,
        zoomButtons: true,
        expressionsCollapsed: true,
        border: false,
        keypad: false,
        autosize: true
      });
    }
    return state.desmosCalc;
  }

  function loadDesmos(equations) {
    const calc = ensureDesmosCalc();
    if (!calc) return;

    // Clear previous expressions
    calc.setBlank();

    // Add expressions (limit for performance)
    const maxDesmos = 500;
    const exprs = DesmosExport.toDesmosExpressions(equations.slice(0, maxDesmos));

    for (const expr of exprs) {
      calc.setExpression({
        id: expr.id,
        latex: expr.latex,
        color: '#2d70b3',
        lineWidth: 1.5,
        parametricDomain: { min: "0", max: "1" }
      });
    }
  }

  function loadDesmosRegression(equations) {
    const calc = ensureDesmosCalc();
    if (!calc) return;

    calc.setBlank();

    const colors = ['#2d70b3', '#388c46', '#fa7e19', '#6042a6', '#c74440', '#000000',
                    '#8b5cf6', '#06b6d4', '#10b981', '#ec4899', '#f59e0b'];

    const maxDesmos = 500;
    const limited = equations.slice(0, maxDesmos);

    for (let i = 0; i < limited.length; i++) {
      calc.setExpression({
        id: `reg_${i}`,
        latex: limited[i],
        color: colors[i % colors.length],
        lineWidth: 2
      });
    }
  }

  // =========================================================
  //  Export
  // =========================================================

  function copyAllEquations() {
    if (state.equations.length === 0) return;
    const text = DesmosExport.toPlainText(state.equations);
    navigator.clipboard.writeText(text).then(() => {
      showToast(`Copied ${state.equations.length} equations to clipboard`);
    });
  }

  function copySingle(index) {
    if (index < 0 || index >= state.equations.length) return;
    navigator.clipboard.writeText(state.equations[index]).then(() => {
      showToast('Equation copied!');
    });
  }

  function downloadEquations() {
    if (state.equations.length === 0) return;
    const text = DesmosExport.toPlainText(state.equations);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'desmos-equations.txt';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Equations downloaded!');
  }

  function openInDesmos() {
    // Open Desmos in a new tab
    // We can't directly load equations via URL, but we can open the calculator
    window.open('https://www.desmos.com/calculator', '_blank');
    showToast('Desmos opened. Paste equations from clipboard.', 'info');
  }

  // =========================================================
  //  Toast
  // =========================================================

  let toastTimeout = null;

  function showToast(message) {
    dom.toast.textContent = message;
    dom.toast.classList.add('visible');

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      dom.toast.classList.remove('visible');
    }, 3000);
  }

  // =========================================================
  //  Public API
  // =========================================================

  return {
    init,
    copySingle,
    onOpenCVReady
  };

})();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', App.init);
