import sharp from 'sharp'
import { readFileSync } from 'fs'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#0a0a1a"/>
      <stop offset="55%" stop-color="#0d1f1a"/>
      <stop offset="100%" stop-color="#003d2e"/>
    </linearGradient>
    <radialGradient id="glow" cx="75%" cy="25%" r="60%">
      <stop offset="0%" stop-color="#00ffc8" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#00ffc8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="20%" cy="85%" r="45%">
      <stop offset="0%" stop-color="#00ffc8" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#00ffc8" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" rx="180" fill="url(#bg)"/>
  <rect width="1024" height="1024" rx="180" fill="url(#glow)"/>
  <rect width="1024" height="1024" rx="180" fill="url(#glow2)"/>
  <text
    x="512"
    y="560"
    font-family="Zapfino"
    font-size="155"
    fill="#00ffc8"
    stroke="#00ffc8"
    stroke-width="6"
    stroke-linejoin="round"
    text-anchor="middle"
    dominant-baseline="central"
  >Pianly</text>
</svg>`

await sharp(Buffer.from(svg))
  .png()
  .toFile('/tmp/icon_preview.png')

console.log('Done: /tmp/icon_preview.png')
