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
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Backgrounds — use channel vars for opacity modifier support
        'cp-bg': 'rgb(var(--cp-bg-ch) / <alpha-value>)',
        'cp-bg-secondary': 'rgb(var(--cp-bg-secondary-ch) / <alpha-value>)',
        'cp-sidebar': 'rgb(var(--cp-sidebar-ch) / <alpha-value>)',
        // Accents
        'cp-amber': 'rgb(var(--cp-amber-ch) / <alpha-value>)',
        'cp-amber-light': 'rgb(var(--cp-amber-light-ch) / <alpha-value>)',
        'cp-teal': 'rgb(var(--cp-teal-ch) / <alpha-value>)',
        'cp-teal-light': 'rgb(var(--cp-teal-light-ch) / <alpha-value>)',
        'cp-coral': 'rgb(var(--cp-coral-ch) / <alpha-value>)',
        'cp-blue': 'rgb(var(--cp-blue-ch) / <alpha-value>)',
        'cp-blue-light': 'rgb(var(--cp-blue-light-ch) / <alpha-value>)',
        'cp-purple': 'rgb(var(--cp-purple-ch) / <alpha-value>)',
        'cp-purple-deep': 'rgb(var(--cp-purple-deep-ch) / <alpha-value>)',
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
