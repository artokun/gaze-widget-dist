/**
 * Gaze Tracker Web Component
 * A self-contained widget that displays an animated face following the cursor
 *
 * Usage:
 *   <gaze-tracker src="/path/to/session/"></gaze-tracker>
 *
 * Everything is auto-detected:
 *   - Device type: desktop uses 30x30 grid (q0-q3.webp), mobile uses 20x20 (q0_20-q3_20.webp)
 *   - Frame dimensions inferred from sprite size
 *
 * Optional attributes:
 *   src       - Root path to sprite files (default: "/")
 *   smoothing - Animation smoothing factor (default: 0.12)
 */

// Check if running from file:// protocol (offline/local mode)
const isOffline = typeof window !== 'undefined' && window.location.protocol === 'file:';

// Remote logger for widget (disabled when offline)
const widgetLog = (level, msg) => {
    if (isOffline) {
        console.log(`[Widget] ${msg}`);
        return;
    }
    fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, message: `[Widget] ${msg}`, userAgent: navigator.userAgent })
    }).catch(() => {});
};

// Generate unique instance IDs for widgets
let widgetInstanceCounter = 0;

// ============================================================================
// SHARED RENDERER MANAGER
// All gaze-tracker widgets share a single WebGL context to avoid browser limits
// ============================================================================
const GazeRendererManager = {
    renderer: null,
    rendererPromise: null,
    initQueue: [],
    isProcessingQueue: false,
    activeWidgets: new Set(),

    // Get or create the shared renderer
    async getRenderer() {
        // If renderer exists and is valid, return it
        if (this.renderer && !this.renderer.destroyed) {
            return this.renderer;
        }

        // If already creating, wait for it
        if (this.rendererPromise) {
            return this.rendererPromise;
        }

        // Create new shared renderer
        this.rendererPromise = this._createRenderer();
        this.renderer = await this.rendererPromise;
        this.rendererPromise = null;
        return this.renderer;
    },

    async _createRenderer() {
        widgetLog('info', 'Creating shared WebGL renderer');

        const options = {
            width: 512,
            height: 640,
            backgroundColor: 0x000000,
            backgroundAlpha: 0,
            resolution: 1,
            autoDensity: false,
            preferWebGLVersion: 2,
            failIfMajorPerformanceCaveat: false,
            // Don't create a canvas - each widget has its own
            canvas: document.createElement('canvas')
        };

        if (isOffline) {
            options.preference = 'webgpu';
            options.preferWebGLVersion = 1;
        }

        const renderer = await PIXI.autoDetectRenderer(options);
        widgetLog('info', `Shared renderer created (type: ${renderer.type})`);
        return renderer;
    },

    // Queue a widget for initialization (sequential processing)
    queueInit(widget) {
        return new Promise((resolve, reject) => {
            this.initQueue.push({ widget, resolve, reject });
            this._processQueue();
        });
    },

    async _processQueue() {
        if (this.isProcessingQueue || this.initQueue.length === 0) return;

        this.isProcessingQueue = true;

        while (this.initQueue.length > 0) {
            const { widget, resolve, reject } = this.initQueue.shift();
            try {
                await widget._doInit();
                this.activeWidgets.add(widget);
                resolve();
            } catch (err) {
                reject(err);
            }
            // Small delay between inits to let GPU settle
            if (this.initQueue.length > 0) {
                await new Promise(r => setTimeout(r, 50));
            }
        }

        this.isProcessingQueue = false;
    },

    // Unregister a widget when it's destroyed
    unregisterWidget(widget) {
        this.activeWidgets.delete(widget);

        // If no more widgets, we could destroy the renderer
        // But keeping it around is fine - it's just one context
        if (this.activeWidgets.size === 0) {
            widgetLog('info', 'All widgets removed, shared renderer idle');
        }
    }
};

class GazeTracker extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        // Unique instance ID to prevent cache collisions between multiple widgets
        this.instanceId = ++widgetInstanceCounter;
        widgetLog('info', `constructor called (instance ${this.instanceId})`);

        // Auto-detect mobile vs desktop (user agent only - window width is unreliable)
        this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        // State - grid is 30 for desktop, 20 for mobile
        this.app = null;
        this.sprite = null;
        this.quadrantTextures = {};
        this.gridSize = this.isMobile ? 20 : 30;
        this.quadrantSize = this.gridSize / 2;
        this.imageWidth = null;  // Auto-detected
        this.imageHeight = null; // Auto-detected
        this.currentCol = this.gridSize / 2;
        this.currentRow = this.gridSize / 2;
        this.targetCol = this.gridSize / 2;
        this.targetRow = this.gridSize / 2;
        this.smoothing = 0.12;
        this.isInitialized = false;
        this.isInitializing = false;
        this.resizeObserver = null;
        this.textureCache = {};
        this.gyroEnabled = false;
        this.isTouching = false;
        this.isMobileFullscreen = false;  // CSS-based fullscreen for mobile
        this.contextLost = false;  // WebGL context loss flag
    }

    static get observedAttributes() {
        return ['src', 'smoothing', 'hide-controls'];
    }

    connectedCallback() {
        widgetLog('info', 'connectedCallback');
        this.render();
        // Only auto-init if src attribute is set
        // Otherwise wait for src to be set via JavaScript
        const src = this.getAttribute('src');
        if (src) {
            this.init().catch(err => {
                widgetLog('error', `init failed: ${err.message}`);
                console.error('GazeTracker init failed:', err);
            });
        } else {
            widgetLog('info', 'waiting for src attribute to be set');
        }
    }

    disconnectedCallback() {
        this.cleanup();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return;

        switch (name) {
            case 'smoothing':
                this.smoothing = parseFloat(newValue) || 0.12;
                break;
            case 'src':
                if (this.isInitialized) {
                    // Already initialized, just load new sprites
                    this.loadSprite(newValue || '/');
                } else if (newValue && !this.isInitializing) {
                    // Not initialized yet but src is now set - initialize
                    this.isInitializing = true;
                    this.init().catch(err => {
                        widgetLog('error', `init failed: ${err.message}`);
                        console.error('GazeTracker init failed:', err);
                    }).finally(() => {
                        this.isInitializing = false;
                    });
                }
                break;
        }
    }

    render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                    width: 100%;
                    height: 100%;
                    overflow: hidden;
                    position: relative;
                }

                .gaze-container {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    background: transparent;
                    overflow: hidden;
                    position: relative;
                }

                .gaze-container canvas {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                }

                canvas {
                    display: block;
                }

                .placeholder-img {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    object-fit: contain;
                    object-position: center;
                    opacity: 1;
                    transition: opacity 0.3s ease-out;
                }

                .placeholder-img.fade-out {
                    opacity: 0;
                    pointer-events: none;
                }

                .spinner-overlay {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.3);
                    transition: opacity 0.3s ease-out;
                }

                .spinner-overlay.hidden {
                    opacity: 0;
                    pointer-events: none;
                }

                .spinner {
                    width: 48px;
                    height: 48px;
                    border: 4px solid rgba(255, 255, 255, 0.3);
                    border-top-color: #fff;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }

                @keyframes spin {
                    to { transform: rotate(360deg); }
                }

                .controls {
                    position: absolute;
                    top: 10px;
                    right: 10px;
                    display: flex;
                    gap: 8px;
                    z-index: 100;
                    opacity: 0.5;
                    transition: opacity 0.2s;
                }

                :host([hide-controls]) .controls {
                    display: none;
                }

                :host(:hover) .controls,
                .controls:focus-within {
                    opacity: 1;
                }

                @media (pointer: coarse) {
                    .controls {
                        opacity: 1;
                    }
                }

                .ctrl-btn {
                    background: rgba(0, 0, 0, 0.6);
                    border: 2px solid rgba(255, 255, 255, 0.3);
                    padding: 8px 12px;
                    font-size: 1.2rem;
                    color: #fff;
                    border-radius: 8px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .ctrl-btn:hover {
                    background: rgba(0, 0, 0, 0.8);
                    border-color: #ff6b6b;
                }

                .ctrl-btn.active {
                    background: rgba(255, 107, 107, 0.6);
                    border-color: #ff6b6b;
                }

                :host(:fullscreen),
                :host(:-webkit-full-screen) {
                    width: 100vw !important;
                    height: 100vh !important;
                }

                :host(:fullscreen) .gaze-container,
                :host(:-webkit-full-screen) .gaze-container {
                    background: #000;
                }

                :host(:fullscreen) .controls,
                :host(:-webkit-full-screen) .controls {
                    opacity: 1;
                }

                /* CSS-based fullscreen for mobile (Fullscreen API doesn't work reliably) */
                :host(.mobile-fullscreen) {
                    position: fixed !important;
                    inset: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    z-index: 999999 !important;
                }

                :host(.mobile-fullscreen) .gaze-container {
                    background: #000;
                }

                :host(.mobile-fullscreen) .controls {
                    opacity: 1;
                }
            </style>
            <div class="controls">
                <button class="ctrl-btn gyro-btn" title="Toggle gyroscope control">&#x1F4F1;</button>
                <button class="ctrl-btn fullscreen-btn" title="Toggle fullscreen">&#x26F6;</button>
            </div>
            <div class="gaze-container">
                <img class="placeholder-img" style="display: none;" alt="" />
                <div class="spinner-overlay" style="display: none;">
                    <div class="spinner"></div>
                </div>
            </div>
        `;
    }

    async init() {
        widgetLog('info', `init started (instance ${this.instanceId}, ${this.isMobile ? 'mobile' : 'desktop'}, grid=${this.gridSize})`);

        // Try to show placeholder image immediately while we load
        const src = this.getAttribute('src') || '/';
        this._showPlaceholder(src);

        if (typeof PIXI === 'undefined') {
            widgetLog('info', 'loading PixiJS');
            await this.loadPixiJS();
            widgetLog('info', 'PixiJS loaded');
        }

        // Queue initialization through the shared manager
        // This ensures sequential init and shared renderer
        try {
            await GazeRendererManager.queueInit(this);
        } catch (error) {
            widgetLog('error', `init error: ${error.message}`);
            console.error('Gaze Tracker init error:', error);
            // Graceful degradation: just hide spinner and show static image
            this._hideSpinnerOnly();
        }
    }

    // Show input.jpg as placeholder while loading
    _showPlaceholder(src) {
        const placeholder = this.shadowRoot.querySelector('.placeholder-img');
        const spinner = this.shadowRoot.querySelector('.spinner-overlay');
        if (!placeholder) return;

        const basePath = src.endsWith('/') ? src : src + '/';
        // Try input.jpg first (in gaze_output), then parent dir
        const possiblePaths = [
            `${basePath}../input.jpg`,  // One level up from gaze_output
            `${basePath}input.jpg`,
        ];

        // Try each path
        const tryPath = (index) => {
            if (index >= possiblePaths.length) {
                // No placeholder found, show spinner without image
                if (spinner) spinner.style.display = 'flex';
                return;
            }
            const img = new Image();
            img.onload = () => {
                placeholder.src = possiblePaths[index];
                placeholder.style.display = 'block';
                if (spinner) spinner.style.display = 'flex';
                widgetLog('info', `Placeholder loaded: ${possiblePaths[index]}`);
            };
            img.onerror = () => tryPath(index + 1);
            img.src = possiblePaths[index];
        };
        tryPath(0);
    }

    // Hide spinner when canvas is ready, but keep placeholder behind as fallback
    _hidePlaceholder() {
        const spinner = this.shadowRoot.querySelector('.spinner-overlay');

        if (spinner) {
            spinner.classList.add('hidden');
            setTimeout(() => spinner.remove(), 300);
        }

        // Keep placeholder image behind canvas as fallback - don't remove it
    }

    // Hide spinner but keep placeholder on error (graceful degradation)
    _hideSpinnerOnly() {
        const spinner = this.shadowRoot.querySelector('.spinner-overlay');
        if (spinner) {
            spinner.classList.add('hidden');
            setTimeout(() => spinner.remove(), 300);
        }
        widgetLog('info', 'Graceful degradation: showing static image');
    }

    // Internal init called by the renderer manager (sequential)
    async _doInit() {
        const container = this.shadowRoot.querySelector('.gaze-container');

        try {
            // Get the shared renderer (creates if needed)
            const sharedRenderer = await GazeRendererManager.getRenderer();
            widgetLog('info', `Using shared renderer (instance ${this.instanceId})`);

            // Create app with its own canvas but shared renderer resources
            this.app = new PIXI.Application();
            await this.app.init({
                width: 512,
                height: 640,
                backgroundColor: 0x000000,
                backgroundAlpha: 0,
                resolution: 1,
                autoDensity: false,
                // Use the shared renderer's context/settings
                preferWebGLVersion: 2,
                failIfMajorPerformanceCaveat: false,
                // Share WebGL context via same preference
                sharedTicker: false  // Each widget has its own animation loop
            });

            // Handle WebGL context loss gracefully
            const canvas = this.app.canvas;
            canvas.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                widgetLog('warn', `WebGL context lost (instance ${this.instanceId})`);
                this.contextLost = true;
            });
            canvas.addEventListener('webglcontextrestored', () => {
                widgetLog('info', `WebGL context restored (instance ${this.instanceId})`);
                this.contextLost = false;
                const src = this.getAttribute('src') || '/';
                this.loadSprite(src).catch(err => {
                    widgetLog('error', `Failed to restore after context loss: ${err.message}`);
                });
            });
            widgetLog('info', `PIXI app created (instance ${this.instanceId}, renderer: ${this.app.renderer.type})`);

            // Load sprites - src is root path, default to "/" if not set
            const src = this.getAttribute('src') || '/';
            widgetLog('info', `loading sprites from: ${src}`);
            await this.loadSprite(src);
            widgetLog('info', 'sprites loaded');

            container.appendChild(this.app.canvas);

            // Fade out placeholder image now that canvas is ready
            this._hidePlaceholder();

            widgetLog('info', 'setting up tracking');
            this.setupMouseTracking();
            this.setupTouchTracking();
            this.setupGyroscope();
            this.setupFullscreenButton();
            this.setupGyroButton();
            this.setupResizeObserver();
            this.isInitialized = true;

            // Force immediate render at center position (don't wait for mouse)
            const centerPos = Math.floor(this.gridSize / 2);
            this.currentCol = centerPos;
            this.currentRow = centerPos;
            this.targetCol = centerPos;
            this.targetRow = centerPos;
            this.updateFrame(centerPos, centerPos);

            widgetLog('info', `init complete (instance ${this.instanceId})`);

        } catch (error) {
            widgetLog('error', `_doInit error: ${error.message}`);
            console.error('Gaze Tracker init error:', error);
            // Graceful degradation: hide spinner and show static placeholder
            this._hideSpinnerOnly();
            // Re-throw so the queue manager knows this widget failed
            throw error;
        }
    }

    async loadPixiJS() {
        return new Promise((resolve, reject) => {
            if (typeof PIXI !== 'undefined') {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = 'https://pixijs.download/v8.6.6/pixi.min.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load PixiJS'));
            document.head.appendChild(script);
        });
    }

    // Load image via Image element (works with file:// protocol)
    loadImageElement(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            // Don't set crossOrigin for file:// protocol - it causes CORS errors
            if (!isOffline) {
                img.crossOrigin = 'anonymous';
            }
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
            img.src = url;
        });
    }

    // Load a single texture with explicit verification
    async loadSingleTexture(url, quadrantName) {
        widgetLog('info', `Loading ${quadrantName}: ${url}`);

        let texture;
        if (isOffline) {
            const img = await this.loadImageElement(url);
            texture = PIXI.Texture.from(img);
        } else {
            // Load individually to ensure no cache confusion
            // Add cache-busting for this widget instance
            texture = await PIXI.Assets.load(url);
        }

        // Wait for texture to be fully ready
        if (!texture.source.resource) {
            await new Promise(resolve => {
                if (texture.source.resource) {
                    resolve();
                } else {
                    texture.source.once('loaded', resolve);
                    texture.source.once('error', resolve);
                }
            });
        }

        // Verify texture is valid
        if (!texture || !texture.source || texture.width === 0 || texture.height === 0) {
            throw new Error(`Invalid texture for ${quadrantName}: ${url}`);
        }

        widgetLog('info', `${quadrantName} loaded: ${texture.width}x${texture.height}`);
        return texture;
    }

    async loadSprite(rootPath) {
        if (!this.app) return;

        try {
            // Clean up previous sprite and textures completely
            if (this.sprite) {
                this.app.stage.removeChild(this.sprite);
                this.sprite.destroy();
                this.sprite = null;
            }

            // Clear all cached textures for this instance
            this.quadrantTextures = {};
            this.textureCache = {};

            // Build quadrant URLs from root path
            // Desktop: q0.webp, q1.webp, q2.webp, q3.webp (15x15 each = 30x30 grid)
            // Mobile: q0_20.webp, q1_20.webp, q2_20.webp, q3_20.webp (10x10 each = 20x20 grid)
            const basePath = rootPath.endsWith('/') ? rootPath : rootPath + '/';
            let suffix = this.isMobile ? '_20' : '';

            // Load each quadrant INDIVIDUALLY and SEQUENTIALLY to prevent any race conditions
            // This is slower but guarantees correct texture assignment
            const quadrantNames = ['q0', 'q1', 'q2', 'q3'];
            const loadedTextures = {};

            for (const qName of quadrantNames) {
                const url = `${basePath}${qName}${suffix}.webp`;
                try {
                    loadedTextures[qName] = await this.loadSingleTexture(url, qName);
                } catch (e) {
                    // If mobile sprites fail, try desktop fallback
                    if (this.isMobile && suffix === '_20') {
                        widgetLog('info', `Mobile ${qName} not found, trying desktop fallback`);
                        suffix = '';
                        this.gridSize = 30;
                        this.quadrantSize = 15;
                        this.currentCol = 15;
                        this.currentRow = 15;
                        this.targetCol = 15;
                        this.targetRow = 15;

                        // Reload all with desktop suffix
                        for (const q of quadrantNames) {
                            const desktopUrl = `${basePath}${q}.webp`;
                            loadedTextures[q] = await this.loadSingleTexture(desktopUrl, q);
                        }
                        break;
                    } else {
                        throw e;
                    }
                }
            }

            // Explicitly assign each quadrant - no ambiguity
            this.quadrantTextures = {
                q0: loadedTextures.q0,
                q1: loadedTextures.q1,
                q2: loadedTextures.q2,
                q3: loadedTextures.q3
            };

            // VERIFY: All textures must exist and be valid
            for (const [name, tex] of Object.entries(this.quadrantTextures)) {
                if (!tex) {
                    throw new Error(`Missing texture for ${name}`);
                }
                if (!tex.source || tex.width === 0 || tex.height === 0) {
                    throw new Error(`Invalid texture for ${name}: ${tex.width}x${tex.height}`);
                }
            }

            // VERIFY: All quadrant textures should have the same dimensions
            const q0Width = this.quadrantTextures.q0.width;
            const q0Height = this.quadrantTextures.q0.height;
            for (const [name, tex] of Object.entries(this.quadrantTextures)) {
                if (tex.width !== q0Width || tex.height !== q0Height) {
                    widgetLog('error', `Dimension mismatch: ${name} is ${tex.width}x${tex.height}, expected ${q0Width}x${q0Height}`);
                    throw new Error(`Quadrant dimension mismatch for ${name}`);
                }
            }

            // VERIFY: All quadrant textures should have DIFFERENT sources (not duplicates)
            const sourceIds = new Set();
            for (const [name, tex] of Object.entries(this.quadrantTextures)) {
                const sourceId = tex.source.uid || tex.source._resourceId || tex.source.label;
                if (sourceId && sourceIds.has(sourceId)) {
                    widgetLog('error', `Duplicate texture source detected for ${name}`);
                    // Don't throw - sources might legitimately share in some PIXI versions
                    // But log it for debugging
                }
                if (sourceId) sourceIds.add(sourceId);
            }

            widgetLog('info', `All 4 quadrants verified: ${q0Width}x${q0Height} each`);

            // Infer frame dimensions from sprite size
            // Each quadrant sprite contains quadrantSize x quadrantSize frames
            const spriteWidth = this.quadrantTextures.q0.width;
            const spriteHeight = this.quadrantTextures.q0.height;
            this.imageWidth = Math.round(spriteWidth / this.quadrantSize);
            this.imageHeight = Math.round(spriteHeight / this.quadrantSize);

            // Cap frame dimensions at 1000px (WebP practical limit for smooth animation)
            const MAX_FRAME_SIZE = 1000;
            if (this.imageWidth > MAX_FRAME_SIZE || this.imageHeight > MAX_FRAME_SIZE) {
                const scale = MAX_FRAME_SIZE / Math.max(this.imageWidth, this.imageHeight);
                this.imageWidth = Math.round(this.imageWidth * scale);
                this.imageHeight = Math.round(this.imageHeight * scale);
                widgetLog('info', `Capped frame size to ${this.imageWidth}x${this.imageHeight}`);
            }

            // Resize PIXI app to match frame dimensions
            this.app.renderer.resize(this.imageWidth, this.imageHeight);
            widgetLog('info', `Frame size: ${this.imageWidth}x${this.imageHeight}, grid: ${this.gridSize}x${this.gridSize}`);

            // Create sprite with initial texture BEFORE adding to stage
            // This prevents PIXI from rendering a default/empty texture
            const centerFrame = Math.floor(this.gridSize / 2);
            const initialTexture = this.getTextureForCell(centerFrame, centerFrame);

            this.sprite = new PIXI.Sprite(initialTexture);
            this.sprite.anchor.set(0, 0);

            // Scale sprite to fill canvas
            this.updateSpriteScale();

            // Now add to stage with proper texture already set
            this.app.stage.addChild(this.sprite);

            // Start animation loop
            this.app.ticker.add(this.animate.bind(this));

        } catch (error) {
            widgetLog('error', `Failed to load sprites: ${error.message}`);
            throw error;  // Re-throw to show error in UI
        }
    }

    updateSpriteScale() {
        if (!this.sprite || !this.app) return;

        const canvasWidth = this.app.renderer.width;
        const canvasHeight = this.app.renderer.height;

        // Calculate scale to fit image inside canvas while maintaining aspect ratio
        const scaleX = canvasWidth / this.imageWidth;
        const scaleY = canvasHeight / this.imageHeight;
        const scale = Math.min(scaleX, scaleY);

        // Apply scale
        this.sprite.scale.set(scale, scale);

        // Center the sprite in the canvas
        this.sprite.x = (canvasWidth - this.imageWidth * scale) / 2;
        this.sprite.y = (canvasHeight - this.imageHeight * scale) / 2;
    }

    getTextureForCell(row, col) {
        const half = this.quadrantSize;
        let quadrant, localRow, localCol;

        // Determine which quadrant and local position
        if (row < half && col < half) {
            quadrant = this.quadrantTextures.q0;
            localRow = row;
            localCol = col;
        } else if (row < half && col >= half) {
            quadrant = this.quadrantTextures.q1;
            localRow = row;
            localCol = col - half;
        } else if (row >= half && col < half) {
            quadrant = this.quadrantTextures.q2;
            localRow = row - half;
            localCol = col;
        } else {
            quadrant = this.quadrantTextures.q3;
            localRow = row - half;
            localCol = col - half;
        }

        if (!quadrant) return null;

        // Cache textures for performance
        const key = `${row}_${col}`;
        if (!this.textureCache[key]) {
            const cellX = localCol * this.imageWidth;
            const cellY = localRow * this.imageHeight;
            const frame = new PIXI.Rectangle(cellX, cellY, this.imageWidth, this.imageHeight);
            this.textureCache[key] = new PIXI.Texture({ source: quadrant.source, frame });
        }
        return this.textureCache[key];
    }

    updateFrame(row, col) {
        if (!this.sprite) return;
        const texture = this.getTextureForCell(row, col);
        if (texture) {
            this.sprite.texture = texture;
        }
    }

    setupMouseTracking() {
        this.mouseMoveHandler = (e) => {
            if (this.gyroEnabled) return;

            // Get widget's position on screen
            const rect = this.getBoundingClientRect();
            const widgetCenterX = rect.left + rect.width / 2;
            const widgetCenterY = rect.top + rect.height / 2;

            // Calculate direction from widget center to mouse
            const deltaX = e.clientX - widgetCenterX;
            const deltaY = e.clientY - widgetCenterY;

            // Normalize based on screen size (mouse at screen edge = max gaze)
            // Use the larger dimension for consistent sensitivity
            const maxDistance = Math.max(window.innerWidth, window.innerHeight) / 2;
            const normalizedX = Math.max(-1, Math.min(1, deltaX / maxDistance));
            const normalizedY = Math.max(-1, Math.min(1, deltaY / maxDistance));

            // Map to grid coordinates (center = gridSize/2)
            const center = (this.gridSize - 1) / 2;
            this.targetCol = center + normalizedX * center;
            this.targetRow = center + normalizedY * center;
        };

        document.addEventListener('mousemove', this.mouseMoveHandler);
    }

    setupTouchTracking() {
        // Use TWO-finger pan for gaze control on mobile
        // Single finger is reserved for page scrolling

        // Helper to calculate gaze from touch position
        const updateGazeFromTouch = (touchX, touchY) => {
            const rect = this.getBoundingClientRect();
            const widgetCenterX = rect.left + rect.width / 2;
            const widgetCenterY = rect.top + rect.height / 2;

            const deltaX = touchX - widgetCenterX;
            const deltaY = touchY - widgetCenterY;

            const maxDistance = Math.max(window.innerWidth, window.innerHeight) / 2;
            const normalizedX = Math.max(-1, Math.min(1, deltaX / maxDistance));
            const normalizedY = Math.max(-1, Math.min(1, deltaY / maxDistance));

            const center = (this.gridSize - 1) / 2;
            this.targetCol = center + normalizedX * center;
            this.targetRow = center + normalizedY * center;
        };

        this.touchStartHandler = (e) => {
            // Only activate with 2+ fingers to allow normal scrolling
            if (e.touches.length >= 2) {
                this.isTouching = true;
                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const touchX = (t1.clientX + t2.clientX) / 2;
                const touchY = (t1.clientY + t2.clientY) / 2;
                updateGazeFromTouch(touchX, touchY);
            }
        };

        this.touchMoveHandler = (e) => {
            // Only respond to 2+ finger gestures
            if (e.touches.length >= 2) {
                this.isTouching = true;
                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const touchX = (t1.clientX + t2.clientX) / 2;
                const touchY = (t1.clientY + t2.clientY) / 2;
                updateGazeFromTouch(touchX, touchY);
            }
        };

        this.touchEndHandler = (e) => {
            // Only release when all fingers lifted
            if (e.touches.length < 2) {
                this.isTouching = false;
            }
        };

        document.addEventListener('touchstart', this.touchStartHandler, { passive: true });
        document.addEventListener('touchmove', this.touchMoveHandler, { passive: true });
        document.addEventListener('touchend', this.touchEndHandler, { passive: true });
    }

    setupGyroscope() {
        if (!window.DeviceOrientationEvent) return;

        this.deviceOrientationHandler = (e) => {
            if (!this.gyroEnabled || this.isTouching) return;

            // Check if we have valid data
            if (e.beta === null || e.gamma === null) return;

            const beta = e.beta;   // -180 to 180 (front/back tilt)
            const gamma = e.gamma; // -90 to 90 (left/right tilt)

            // Normalize: assume phone held at ~45 degrees
            const neutralBeta = 45;
            const betaNorm = Math.max(0, Math.min(1, (beta - neutralBeta + 30) / 60));
            const gammaNorm = Math.max(0, Math.min(1, (gamma + 30) / 60));

            this.targetCol = gammaNorm * (this.gridSize - 1);
            this.targetRow = betaNorm * (this.gridSize - 1);
        };
    }

    async enableGyro() {
        // iOS 13+ requires permission request from user gesture
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceOrientationEvent.requestPermission();
                if (permission !== 'granted') {
                    console.log('Gyro permission denied');
                    return false;
                }
            } catch (e) {
                console.error('Gyro permission error:', e);
                return false;
            }
        }

        // Add listener only after permission granted
        if (this.deviceOrientationHandler) {
            window.addEventListener('deviceorientation', this.deviceOrientationHandler, true);
        }
        return true;
    }

    setupGyroButton() {
        const btn = this.shadowRoot.querySelector('.gyro-btn');
        if (!btn) return;

        // Show on touch devices (mobile/tablet)
        const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        if (!hasTouch) {
            btn.style.display = 'none';
            return;
        }

        btn.addEventListener('click', async () => {
            if (!this.gyroEnabled) {
                // Turning on - request permission if needed
                const success = await this.enableGyro();
                if (success) {
                    this.gyroEnabled = true;
                    btn.classList.add('active');
                }
            } else {
                // Turning off
                this.gyroEnabled = false;
                btn.classList.remove('active');
                if (this.deviceOrientationHandler) {
                    window.removeEventListener('deviceorientation', this.deviceOrientationHandler);
                }
            }
        });
    }

    setupFullscreenButton() {
        const btn = this.shadowRoot.querySelector('.fullscreen-btn');
        if (!btn) return;

        // Update button icon based on fullscreen state
        const updateIcon = () => {
            const isNativeFullscreen = document.fullscreenElement === this ||
                                       document.webkitFullscreenElement === this;
            const isFullscreen = isNativeFullscreen || this.isMobileFullscreen;
            btn.innerHTML = isFullscreen ? '&#x2715;' : '&#x26F6;';
        };

        btn.addEventListener('click', () => {
            // Check if we're on mobile (touch device)
            const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

            // Check various fullscreen states
            const isNativeFullscreen = document.fullscreenElement === this ||
                                       document.webkitFullscreenElement === this;

            if (this.isMobileFullscreen) {
                // Exit CSS-based mobile fullscreen
                this.isMobileFullscreen = false;
                this.classList.remove('mobile-fullscreen');
                document.body.style.overflow = '';
                updateIcon();
            } else if (isNativeFullscreen) {
                // Exit native fullscreen
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            } else if (isTouchDevice) {
                // Mobile: Use CSS-based fullscreen (more reliable than Fullscreen API)
                this.isMobileFullscreen = true;
                this.classList.add('mobile-fullscreen');
                document.body.style.overflow = 'hidden';
                updateIcon();
                // Trigger resize to update canvas
                if (this.resizeObserver) {
                    setTimeout(() => {
                        this.resizeObserver.disconnect();
                        this.resizeObserver.observe(this);
                    }, 100);
                }
            } else {
                // Desktop: Try native fullscreen API
                if (this.requestFullscreen) {
                    this.requestFullscreen().catch(err => {
                        console.error('Fullscreen error:', err);
                        // Fallback to CSS fullscreen
                        this.isMobileFullscreen = true;
                        this.classList.add('mobile-fullscreen');
                        document.body.style.overflow = 'hidden';
                        updateIcon();
                    });
                } else if (this.webkitRequestFullscreen) {
                    this.webkitRequestFullscreen();
                }
            }
        });

        document.addEventListener('fullscreenchange', updateIcon);
        document.addEventListener('webkitfullscreenchange', updateIcon);
    }

    animate() {
        // Skip rendering if context is lost or sprite not ready
        if (!this.sprite || this.contextLost) return;

        this.currentCol += (this.targetCol - this.currentCol) * this.smoothing;
        this.currentRow += (this.targetRow - this.currentRow) * this.smoothing;

        const col = Math.round(Math.max(0, Math.min(this.gridSize - 1, this.currentCol)));
        const row = Math.round(Math.max(0, Math.min(this.gridSize - 1, this.currentRow)));

        this.updateFrame(row, col);
    }

    setupResizeObserver() {
        try {
            this.resizeObserver = new ResizeObserver((entries) => {
                try {
                    if (!this.app || !this.app.canvas) return;

                    const entry = entries[0];
                    const { width, height } = entry.contentRect;

                    if (width === 0 || height === 0) return;

                    // Make canvas fill the entire container
                    const canvasWidth = width;
                    const canvasHeight = height;

                    // Update PixiJS renderer size to match container
                    this.app.renderer.resize(Math.floor(canvasWidth), Math.floor(canvasHeight));

                    // Update canvas display size (CSS) - let it fill container
                    this.app.canvas.style.width = '100%';
                    this.app.canvas.style.height = '100%';

                    // Scale sprite to fill the entire canvas
                    this.updateSpriteScale();
                } catch (e) {
                    console.error('ResizeObserver callback error:', e);
                }
            });
            this.resizeObserver.observe(this);
        } catch (e) {
            console.error('setupResizeObserver error:', e);
        }
    }

    cleanup() {
        // Unregister from the shared manager
        GazeRendererManager.unregisterWidget(this);

        if (this.mouseMoveHandler) {
            document.removeEventListener('mousemove', this.mouseMoveHandler);
        }
        if (this.touchStartHandler) {
            document.removeEventListener('touchstart', this.touchStartHandler);
        }
        if (this.touchMoveHandler) {
            document.removeEventListener('touchmove', this.touchMoveHandler);
        }
        if (this.touchEndHandler) {
            document.removeEventListener('touchend', this.touchEndHandler);
        }
        if (this.deviceOrientationHandler) {
            window.removeEventListener('deviceorientation', this.deviceOrientationHandler);
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        if (this.app) {
            this.app.destroy(true, { children: true, texture: true });
            this.app = null;
        }
    }
}

if (!customElements.get('gaze-tracker')) {
    customElements.define('gaze-tracker', GazeTracker);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = GazeTracker;
}
