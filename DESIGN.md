# Design System — Protocol Proxy

## Product Context
- **What this is:** A protocol-conversion transparent proxy for OpenAI / Anthropic / Gemini APIs. Users configure proxy endpoints, route requests across multiple providers, and monitor token usage and request logs.
- **Who it's for:** Developers, DevOps engineers, and AI application builders who need to manage multiple LLM provider endpoints.
- **Space/industry:** Infrastructure / Developer Tools / API Management
- **Project type:** Internal tool / Admin dashboard

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian with intentional refinement
- **Decoration level:** Intentional — subtle depth through layered surfaces, a faint grid texture on dark mode, and disciplined use of accent color. No decorative blobs, no purple gradients.
- **Mood:** A control panel for serious work. Feels precise, fast, and trustworthy. Like Linear or Vercel Dashboard, but for proxy infrastructure.
- **Reference sites:** Vercel Dashboard, Railway, Cloudflare Dashboard, Linear

## Typography
- **Display/Hero:** Plus Jakarta Sans — Modern geometric sans with a technical edge. Clean at large sizes without feeling corporate.
- **Body:** DM Sans — Highly legible at UI sizes, slightly warm without being playful. Excellent hinting.
- **UI/Labels:** DM Sans (same as body, 500 weight)
- **Data/Tables:** JetBrains Mono — Supports `tabular-nums`, distinguishes 0/O and l/1. Perfect for token counts, latency numbers, and port addresses.
- **Code:** JetBrains Mono
- **Loading:** Google Fonts CDN (`https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap`)
- **Scale:**
  - Hero: 28px / 1.2 / 700
  - H1: 22px / 1.3 / 700
  - H2: 18px / 1.35 / 600
  - H3: 15px / 1.4 / 600
  - Body: 14px / 1.6 / 400
  - Small: 13px / 1.5 / 400
  - Caption: 12px / 1.5 / 500 (uppercase for labels)
  - Data: 13px / 1.4 / 500 (tabular-nums)

## Color
- **Approach:** Restrained — one accent carries all the color weight. Surfaces are layered neutrals.
- **Primary accent:** `#0EA5E9` (sky-500) — Represents "connection" and "flow". Used for running states, active nav, links, and primary actions.
- **Secondary accent:** `#06B6D4` (cyan-500) — Used sparingly for gradients, hover states, and secondary emphasis.
- **Neutrals (Dark mode):**
  - bg-base: `#09090B` (zinc-950, almost black with warmth)
  - bg-elevated: `#18181B` (zinc-900)
  - bg-surface: `#27272A` (zinc-800)
  - bg-surface-hover: `#3F3F46` (zinc-700)
  - border-default: `#3F3F46` (zinc-700)
  - border-subtle: `#27272A` (zinc-800)
  - text-primary: `#FAFAFA` (zinc-50)
  - text-secondary: `#A1A1AA` (zinc-400)
  - text-muted: `#71717A` (zinc-500)
  - text-faint: `#52525B` (zinc-600)
- **Neutrals (Light mode):**
  - bg-base: `#FFFFFF`
  - bg-elevated: `#F4F4F5` (zinc-100)
  - bg-surface: `#E4E4E7` (zinc-200)
  - bg-surface-hover: `#D4D4D8` (zinc-300)
  - border-default: `#E4E4E7` (zinc-200)
  - border-subtle: `#F4F4F5` (zinc-100)
  - text-primary: `#18181B` (zinc-900)
  - text-secondary: `#52525B` (zinc-600)
  - text-muted: `#71717A` (zinc-500)
  - text-faint: `#A1A1AA` (zinc-400)
- **Semantic:**
  - success: `#22C55E` (green-500)
  - warning: `#F59E0B` (amber-500)
  - error: `#EF4444` (red-500)
  - info: `#0EA5E9` (sky-500, same as primary)
- **Dark mode strategy:** Surfaces get darker (not lighter). Accent saturation drops ~10%. Text contrast increases.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable — data-dense where needed (tables, lists), but breathing room around cards and sections.
- **Scale:** 2xs(4) xs(8) sm(12) md(16) lg(24) xl(32) 2xl(48) 3xl(64)

## Layout
- **Approach:** Grid-disciplined — strict column alignment, predictable spacing.
- **Grid:** Sidebar (240px fixed) + Main content (fluid, max 1400px). Content uses 12-column grid within main area.
- **Max content width:** 1400px in main area.
- **Border radius:** Hierarchical scale — sm: 6px (inputs, badges), md: 8px (buttons, cards), lg: 12px (modals, panels), full: 9999px (pills, avatars).

## Motion
- **Approach:** Minimal-functional — motion only when it aids comprehension or provides feedback.
- **Easing:**
  - enter: `cubic-bezier(0, 0, 0.2, 1)` (ease-out)
  - exit: `cubic-bezier(0.4, 0, 1, 1)` (ease-in)
  - move: `cubic-bezier(0.4, 0, 0.2, 1)` (ease-in-out)
- **Duration:**
  - micro: 100ms (hover color changes, border changes)
  - short: 200ms (button press, toggle switches)
  - medium: 300ms (modal open/close, page transitions)
  - long: 400ms (sidebar collapse, card entrance)

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-14 | Initial design system created | Created by design-consultation for Protocol Proxy v2.8.0 UI overhaul. Industrial/utilitarian aesthetic chosen to match infrastructure-tool positioning. Sky/cyan accent represents "connection flow" which is the product's core purpose. |
