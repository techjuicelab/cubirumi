import { appearanceFor, appearanceKey, BOSS_SHIRT, type Appearance } from './appearance.ts';
import { statusStyleFor, type StatusStyle } from './status-style.ts';

/**
 * Card and roster portraits are drawn from the same appearance record as the 3D figure,
 * so a person keeps one face everywhere without screenshots or textures.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Accepts only a real hex color; anything else (including markup) is rejected. */
export function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string' || !HEX.test(value)) return undefined;
  const hex = value.toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function toHex(values: number[]): string {
  return `#${values.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')}`;
}

/** Multiplies every channel: the clay shadow tone of a fill. */
export function shade(hex: string, factor: number): string {
  return toHex(channels(hex).map(value => value * factor));
}

/** Mixes toward white: soft highlights on hair. */
export function tint(hex: string, amount: number): string {
  return toHex(channels(hex).map(value => value + (255 - value) * amount));
}

function brightness(hex: string): number {
  const [r, g, b] = channels(hex);
  return (r * .299 + g * .587 + b * .114) / 255;
}

/** The owner always wears the navy turtleneck; everyone else wears the reported shirt color. */
export function portraitShirt(agentId: string, color?: string): string {
  const look = appearanceFor(agentId);
  return look.isBoss ? BOSS_SHIRT : normalizeHex(color) ?? look.seatShirt;
}

const EYES_AND_FACE = (look: Appearance) => {
  const mouth = brightness(look.skin) < .6 ? '#7b4f3f' : '#9a6857';
  return `<rect x="36.8" y="42" width="8.4" height="1.7" rx=".85" fill="${look.hair}"/><rect x="54.8" y="42" width="8.4" height="1.7" rx=".85" fill="${look.hair}"/>`
    + '<circle cx="41" cy="48.5" r="2.7" fill="#3d4037"/><circle cx="59" cy="48.5" r="2.7" fill="#3d4037"/>'
    + '<circle cx="40.2" cy="47.6" r=".85" fill="#fffdf3"/><circle cx="58.2" cy="47.6" r=".85" fill="#fffdf3"/>'
    + '<ellipse cx="35.5" cy="55.5" rx="4.2" ry="2.4" fill="#e6a291" opacity=".8"/><ellipse cx="64.5" cy="55.5" rx="4.2" ry="2.4" fill="#e6a291" opacity=".8"/>'
    + `<path d="M45.6 57.8 Q50 61.4 54.4 57.8" fill="none" stroke="${mouth}" stroke-width="1.6" stroke-linecap="round"/>`;
};

const BANGS = (hair: string) => `<path d="M23.5 46 C22.5 26 34 15 50 15 C66 15 77.5 26 76.5 46 L74.5 39.5 C66 34.5 34 34.5 25.5 39.5 Z" fill="${hair}"/>`
  + [[33.5, 35], [44, 36.2], [56, 36.2], [66.5, 35]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.4" fill="${hair}"/>`).join('');

function backHair(look: Appearance): string {
  if (look.isBoss) return '';
  if (look.headwear === 'buns') return `<circle cx="21.5" cy="59" r="7.5" fill="${look.hair}"/><circle cx="78.5" cy="59" r="7.5" fill="${look.hair}"/>`;
  if (look.headwear === 'ponytail') return `<ellipse cx="78" cy="60" rx="7" ry="13" fill="${look.hair}" transform="rotate(-16 78 60)"/>`;
  return '';
}

function outfit(look: Appearance, shirt: string): string {
  switch (look.outfit) {
    case 'boss-turtleneck':
      return `<rect x="40" y="62" width="20" height="16" rx="6" fill="${shirt}"/><path d="M41.5 71.5 L58.5 71.5 M41.5 74.8 L58.5 74.8" stroke="${shade(shirt, .9)}" stroke-width="1.1"/>`;
    case 'round-collar-lanyard':
      return '<path d="M39.5 75.5 Q50 83 60.5 75.5" fill="none" stroke="#fffdf5" stroke-width="3.6" stroke-linecap="round"/>'
        + '<path d="M42.5 78.5 L50 90 L57.5 78.5" fill="none" stroke="#8197ad" stroke-width="1.1"/>'
        + '<rect x="45" y="89" width="10" height="8" rx="1.4" fill="#eef5fa" stroke="#8197ad" stroke-width=".8"/><rect x="47" y="92" width="6" height="1.3" fill="#8fbbd2"/>';
    case 'round-collar':
      return `<path d="M39.5 75.5 Q50 83 60.5 75.5" fill="none" stroke="${shade(shirt, .9)}" stroke-width="3.6" stroke-linecap="round"/>`;
    case 'hoodie':
      return `<path d="M38 76.5 Q50 85 62 76.5" fill="none" stroke="${shade(shirt, .92)}" stroke-width="6" stroke-linecap="round"/>`
        + '<path d="M46 81 L45.2 95 M54 81 L54.8 95" stroke="#fffdf5" stroke-width="1.7" stroke-linecap="round"/>'
        + '<circle cx="45.2" cy="95.5" r="1.4" fill="#fffdf5"/><circle cx="54.8" cy="95.5" r="1.4" fill="#fffdf5"/>';
    case 'vest-watch':
      return '<path d="M33 80 C37 77 40.5 77 43.5 78 L50 95 L56.5 78 C59.5 77 63 77 67 80 L80 104 L20 104 Z" fill="#5f7d8f" opacity=".92"/>';
    case 'check-shirt':
      return `<path d="M19.5 86 L80.5 86 M13.5 94 L86.5 94 M38 77.5 L38 100 M62 77.5 L62 100" stroke="${shade(shirt, .88)}" stroke-width="1.2" opacity=".6"/>`
        + '<path d="M41 76.5 L50 85 L59 76.5 L55.5 73.5 L50 79.5 L44.5 73.5 Z" fill="#fffdf5"/>';
    default:
      return '';
  }
}

function frontHair(look: Appearance): string {
  const hair = look.hair;
  if (look.isBoss) {
    return `<path d="M24 46 C22.5 24 35 14.5 50 14.5 C65 14.5 77.5 24 76 46 C74.5 38 71 32 64 29.5 C54 26.5 41 28.5 33 34.5 C29 37.5 26 41.5 24 46 Z" fill="${hair}"/>`
      + `<path d="M60 17.5 Q56 23.5 45 29" fill="none" stroke="${tint(hair, .12)}" stroke-width="1.3" stroke-linecap="round"/>`
      + '<ellipse cx="40" cy="21.5" rx="7" ry="2.6" fill="#fffdf5" opacity=".14" transform="rotate(-14 40 21.5)"/>';
  }
  switch (look.headwear) {
    case 'cap-bangs':
    case 'buns':
      return BANGS(hair);
    case 'curly':
      return [[30, 33, 7.5], [39.5, 25, 7.5], [50, 21.5, 7.5], [60.5, 25, 7.5], [70, 33, 7.5], [29.5, 41, 5.6], [70.5, 41, 5.6], [44.5, 30.5, 7], [55.5, 30.5, 7]]
        .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${hair}"/>`).join('')
        + [[27.5, 30.5], [37.5, 22.5], [48, 19], [58.5, 22.5]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.2" fill="${tint(hair, .12)}" opacity=".7"/>`).join('');
    case 'ponytail':
      return `<path d="M23.5 46 C22.5 26 34 15 50 15 C66 15 77.5 26 76.5 46 L76 39 C68 37.5 58 33.5 50 39.5 C42 33.5 32 37.5 24 39 Z" fill="${hair}"/>`
        + `<circle cx="61" cy="33" r="5.5" fill="${hair}"/><circle cx="70" cy="36.5" r="5" fill="${hair}"/>`
        + '<rect x="30" y="32.5" width="10" height="2.6" rx="1.3" fill="#eed58e" transform="rotate(-22 35 33.8)"/>';
    case 'small-cap':
      return `<path d="M28 42 C26.5 12 73.5 12 72 42 L71.5 35.5 C64 29.5 36 29.5 28.5 35.5 Z" fill="${hair}"/>`;
    case 'beanie':
      return `<circle cx="28.5" cy="44.5" r="5" fill="${hair}"/><circle cx="71.5" cy="44.5" r="5" fill="${hair}"/><circle cx="33" cy="40" r="4" fill="${hair}"/><circle cx="67" cy="40" r="4" fill="${hair}"/>`
        + '<path d="M22.5 39 C22.5 10 77.5 10 77.5 39 Z" fill="#9dbdaa"/><path d="M36 18 L36 33 M50 13.5 L50 33 M64 18 L64 33" stroke="#8fae9b" stroke-width="1.2" opacity=".8"/>'
        + '<ellipse cx="38" cy="20" rx="6" ry="2.4" fill="#fffdf5" opacity=".2"/><rect x="21" y="32" width="58" height="9.5" rx="4.75" fill="#8fae9b"/><circle cx="50" cy="11.5" r="4.6" fill="#8fae9b"/>';
    default:
      return '';
  }
}

function glasses(look: Appearance): string {
  if (look.glasses === 'round' && look.isBoss) {
    return '<circle cx="41" cy="48.5" r="5.5" fill="#fffdf5" fill-opacity=".12" stroke="#31495e" stroke-width="1.1"/><circle cx="59" cy="48.5" r="5.5" fill="#fffdf5" fill-opacity=".12" stroke="#31495e" stroke-width="1.1"/>'
      + '<path d="M46.5 47.8 Q50 46.2 53.5 47.8 M35.5 47.8 L26.5 46.5 M64.5 47.8 L73.5 46.5" fill="none" stroke="#31495e" stroke-width="1.1"/>';
  }
  if (look.glasses === 'round') {
    return '<circle cx="41" cy="48.5" r="5.8" fill="#fffdf5" fill-opacity=".14" stroke="#5b6455" stroke-width="1.5"/><circle cx="59" cy="48.5" r="5.8" fill="#fffdf5" fill-opacity=".14" stroke="#5b6455" stroke-width="1.5"/>'
      + '<path d="M46.8 47.8 Q50 46.3 53.2 47.8" fill="none" stroke="#5b6455" stroke-width="1.5"/>';
  }
  if (look.glasses === 'square') {
    return '<rect x="35.2" y="43.6" width="11.6" height="9.8" rx="2.4" fill="#fffdf5" fill-opacity=".14" stroke="#5b6455" stroke-width="1.5"/><rect x="53.2" y="43.6" width="11.6" height="9.8" rx="2.4" fill="#fffdf5" fill-opacity=".14" stroke="#5b6455" stroke-width="1.5"/>'
      + '<path d="M46.8 47.6 L53.2 47.6" stroke="#5b6455" stroke-width="1.5"/>';
  }
  return '';
}

function accessories(look: Appearance): string {
  let markup = '';
  if (look.headphones) {
    markup += '<path d="M21.5 46 C20 7 80 7 78.5 46" fill="none" stroke="#566b61" stroke-width="4.2" stroke-linecap="round"/>'
      + '<rect x="16.5" y="40" width="9.5" height="17" rx="4.5" fill="#52685f"/><rect x="74" y="40" width="9.5" height="17" rx="4.5" fill="#52685f"/>'
      + '<rect x="18.4" y="42.5" width="2.6" height="8" rx="1.3" fill="#fffdf5" opacity=".16"/>';
  }
  if (!look.isBoss && look.headwear === 'beanie') {
    markup += '<g transform="rotate(-32 80 44)"><path d="M71 42.4 L67.5 44.1 L71 45.8 Z" fill="#d4b08a"/><rect x="71" y="42.4" width="16" height="3.4" rx="1" fill="#eed58e"/><rect x="86" y="42.4" width="4" height="3.4" rx="1.2" fill="#e7af96"/></g>';
  }
  return markup;
}

const cache = new Map<string, string>();

/** Inline SVG markup (aria-hidden). Only appearance constants and validated hex colors reach the markup. */
export function portraitSVG(agentId: string, color?: string): string {
  const look = appearanceFor(agentId);
  const shirt = portraitShirt(agentId, color);
  const key = `${appearanceKey(look)}|${shirt}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const skinShade = shade(look.skin, .9);
  const markup = '<svg class="portrait-art" viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
    + '<circle cx="50" cy="44" r="36" fill="#eef5fa" opacity=".85"/>'
    + backHair(look)
    + `<ellipse cx="50" cy="101" rx="38" ry="25" fill="${shirt}"/><ellipse cx="64" cy="104" rx="23" ry="19" fill="${shade(shirt, .9)}" opacity=".5"/>`
    + '<ellipse cx="37" cy="84" rx="12" ry="3.6" fill="#fffdf5" opacity=".16"/>'
    + `<rect x="44.5" y="62" width="11" height="16" rx="3" fill="${look.skin}"/>`
    + outfit(look, shirt)
    + `<circle cx="25.5" cy="48" r="5.2" fill="${look.skin}"/><circle cx="74.5" cy="48" r="5.2" fill="${look.skin}"/>`
    + `<circle cx="25.8" cy="48" r="2.3" fill="${skinShade}" opacity=".6"/><circle cx="74.2" cy="48" r="2.3" fill="${skinShade}" opacity=".6"/>`
    + `<ellipse cx="50" cy="46" rx="25" ry="26" fill="${look.skin}"/><ellipse cx="58" cy="64" rx="13" ry="5" fill="${skinShade}" opacity=".35"/>`
    + frontHair(look)
    + EYES_AND_FACE(look)
    + glasses(look)
    + accessories(look)
    + '</svg>';
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, markup);
  return markup;
}

/** Status marker for cards and lists; color is never the only cue because every family has its own shape. */
export function statusShapeSVG(status: string | StatusStyle, size = 14): string {
  // A presented style (for example UNCONFIRMED_STYLE) may be passed instead of a reported status.
  const style = typeof status === 'string' ? statusStyleFor(status) : status;
  const color = style.color;
  const open = `<svg class="status-shape" data-shape="${style.shape}" viewBox="0 0 14 14" width="${size}" height="${size}" aria-hidden="true" focusable="false">`;
  switch (style.shape) {
    case 'ring':
      return `${open}<circle cx="7" cy="7" r="4.5" fill="none" stroke="${color}" stroke-width="2.3"/></svg>`;
    case 'dashed-ring':
      return `${open}<circle cx="7" cy="7" r="4.5" fill="none" stroke="${color}" stroke-width="2.3" stroke-dasharray="2.6 1.9"/></svg>`;
    case 'diamond':
      return `${open}<path d="M7 1.4 L12.6 7 L7 12.6 L1.4 7 Z" fill="${color}" stroke="${shade(color, .82)}" stroke-width=".8" stroke-linejoin="round"/></svg>`;
    case 'triangle':
      return `${open}<path d="M7 1.6 L12.8 11.9 L1.2 11.9 Z" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/><path d="M7 5.4 L7 8.4" stroke="#fffdf5" stroke-width="1.4" stroke-linecap="round"/><circle cx="7" cy="10.2" r=".75" fill="#fffdf5"/></svg>`;
    case 'check':
      return `${open}<circle cx="7" cy="7" r="5.6" fill="${color}"/><path d="M4.4 7.2 L6.2 8.9 L9.6 5.4" fill="none" stroke="#fffdf5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'unknown':
      return `${open}<circle cx="7" cy="7" r="5.4" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="1.4 1.6"/><path d="M5.5 5.6 A1.6 1.6 0 1 1 7.6 7.1 C7.2 7.3 7 7.6 7 8.1" fill="none" stroke="${shade(color, .78)}" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="9.9" r=".75" fill="${shade(color, .78)}"/></svg>`;
    default:
      return `${open}<rect x="2" y="5.6" width="10" height="2.8" rx="1.4" fill="${color}" stroke="${shade(color, .78)}" stroke-width=".7"/></svg>`;
  }
}
