# Icons needed for build

Place your icon files here before running `npm run build`:

- `icon.ico` — Windows (256x256 recommended, multi-size ICO)
- `icon.icns` — macOS  
- `icon.png` — Linux (512x512 PNG)

Tools to generate all three from a single PNG:
- https://www.icoconverter.com (ICO)
- https://cloudconvert.com/png-to-icns (ICNS)
- Or use electron-icon-builder: `npx electron-icon-builder --input=icon.png --output=assets`

If you skip icons, remove the icon fields from package.json build config
and electron-builder will use its default icon.
