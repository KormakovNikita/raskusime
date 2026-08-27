/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      colors: {
        ink: '#121212',
        sand: '#c4a574',
        'sand-light': '#d4bc8e',
        'sand-dim': '#8a7350',
        mist: '#a8a8a8',
        parchment: '#f7f1e6',
      },
      fontFamily: {
        sans: ['"Manrope"', 'system-ui', 'sans-serif'],
        serif: ['"Cormorant Garamond"', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
