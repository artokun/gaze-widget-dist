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

class GazeTracker extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        widgetLog('info', 'constructor called');

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

                .loading {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    color: #888;
                    font-family: system-ui, sans-serif;
                    font-size: 14px;
                }

                .error {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    color: #ff4444;
                    font-family: system-ui, sans-serif;
                    font-size: 14px;
                    text-align: center;
                    padding: 20px;
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
                <div class="loading">Loading...</div>
            </div>
        `;
    }

    async init() {
        widgetLog('info', `init started (${this.isMobile ? 'mobile' : 'desktop'}, grid=${this.gridSize})`);

        if (typeof PIXI === 'undefined') {
            widgetLog('info', 'loading PixiJS');
            await this.loadPixiJS();
            widgetLog('info', 'PixiJS loaded');
        }

        const container = this.shadowRoot.querySelector('.gaze-container');
        const loading = this.shadowRoot.querySelector('.loading');

        try {
            widgetLog('info', 'creating PIXI app');
            this.app = new PIXI.Application();
            // Start with a default size, will resize after loading sprites
            // Use Canvas2D for file:// protocol (WebGL has tainted canvas issues)
            const initOptions = {
                width: 512,
                height: 640,
                backgroundColor: 0x000000,
                backgroundAlpha: 0,
                resolution: 1,
                autoDensity: false
            };
            if (isOffline) {
                initOptions.preference = 'webgpu';  // Will fall back to webgl, then canvas
                initOptions.preferWebGLVersion = 1; // Older WebGL might work better
            }
            await this.app.init(initOptions);
            widgetLog('info', `PIXI app created (renderer: ${this.app.renderer.type})`);

            // Load sprites - src is root path, default to "/" if not set
            const src = this.getAttribute('src') || '/';
            widgetLog('info', `loading sprites from: ${src}`);
            await this.loadSprite(src);
            widgetLog('info', 'sprites loaded');

            // Only remove loading indicator after successful sprite load
            if (loading && loading.parentNode) {
                loading.remove();
            }
            container.appendChild(this.app.canvas);

            widgetLog('info', 'setting up tracking');
            this.setupMouseTracking();
            this.setupTouchTracking();
            this.setupGyroscope();
            this.setupFullscreenButton();
            this.setupGyroButton();
            this.setupResizeObserver();
            this.isInitialized = true;
            widgetLog('info', 'init complete');

        } catch (error) {
            widgetLog('error', `init error: ${error.message}`);
            console.error('Gaze Tracker init error:', error);

            // Check if this is a tainted canvas error (file:// protocol limitation)
            let errorMessage = 'Failed to load: ' + error.message;
            if (isOffline && (error.message.includes('Tainted') || error.message.includes('SecurityError'))) {
                errorMessage = 'Cannot load from file://. Please run a local server:\n\nnpx serve\n\nThen open http://localhost:3000';
            }

            if (loading && loading.parentNode) {
                loading.className = 'error';
                loading.textContent = errorMessage;
                loading.style.whiteSpace = 'pre-line';
            } else {
                // Loading element was removed, create error element
                const errorEl = document.createElement('div');
                errorEl.className = 'error';
                errorEl.textContent = errorMessage;
                errorEl.style.whiteSpace = 'pre-line';
                container.appendChild(errorEl);
            }
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

    async loadSprite(rootPath) {
        if (!this.app) return;

        try {
            // Clean up previous sprite
            if (this.sprite) {
                this.app.stage.removeChild(this.sprite);
                this.sprite.destroy();
                this.sprite = null;
            }
            this.quadrantTextures = {};
            this.textureCache = {};

            // Build quadrant URLs from root path
            // Desktop: q0.webp, q1.webp, q2.webp, q3.webp (15x15 each = 30x30 grid)
            // Mobile: q0_20.webp, q1_20.webp, q2_20.webp, q3_20.webp (10x10 each = 20x20 grid)
            const basePath = rootPath.endsWith('/') ? rootPath : rootPath + '/';

            let suffix = this.isMobile ? '_20' : '';
            let urls = [
                `${basePath}q0${suffix}.webp`,
                `${basePath}q1${suffix}.webp`,
                `${basePath}q2${suffix}.webp`,
                `${basePath}q3${suffix}.webp`
            ];

            widgetLog('info', `Loading quadrants: ${urls[0]}`);

            // Load textures - use Image elements for file:// protocol, PIXI.Assets for http
            let loaded;
            try {
                if (isOffline) {
                    // Load via Image elements (works with file:// protocol)
                    const images = await Promise.all(urls.map(url => this.loadImageElement(url)));
                    loaded = {};
                    urls.forEach((url, i) => {
                        loaded[url] = PIXI.Texture.from(images[i]);
                    });
                } else {
                    loaded = await PIXI.Assets.load(urls);
                }
            } catch (e) {
                if (this.isMobile && suffix === '_20') {
                    // Mobile sprites not found, fall back to desktop
                    widgetLog('info', 'Mobile sprites not found, falling back to desktop');
                    suffix = '';
                    this.gridSize = 30;
                    this.quadrantSize = 15;
                    this.currentCol = 15;
                    this.currentRow = 15;
                    this.targetCol = 15;
                    this.targetRow = 15;
                    urls = [
                        `${basePath}q0.webp`,
                        `${basePath}q1.webp`,
                        `${basePath}q2.webp`,
                        `${basePath}q3.webp`
                    ];
                    if (isOffline) {
                        const images = await Promise.all(urls.map(url => this.loadImageElement(url)));
                        loaded = {};
                        urls.forEach((url, i) => {
                            loaded[url] = PIXI.Texture.from(images[i]);
                        });
                    } else {
                        loaded = await PIXI.Assets.load(urls);
                    }
                } else {
                    throw e;
                }
            }
            this.quadrantTextures = {
                q0: loaded[urls[0]],
                q1: loaded[urls[1]],
                q2: loaded[urls[2]],
                q3: loaded[urls[3]]
            };

            // Verify all textures loaded
            if (!this.quadrantTextures.q0 || !this.quadrantTextures.q1 ||
                !this.quadrantTextures.q2 || !this.quadrantTextures.q3) {
                throw new Error('Failed to load sprite images');
            }

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
            const x = e.clientX / window.innerWidth;
            const y = e.clientY / window.innerHeight;
            this.targetCol = x * (this.gridSize - 1);
            this.targetRow = y * (this.gridSize - 1);
        };

        document.addEventListener('mousemove', this.mouseMoveHandler);
    }

    setupTouchTracking() {
        // Use TWO-finger pan for gaze control on mobile
        // Single finger is reserved for page scrolling
        this.touchStartHandler = (e) => {
            // Only activate with 2+ fingers to allow normal scrolling
            if (e.touches.length >= 2) {
                this.isTouching = true;
                // Use center point between first two touches
                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const x = ((t1.clientX + t2.clientX) / 2) / window.innerWidth;
                const y = ((t1.clientY + t2.clientY) / 2) / window.innerHeight;
                this.targetCol = x * (this.gridSize - 1);
                this.targetRow = y * (this.gridSize - 1);
            }
        };

        this.touchMoveHandler = (e) => {
            // Only respond to 2+ finger gestures
            if (e.touches.length >= 2) {
                this.isTouching = true;
                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const x = ((t1.clientX + t2.clientX) / 2) / window.innerWidth;
                const y = ((t1.clientY + t2.clientY) / 2) / window.innerHeight;
                this.targetCol = x * (this.gridSize - 1);
                this.targetRow = y * (this.gridSize - 1);
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
        if (!this.sprite) return;

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
