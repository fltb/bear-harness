/**
 * Generate the signed 极昼 package assets.
 *
 * The presence asset deliberately preserves Prototype 06's original geometry:
 * a 245 × 350 canvas with separate ears, rounded head/body, vest and log.
 * State changes are generic container animations; they never distort the face.
 * Scene assets are environment-only and contain no character figure.
 *
 * Run from apps/desktop: node scripts/generate-jizhou-assets.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "..", "..", "..", "config", "characters", "jizhou", "assets");
mkdirSync(assetsDir, { recursive: true });

/** Exact Prototype 06 bear geometry in its original 245 × 350 coordinate space. */
function prototype06Bear() {
	return `
  <defs>
    <linearGradient id="body-shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#c5d8d0" stop-opacity=".7"/>
      <stop offset=".13" stop-color="#c5d8d0" stop-opacity=".35"/>
      <stop offset=".28" stop-color="#e6ece6" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="head-shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#d1e1da" stop-opacity=".65"/>
      <stop offset=".18" stop-color="#d1e1da" stop-opacity=".22"/>
      <stop offset=".34" stop-color="#f1f2eb" stop-opacity="0"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-100%" width="140%" height="300%">
      <feGaussianBlur stdDeviation="4"/>
    </filter>
  </defs>
  <!-- Prototype 06: 15px/24px inset shadow, 62px ears, 199px body. -->
  <ellipse cx="122.5" cy="338" rx="107.5" ry="12" fill="rgba(1,10,13,.45)" filter="url(#shadow)"/>
  <circle cx="60" cy="67" r="31" fill="#eef1ea"/>
  <circle cx="185" cy="67" r="31" fill="#eef1ea"/>
  <path d="M68 148 H177 C202 148 222 178 222 206 V295 C222 314 204 328 186 328 H59 C41 328 23 314 23 295 V206 C23 178 43 148 68 148 Z" fill="#e6ece6"/>
  <path d="M68 148 H177 C202 148 222 178 222 206 V295 C222 314 204 328 186 328 H59 C41 328 23 314 23 295 V206 C23 178 43 148 68 148 Z" fill="url(#body-shade)"/>
  <path d="M52 188 L122.5 225.26 L193 188 L173.26 326 L71.74 326 Z" fill="#68847f"/>
  <path d="M119 44 C160 44 194 78 194 117 V151 C194 180 164 199 123 199 C82 199 52 180 52 151 V117 C52 78 80 44 119 44 Z" fill="#f1f2eb"/>
  <path d="M119 44 C160 44 194 78 194 117 V151 C194 180 164 199 123 199 C82 199 52 180 52 151 V117 C52 78 80 44 119 44 Z" fill="url(#head-shade)"/>
  <!-- Original face: two 10 × 13 eyes and one 24 × 17 nose; no added mouth. -->
  <rect x="90" y="115" width="10" height="13" rx="5" fill="#203c3c"/>
  <rect x="146" y="115" width="10" height="13" rx="5" fill="#203c3c"/>
  <rect x="111" y="142" width="24" height="17" rx="8.5" fill="#20393a"/>
  <rect x="70" y="276" width="105" height="52" rx="8" fill="#263f42"/>
  <path d="M83 289 H162 M83 298 H162 M83 307 H162" stroke="#7aa89b" stroke-width="3" fill="none"/>
`;
}

/** Environment-only rendition of Prototype 06's aurora study. */
function auroraStudy() {
	return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 680">
  <defs>
    <linearGradient id="room" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#17383f"/>
      <stop offset=".58" stop-color="#20474a"/>
      <stop offset="1" stop-color="#10272f"/>
    </linearGradient>
    <linearGradient id="window-sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#173b44"/>
      <stop offset="1" stop-color="#112c35"/>
    </linearGradient>
    <linearGradient id="aurora" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#94e0ca" stop-opacity="0"/>
      <stop offset=".48" stop-color="#94e0ca" stop-opacity=".42"/>
      <stop offset=".68" stop-color="#68a4ba" stop-opacity=".2"/>
      <stop offset="1" stop-color="#94e0ca" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#72513d"/>
      <stop offset="1" stop-color="#382820"/>
    </linearGradient>
    <filter id="aurora-blur" x="-10%" y="-100%" width="120%" height="300%">
      <feGaussianBlur stdDeviation="23"/>
    </filter>
    <filter id="window-shadow" x="-15%" y="-25%" width="130%" height="160%">
      <feDropShadow dx="0" dy="14" stdDeviation="17" flood-color="#000a0d" flood-opacity=".25"/>
    </filter>
    <filter id="lamp-glow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
    <clipPath id="window-view"><rect x="54" y="62" width="468" height="238"/></clipPath>
  </defs>
  <rect width="1200" height="680" fill="url(#room)"/>
  <rect x="-60" y="40" width="1320" height="90" fill="url(#aurora)" filter="url(#aurora-blur)" transform="rotate(-4 600 85)"/>
  <g filter="url(#window-shadow)">
    <rect x="54" y="62" width="468" height="238" fill="url(#window-sky)"/>
    <g clip-path="url(#window-view)" opacity=".25">
      <path d="M54 270 L110 164 L171 242 L236 130 L316 245 L377 180 L442 257 L489 206 L522 235 L522 300 L54 300 Z" fill="#c5d9d5"/>
    </g>
    <rect x="54" y="62" width="468" height="238" fill="none" stroke="rgba(160,204,193,.2)" stroke-width="3"/>
  </g>
  <rect x="768" y="68" width="360" height="224" rx="12" fill="rgba(27,54,54,.7)" stroke="rgba(166,195,184,.18)"/>
  <rect x="788" y="144" width="320" height="4" fill="rgba(165,174,156,.2)"/>
  <rect x="788" y="220" width="320" height="4" fill="rgba(165,174,156,.2)"/>
  <g opacity=".85">
    <rect x="790" y="198" width="14" height="76" fill="#9f8067"/>
    <rect x="809" y="198" width="17" height="76" fill="#6f9b92"/>
    <rect x="832" y="198" width="15" height="76" fill="#c0a66f"/>
    <rect x="853" y="198" width="19" height="76" fill="#819994"/>
  </g>
  <rect x="0" y="517" width="1200" height="163" fill="url(#desk)"/>
  <rect x="0" y="517" width="1200" height="8" fill="rgba(255,255,255,.08)"/>
  <ellipse cx="868" cy="510" rx="62" ry="30" fill="#ebb55f" opacity=".28" filter="url(#lamp-glow)"/>
  <path d="M824 516 H912 V532 H824 Z" fill="#b78456"/>
  <path d="M824 516 C824 481 842 460 868 460 C894 460 912 481 912 516 Z" fill="#b78456"/>
</svg>`;
}

/** Quiet winter camp: an environment-only alternative scene. */
function snowPlains() {
	return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 680">
  <defs>
    <linearGradient id="night-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#102a31"/>
      <stop offset=".62" stop-color="#244b50"/>
      <stop offset="1" stop-color="#b7cbc6"/>
    </linearGradient>
    <linearGradient id="snow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e8f0ec"/>
      <stop offset="1" stop-color="#c4d5d0"/>
    </linearGradient>
    <radialGradient id="camp-light" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#f7d797" stop-opacity=".88"/>
      <stop offset="1" stop-color="#cf9d5b" stop-opacity="0"/>
    </radialGradient>
    <filter id="camp-glow" x="-120%" y="-120%" width="340%" height="340%">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
  </defs>
  <rect width="1200" height="680" fill="url(#night-sky)"/>
  <path d="M-40 165 C150 96 255 174 410 128 C590 74 738 160 920 104 C1040 68 1135 102 1240 72" stroke="#94e0ca" stroke-width="38" opacity=".16" fill="none"/>
  <circle cx="970" cy="106" r="31" fill="#eaf2ee" opacity=".82"/>
  <path d="M0 480 L145 242 L285 418 L455 188 L612 433 L788 258 L972 457 L1120 304 L1200 430 L1200 680 L0 680 Z" fill="#a9c2be" opacity=".32"/>
  <path d="M0 540 C180 500 350 560 540 518 C744 473 960 536 1200 500 L1200 680 L0 680 Z" fill="url(#snow)"/>
  <path d="M0 598 C260 560 400 625 620 574 C850 520 1035 590 1200 558 L1200 680 L0 680 Z" fill="#c0d4ce"/>
  <ellipse cx="820" cy="548" rx="86" ry="42" fill="url(#camp-light)" filter="url(#camp-glow)"/>
  <path d="M758 552 L820 464 L882 552 Z" fill="#4a6b68"/>
  <path d="M774 552 L820 486 L866 552 Z" fill="#27474b"/>
  <path d="M812 575 L828 575 L820 538 Z" fill="#f1c272"/>
  <path d="M790 578 H850" stroke="#72513d" stroke-width="7" stroke-linecap="round"/>
</svg>`;
}

const assets = {
	"avatar.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44">
  <circle cx="22" cy="22" r="22" fill="#2a5b56"/>
  <circle cx="11.5" cy="10.5" r="6.5" fill="#eef2eb"/>
  <circle cx="32.5" cy="10.5" r="6.5" fill="#eef2eb"/>
  <rect x="5" y="9" width="34" height="31" rx="17" fill="#eef2eb"/>
  <rect x="18" y="26" width="8" height="6" rx="3" fill="#23403f"/>
</svg>`,
	"presence-default.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 245 350">${prototype06Bear()}</svg>`,
	"presence-listening.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 245 350">${prototype06Bear()}</svg>`,
	"presence-thinking.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 245 350">${prototype06Bear()}</svg>`,
	"presence-problem.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 245 350">${prototype06Bear()}</svg>`,
	"scene-aurora-study.svg": auroraStudy(),
	"scene-snow-plains.svg": snowPlains(),
};

for (const [name, svg] of Object.entries(assets)) {
	writeFileSync(join(assetsDir, name), `${svg}\n`, "utf8");
	console.log(`wrote ${name}`);
}
