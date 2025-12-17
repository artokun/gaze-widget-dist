# Gaze Tracker Widget

A self-contained web component that displays an animated face that follows the user's cursor. Built with PixiJS for smooth WebGL-powered rendering.

## Demo Files

- **demo-fullscreen.html** - Full page background demo
- **demo-resizable.html** - Resizable container with flexbox layout

Just double-click these files to see the widget in action!

## Quick Start

```html
<script src="https://cdn.jsdelivr.net/gh/artokun/gaze-widget-dist@v1.0.4/gaze-tracker.js"></script>
<gaze-tracker src="/path/to/sprites/"></gaze-tracker>
```

That's it! The widget auto-detects everything from your sprite files.

## Controls

- **Desktop**: Move mouse cursor to control gaze direction
- **Mobile**: Use two-finger pan gesture (single finger scrolls the page)
- **Gyroscope** (mobile): Tap the phone icon to enable device tilt control
- **Fullscreen**: Tap the expand icon (works on both desktop and mobile)

## How It Works

The widget expects quadrant sprite files in the specified directory:
- **Desktop (30x30 grid)**: `q0.webp`, `q1.webp`, `q2.webp`, `q3.webp`
- **Mobile (20x20 grid)**: `q0_20.webp`, `q1_20.webp`, `q2_20.webp`, `q3_20.webp`

The widget automatically:
- Detects if user is on mobile or desktop
- Loads the appropriate sprite set
- Falls back to desktop sprites if mobile sprites aren't available
- Infers frame dimensions from sprite size

## Attributes

| Attribute | Description | Default |
|-----------|-------------|---------|
| `src` | Root path to sprite files directory | `/` |
| `smoothing` | Animation smoothness (0.01-0.5) | 0.12 |

## Sizing Behavior

The widget automatically fills its container using `object-fit: cover` with center positioning. This means:

- It will always fill the entire container
- The image will be cropped (not stretched) if aspect ratios don't match
- The face will remain centered

### Full Page Background

```html
<style>
  body, html { margin: 0; padding: 0; height: 100%; }
</style>
<gaze-tracker src="/my-sprites/"
    style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1;">
</gaze-tracker>
```

### Fixed Size Container

```html
<div style="width: 400px; height: 500px; border-radius: 20px; overflow: hidden;">
    <gaze-tracker src="/my-sprites/"></gaze-tracker>
</div>
```

### Responsive Container

```html
<div style="width: 100%; max-width: 600px; aspect-ratio: 4/5;">
    <gaze-tracker src="/my-sprites/"></gaze-tracker>
</div>
```

### Hero Section

```html
<section style="height: 100vh; position: relative;">
    <gaze-tracker src="/my-sprites/"
        style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;">
    </gaze-tracker>
    <div style="position: relative; z-index: 1; text-align: center; padding-top: 40vh;">
        <h1>Welcome</h1>
    </div>
</section>
```

## JavaScript API

You can also control the widget programmatically:

```javascript
const tracker = document.querySelector('gaze-tracker');

// Change the sprite source
tracker.setAttribute('src', '/new-sprites/');

// Adjust smoothing (lower = smoother but laggier)
tracker.setAttribute('smoothing', '0.08');
```

## CDN Usage

```html
<script src="https://cdn.jsdelivr.net/gh/artokun/gaze-widget-dist@v1.0.4/gaze-tracker.js"></script>
<gaze-tracker src="https://your-site.com/sprites/"></gaze-tracker>
```

## Browser Support

- Chrome 67+
- Firefox 63+
- Safari 14+
- Edge 79+

Requires WebGL support.

## Performance Tips

1. **Sprite size**: Keep sprite sheets under 16384x16384 pixels (GPU texture limit)
2. **Grid size**: 30x30 (900 frames) for desktop, 20x20 (400 frames) for mobile
3. **Image format**: Use WebP for best compression
4. **Mobile fallback**: If mobile sprites aren't provided, desktop sprites are used

## Troubleshooting

### "Failed to initialize" error
- Check that your browser supports WebGL
- Ensure the sprite files exist at the specified path

### Choppy animation
- Reduce the `smoothing` value (e.g., 0.08)
- Check that hardware acceleration is enabled in your browser

### Image doesn't fill container
- The widget uses `object-fit: cover` - this is intentional to maintain aspect ratio
- If you need stretching, you can override the canvas styles

## License

MIT License - Free for personal and commercial use.
