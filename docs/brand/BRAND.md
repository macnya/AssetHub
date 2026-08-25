# AssetHub brand

## Colours

| Token | Hex | Use |
|---|---|---|
| Primary | `#0D7C74` | Buttons, links, active nav, the mark |
| Ink | `#0A3D4A` | Headings, the "Asset" half of the wordmark, dark surfaces |
| Accent | `#F0A93D` | Warnings and pending states only — never a primary action |

Replace `#E8720C` with `#0D7C74` in both `theme.js` files. That orange is
VisionFund's, and it stays theirs — once organisations can set their own
`primary_colour`, it becomes their setting rather than the product's.

## The mark

An isometric cube: three rhombi in a hexagon, with a hairline gap between the
faces. It reads as a box at 512px and as a solid shape at 16px, which is what a
favicon has to survive.

Faces are lit from the top left — top brightest, then right, then left. Keep
that order if you ever recolour it, or the cube stops reading as a cube.

## Files

| File | Where | Displayed at |
|---|---|---|
| `logo.png` | `frontend-admin/src/assets/` | 38px tall in the header |
| `logo.png` | `frontend-scanner/assets/` | 220x57 on login |
| `favicon.png` | `frontend-admin/public/` | browser tab |
| `apple-touch-icon.png` | `frontend-admin/public/` | iOS home screen |
| `icon.png` | `frontend-scanner/assets/` | app icon, 1024 square |
| `adaptive-icon.png` | `frontend-scanner/assets/` | Android; art sits inside the middle 66% |
| `splash-icon.png` | `frontend-scanner/assets/` | launch screen |

All raster PNGs are cut at 3x their display size, so they stay sharp on a
retina laptop and a phone.

## Clear space and minimum size

Leave clear space equal to the height of the cube on all sides. Do not set the
lockup smaller than 24px tall — below that, use the mark alone.

## Per-organisation logos

Once `organisation.logo_url` exists, a tenant's own logo replaces the AssetHub
one in their panel and scanner. AssetHub's mark stays on the login screen and
anywhere the product speaks for itself rather than for a customer.
