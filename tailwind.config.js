/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: {
          950: '#070B14',
          900: '#0B0F19',
          850: '#10151F',
          800: '#151B28',
          750: '#1B2333',
          700: '#232D42',
        },
        line: 'rgba(148, 163, 184, 0.12)',
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.3), 0 8px 24px -12px rgba(0,0,0,0.5)',
        pop: '0 12px 40px -12px rgba(0,0,0,0.7)',
        glow: '0 0 0 1px rgba(99,102,241,0.35), 0 8px 32px -8px rgba(99,102,241,0.45)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'slide-in-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-soft': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.55' } },
      },
      animation: {
        'fade-up': 'fade-up 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-in-right': 'slide-in-right 0.32s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-in-left': 'slide-in-left 0.32s cubic-bezier(0.16, 1, 0.3, 1) both',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
