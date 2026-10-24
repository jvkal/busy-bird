// Courier skins: what carries the request between the cards. Every skin is
// plain SVG markup centred on (0,0), facing right, sized for ~0.72 scale;
// per-skin life (wing beats, wheel spins, kisses, banana picking) is CSS.

export const SKIN_ORDER = ['bird', 'car', 'kiss', 'monkey'];

export const SKINS = {
  bird: {
    label: '小鸟',
    emoji: '🐦',
    build: () => `
      <g class="skin-bird">
        <path class="wing far" d="M-14.5 -3.4C-16.5 -9.5 -14.2 -15 -8.6 -18.6C-9.4 -12.6 -9.6 -7.4 -9.2 -3.2Z"/>
        <path class="tail" d="M-31.5 3.1L-18.6 -1.8L-17.4 1.2L-30.8 4.6Z"/>
        <ellipse class="body" cx="-12.2" cy="-1.4" rx="7.6" ry="3.9"/>
        <ellipse class="belly" cx="-12.8" cy="0.4" rx="4.3" ry="1.6"/>
        <circle class="body" cx="-4.9" cy="-3.7" r="3.1"/>
        <path class="body" d="M-2.3 -4.8L1.4 -3.3L-2.3 -2.2Z"/>
        <g class="wing near"><path d="M-15.6 -3.2C-17.8 -10.2 -15.2 -16.4 -8.4 -20.4C-9.3 -13.6 -9.4 -7.8 -8.8 -2.8Z"/>
        <path class="bar" d="M-14.6 -5.6C-15.4 -10.4 -13.8 -14.4 -10.4 -17.2"/></g>
      </g>`,
  },

  car: {
    label: '小车',
    emoji: '🚗',
    build: () => `
      <g class="skin-car">
        <path class="c-body" d="M-17 2.5 Q-18 -2.5 -12 -3 L-3 -3.5 Q0 -9.5 7 -9.5 L11 -9.5 Q16.5 -9.5 17 -3.5 Q18.5 2.5 14 2.5 Z"/>
        <path class="c-cabin" d="M-2 -3.5 Q0.5 -8.5 6.5 -8.5 L10 -8.5 L10 -3.5 Z"/>
        <rect class="c-light" x="14.6" y="-1.8" width="2.6" height="1.8" rx="0.9"/>
        <g class="c-wheel"><circle cx="-9.5" cy="2.6" r="3.6"/><line x1="-9.5" y1="0.4" x2="-9.5" y2="4.8"/><line x1="-11.7" y1="2.6" x2="-7.3" y2="2.6"/></g>
        <g class="c-wheel"><circle cx="9.5" cy="2.6" r="3.6"/><line x1="9.5" y1="0.4" x2="9.5" y2="4.8"/><line x1="7.3" y1="2.6" x2="11.7" y2="2.6"/></g>
      </g>`,
  },

  kiss: {
    label: '亲嘴',
    emoji: '💋',
    build: () => `
      <g class="skin-kiss">
        <g class="k-boy">
          <circle class="k-head" cx="2" cy="-6.5" r="2.9"/>
          <path class="k-hair" d="M-1.2 -7.8 Q2 -10.4 4.9 -7.4 Q1.8 -8.8 -1.2 -7.8 Z"/>
          <path class="k-shirt" d="M-1.8 -3.4 L2.6 -3.4 L3.2 1.2 L-2.4 1.2 Z"/>
          <g class="k-legs"><line class="k-leg" x1="0.2" y1="1.2" x2="-1.8" y2="5.6"/><line class="k-leg2" x1="0.2" y1="1.2" x2="2.2" y2="5.6"/></g>
        </g>
        <g class="k-girl">${KISS_GIRL}</g>
        <path class="k-heart" d="M0 -9.2 C-1.6 -12.2 -5.8 -11 -5.8 -7.6 C-5.8 -4.8 -2.4 -2.6 0 -0.4 C2.4 -2.6 5.8 -4.8 5.8 -7.6 C5.8 -11 1.6 -12.2 0 -9.2 Z"/>
      </g>`,
  },

  monkey: {
    label: '猴子',
    emoji: '🐒',
    build: () => `
      <g class="skin-monkey">
        <path class="m-tail" d="M-10.5 1.5 Q-17 4.5 -14.5 -3.5"/>
        <ellipse class="m-body" cx="-4" cy="0.5" rx="7.2" ry="5"/>
        <circle class="m-head" cx="6" cy="-5.5" r="4.4"/>
        <path class="m-face" d="M3.6 -5.2 Q6 -8.2 8.4 -5.2 Q8.4 -2.6 6 -2 Q3.6 -2.6 3.6 -5.2 Z"/>
        <circle class="m-eye" cx="7.6" cy="-5.6" r="0.55"/>
        <path class="m-arm" d="M3.5 0.5 Q9.5 -1.5 12.5 -5.5"/>
        <path class="banana" d="M12.5 -9.5 Q18 -8.5 19 -3.5 Q15.5 -6 12 -5.5 Q13 -7.5 12.5 -9.5 Z"/>
      </g>`,
  },
};

export const courierSkin = value => (SKINS[value] ? value : 'bird');

export const nextSkin = value => {
  const index = SKIN_ORDER.indexOf(courierSkin(value));
  return SKIN_ORDER[(index + 1) % SKIN_ORDER.length];
};

// The girl who waits at the vendor's end of the kiss story — reused by the
// island's own stage so both places tell the same story.
export const KISS_GIRL = `
  <circle class="g-head" cx="-3" cy="-6.5" r="2.9"/>
  <path class="g-hair" d="M-5.8 -6.2 Q-3 -10.2 0.2 -7 Q-1 -9.8 -5.8 -6.2 Z M-5.4 -5.6 Q-5.8 -2 -4.4 0.8 L-3.2 0.4 Q-4.4 -2.4 -4 -5.2 Z"/>
  <path class="g-dress" d="M-4.6 1.6 L-1.6 -3.4 L1.8 -3.4 L1.2 4.8 L-2.8 4.8 Z"/>`;

export const KISS_HEART = `
  <path class="k-heart-big" d="M0 -9.2 C-1.6 -12.2 -5.8 -11 -5.8 -7.6 C-5.8 -4.8 -2.4 -2.6 0 -0.4 C2.4 -2.6 5.8 -4.8 5.8 -7.6 C5.8 -11 1.6 -12.2 0 -9.2 Z"/>`;
