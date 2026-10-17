/** @type {import('tailwindcss').Config} */

// ── Palette: emerald on cool white, anchored by a dark green rail ─────────────
// Taken from the reference mockup of this app's own department screen. Its
// premium quality comes from three things, not from colour alone:
//
//   1. A near-black *green* sidebar anchoring a light workspace. The dark rail is
//      what stops a light UI reading as a blank sheet — the previous attempts had
//      no anchor, which is why they felt washed out however the surfaces were tuned.
//   2. Deep emerald as the single action colour, used sparingly: the active tab
//      rule, checkboxes, the selected row's edge, one primary button per screen.
//   3. Generous space and larger type. The reference sets body at 15px and inputs
//      at 15/44px tall — small text with tight leading is what read as "not smooth".
//
// Document-type accents (teal/green/orange/indigo) are categorical only: they tint
// an icon so types are scannable in a list. They are never used for state.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Text
        ink: "#0F172A", // headings and body
        muted: "#4B5563", // secondary
        subtle: "#6B7280", // labels, captions, table headers

        // Workspace surfaces
        canvas: "#F7F8F7", // the page
        surface: "#FFFFFF", // cards
        "surface-muted": "#F3F4F3", // table headers, nested rows, chips
        "surface-inset": "#F1F3F2", // recessed: code, textareas

        // The dark rail
        rail: "#0A211D", // sidebar ground
        "rail-raised": "#16352F", // hover / active item
        "rail-line": "#1E3F38",
        "rail-ink": "#F2F7F5", // text on the rail
        "rail-muted": "#93AEA6", // secondary text on the rail

        // Structure
        line: "#E4E7E5",
        "line-muted": "#EDEFEE",

        // Action — deep emerald
        primary: "#0F6B52",
        "primary-dark": "#0B5340", // hover
        "primary-tint": "#E7F4EE",

        // Status
        success: "#15803D",
        "success-tint": "#E6F5EB",
        warning: "#B45309",
        "warning-tint": "#FCF0DE",
        danger: "#DC2626",
        "danger-tint": "#FDE7E7",
        info: "#0D9488",
        "info-tint": "#E0F2F0",

        // Categorical only — document-type icons
        "cat-teal": "#0D9488",
        "cat-teal-tint": "#E0F2F0",
        "cat-green": "#16A34A",
        "cat-green-tint": "#E6F6EC",
        "cat-orange": "#EA580C",
        "cat-orange-tint": "#FDEDE3",
        "cat-indigo": "#4F46E5",
        "cat-indigo-tint": "#EBEAFB",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -16px rgba(15,23,42,0.16)",
        "card-lg": "0 1px 2px rgba(15,23,42,0.04), 0 24px 48px -24px rgba(15,23,42,0.20)",
        inset: "0 1px 2px 0 rgba(15,23,42,0.05) inset",
        action: "0 1px 2px rgba(15,107,82,0.25), 0 8px 18px -10px rgba(15,107,82,0.45)",
      },
      keyframes: {
        cardIn: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pop: {
          "0%": { opacity: "0", transform: "scale(0.8)" },
          "60%": { opacity: "1", transform: "scale(1.06)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "card-in": "cardIn 0.45s cubic-bezier(0.16,1,0.3,1) both",
        pop: "pop 0.45s cubic-bezier(0.34,1.56,0.64,1) both",
        "fade-up": "fadeUp 0.4s ease-out both",
      },
    },
  },
  plugins: [],
};
