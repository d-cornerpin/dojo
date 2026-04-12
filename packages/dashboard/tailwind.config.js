/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    screens: {
      'xs': '384px',
      'sm': '640px',
      'md': '768px',
      'lg': '1024px',
      'xl': '1280px',
      '2xl': '1536px',
    },
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Backgrounds
        'cp-bg': '#0B0F1A',
        'cp-bg-secondary': '#141929',
        'cp-sidebar': '#1A1F35',
        // Accents
        'cp-amber': '#F5A623',
        'cp-amber-light': '#FFBA42',
        'cp-teal': '#00D4AA',
        'cp-teal-light': '#4AEDC4',
        'cp-coral': '#FF6B8A',
        'cp-blue': '#5B8DEF',
        'cp-blue-light': '#7BA4F7',
        'cp-purple': '#A78BFA',
        'cp-purple-deep': '#8B5CF6',
      },
      backdropBlur: {
        glass: '20px',
        'glass-heavy': '30px',
      },
      borderRadius: {
        glass: '16px',
        'glass-sm': '12px',
        'glass-xs': '8px',
      },
      boxShadow: {
        glass: '0 8px 32px rgba(0, 0, 0, 0.3)',
        'glass-hover': '0 8px 32px rgba(0, 0, 0, 0.4)',
        'glass-glow': '0 0 20px rgba(245, 166, 35, 0.15)',
      },
      animation: {
        'fade-up': 'fadeUp 0.4s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'slide-out-right': 'slideOutRight 0.3s ease-out',
        'pulse-slow': 'pulse 3s ease-in-out infinite',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideOutRight: {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(20px)' },
        },
      },
    },
  },
  plugins: [],
};
