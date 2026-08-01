# Obsidian Canvas image-embed stretch fix

## Scope

The CSS fix in [styles.css](../../styles.css) applies to Excalidraw embeddables
whose local GIF/WebP/APNG files use Obsidian's native image view.

## Upstream behavior

The Obsidian Excalidraw plugin mounts local embeddables through core Canvas file
nodes. The outer Canvas node fills the Excalidraw element, but Obsidian's native
`.image-container` shrink-wraps to the image's intrinsic dimensions. Resizing the
element therefore leaves the animated image pinned at its original size.

This is an Obsidian Canvas limitation; see:

- [Images are not enlarged beyond their base resolution](https://forum.obsidian.md/t/canvas-images-are-not-enlarged-resized-beyond-their-base-resolution/112614)
- [Support upscaling/stretching of external images](https://forum.obsidian.md/t/canvas-support-upscaling-stretching-of-external-images/50149)

## Host-plugin fix

The rules are scoped to `.canvas-node` so normal note images are unaffected:

```css
.canvas-node .image-container {
	width: 100% !important;
	height: 100% !important;
}
.canvas-node .image-container img {
	width: 100% !important;
	height: 100% !important;
	object-fit: cover !important;
	display: block !important;
}
```

The container rule is required; sizing only the `<img>` still measures against
the shrink-wrapped parent. Verify changes with a GIF and video embeddable resized
side by side.
