/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        pad: {
          // legal-pad yellow paper
          paper: '#fbf3c4',
          paperDeep: '#f5e79a',
          line: '#9fc6e7',
          margin: '#e07a7a',
          ink: '#1c2541',
          inkSoft: '#3a4a6b',
          red: '#b5302a',
        },
        felt: '#243027', // desk / green felt backdrop
        manila: '#e6d3a3',
      },
      fontFamily: {
        hand: ['"Caveat"', '"Bradley Hand"', 'cursive'],
        type: ['"Special Elite"', '"Courier New"', 'monospace'],
        body: ['"Inter"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 10px 30px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.2)',
        stamp: '0 0 0 3px currentColor inset',
      },
      keyframes: {
        stampIn: {
          '0%': { transform: 'scale(2.4) rotate(-18deg)', opacity: '0' },
          '60%': { transform: 'scale(0.9) rotate(-12deg)', opacity: '1' },
          '100%': { transform: 'scale(1) rotate(-12deg)', opacity: '1' },
        },
        flipIn: {
          '0%': { transform: 'rotateY(-90deg)', opacity: '0' },
          '100%': { transform: 'rotateY(0deg)', opacity: '1' },
        },
        pulseRing: {
          '0%': { boxShadow: '0 0 0 0 rgba(181,48,42,0.6)' },
          '70%': { boxShadow: '0 0 0 12px rgba(181,48,42,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(181,48,42,0)' },
        },
      },
      animation: {
        stampIn: 'stampIn 0.45s cubic-bezier(0.2,0.8,0.2,1) forwards',
        flipIn: 'flipIn 0.4s ease-out forwards',
        pulseRing: 'pulseRing 1.8s infinite',
      },
    },
  },
  plugins: [],
};
