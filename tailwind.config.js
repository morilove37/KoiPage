/**
 * Tailwind configuration.
 *
 * `darkMode: "class"` pairs with `@/lib/theme`: the rendered theme is the
 * `dark` class on `<html>`, while the *glass* theme additionally gets a
 * `glass` class there (see `src/index.css`).
 *
 * Everything motion-related lives here as named `keyframes` / `animation`
 * utilities so components never need inline `style` objects.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        /**
         * Glass surfaces. Only meaningful under the `glass` theme — the
         * variables themselves are declared in `src/index.css` so they can
         * carry alpha (`hsl(var(--glass) / 0.5)`).
         */
        glass: {
          DEFAULT: "hsl(var(--glass))",
          strong: "hsl(var(--glass-strong))",
          border: "hsl(var(--glass-border))",
          highlight: "hsl(var(--glass-highlight))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        // Roomier corner used by glass panes so they read as a lens/droplet.
        xl: "calc(var(--radius) + 6px)",
      },
      /**
       * Motion budget: 120–220 ms. Anything longer feels sluggish in a desktop
       * app, so these tokens are the ceiling rather than a suggestion.
       */
      transitionDuration: {
        120: "120ms",
        160: "160ms",
        180: "180ms",
        220: "220ms",
      },
      transitionTimingFunction: {
        // Slight overshoot-free "settle": fast out, gentle in.
        smooth: "cubic-bezier(0.22, 1, 0.36, 1)",
        snap: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      keyframes: {
        /** Page/route content entering: fade in, drift up slightly. */
        "fade-up": {
          from: { opacity: "0", transform: "translate3d(0, 8px, 0)" },
          to: { opacity: "1", transform: "translate3d(0, 0, 0)" },
        },
        /** Plain fade, for scrims and lazy-load fallbacks. */
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        /** Dialog panel: fade + small scale-up (never from 0 — that reads as a pop). */
        "dialog-in": {
          from: { opacity: "0", transform: "translate3d(0, 4px, 0) scale(0.97)" },
          to: { opacity: "1", transform: "translate3d(0, 0, 0) scale(1)" },
        },
        /** Skeleton sweep: background-position travels across the element. */
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        /** Indeterminate progress bar fill. */
        "progress-slide": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(320%)" },
        },
        /** Slow, organic drift for the glass background blobs. */
        "blob-drift-a": {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "50%": { transform: "translate3d(6%, -5%, 0) scale(1.12)" },
        },
        "blob-drift-b": {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1.08)" },
          "50%": { transform: "translate3d(-7%, 6%, 0) scale(0.94)" },
        },
        "blob-drift-c": {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(0.96)" },
          "50%": { transform: "translate3d(4%, 7%, 0) scale(1.1)" },
        },
        /** Whole-background hue rotation: keeps the glass tint alive. */
        "hue-drift": {
          from: { filter: "hue-rotate(0deg)" },
          to: { filter: "hue-rotate(360deg)" },
        },
      },
      animation: {
        "fade-up": "fade-up 180ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "fade-in": "fade-in 160ms ease-out both",
        "dialog-in": "dialog-in 160ms cubic-bezier(0.22, 1, 0.36, 1) both",
        shimmer: "shimmer 1.6s ease-in-out infinite",
        "progress-slide": "progress-slide 1.25s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        "blob-a": "blob-drift-a 22s ease-in-out infinite",
        "blob-b": "blob-drift-b 28s ease-in-out infinite",
        "blob-c": "blob-drift-c 34s ease-in-out infinite",
        "hue-drift": "hue-drift 48s linear infinite",
      },
      boxShadow: {
        /** Lift for a hovered interactive surface. */
        lift: "0 8px 24px -6px rgb(0 0 0 / 0.35)",
        /** Coloured float shadow — never pure black, that kills the glass look. */
        glass:
          "0 8px 32px -8px var(--glass-shadow), inset 0 1px 0 0 var(--glass-highlight)",
        "glass-lg":
          "0 18px 48px -12px var(--glass-shadow), inset 0 1px 0 0 var(--glass-highlight)",
      },
      backdropBlur: {
        glass: "18px",
        "glass-strong": "28px",
      },
    },
  },
  plugins: [],
};
